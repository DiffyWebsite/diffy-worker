const process = require('process');
const debug = !!process.env.DEBUG;

const fs = require('fs/promises')
const url = require('url')
const crypto = require('crypto')
const sharp = require('sharp')
const logger = require('./logger')

const DEFAULT_AUTH_SUBMIT_DELAY_MS = 6000
const FONT_HOST_DENYLIST = new Set(['fonts.gstatic.com'])
const FONT_FILE_PATTERN = /\.(woff2?|ttf|otf)(?:[?#].*)?$/i
const PANTHEON_HOST_PATTERN = /(^|\.)pantheonsite\.io$/i

const parseHostname = (input) => {
  if (!input || typeof input !== 'string') {
    return ''
  }
  try {
    return new URL(input).hostname.toLowerCase()
  } catch (_) {
    return ''
  }
}

const isFontLikeRequest = (requestUrl, resourceType = '') => {
  if (!requestUrl) {
    return resourceType === 'font'
  }
  const hostname = parseHostname(requestUrl)
  if (hostname && FONT_HOST_DENYLIST.has(hostname)) {
    return true
  }

  if (resourceType === 'font') {
    return true
  }

  try {
    const pathname = new URL(requestUrl).pathname || ''
    return FONT_FILE_PATTERN.test(pathname)
  } catch (_) {
    return FONT_FILE_PATTERN.test(requestUrl)
  }
}

const shouldEnableDeterrenceBypass = (jobUrl) => {
  if (!jobUrl) {
    return false
  }
  const hostname = parseHostname(jobUrl)
  return Boolean(hostname && PANTHEON_HOST_PATTERN.test(hostname))
}

const shouldApplyDeterrenceHeader = (deterrenceState, requestUrl, resourceType = '') => {
  if (!deterrenceState?.enabled || !requestUrl) {
    return false
  }

  if (isFontLikeRequest(requestUrl, resourceType)) {
    return false
  }

  const hostname = parseHostname(requestUrl)
  if (!hostname) {
    return false
  }

  return PANTHEON_HOST_PATTERN.test(hostname)
}

const describeError = (err) => {
  if (!err) {
    return 'unknown error'
  }
  if (Object.hasOwn(err, 'message') && err.message) {
    return err.message
  }
  return String(err)
}

const isTargetClosureError = (err) => {
  if (!err) {
    return false
  }
  const message = describeError(err)
  return /Target closed|Session closed|Page closed|Browser has been closed|Protocol error|Execution context was destroyed/i.test(message)
}

const ensurePageOpen = (page, label = 'operation') => {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    throw new Error(`Target closed before ${label}`)
  }
}

const pickUserAgentFromHeaders = (job) => {
  if (!checkArgs(job, 'headers', true)) {
    return ''
  }

  const userAgentHeader = job.args.headers.filter(item => {
    return (Object.hasOwn(item, 'header') && item.header && item.header.toLowerCase() === 'user-agent')
  })

  if (userAgentHeader && userAgentHeader.length) {
    if (Object.hasOwn(userAgentHeader[0], 'value') && userAgentHeader[0].value.length) {
      return userAgentHeader[0].value
    }
  }

  return ''
}

const checkArgs = (obj, field, checkLength = false) => {
  let result = (Object.hasOwn(obj, 'args') && obj.args && Object.hasOwn(obj.args, field))
  if (checkLength) {
    return (result && obj.args[field].length)
  } else {
    return result
  }
}

const updatePageViewport = async (page, job, maxPageHeight = null) => {
  ensurePageOpen(page, 'updatePageViewport evaluate')

  let scrollHeight
  try {
    scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight)
  } catch (err) {
    if (isTargetClosureError(err)) {
      throw new Error(`Target closed during updatePageViewport evaluate: ${describeError(err)}`)
    }
    throw err
  }

  if (maxPageHeight && scrollHeight > maxPageHeight) {
    scrollHeight = maxPageHeight
  }

  ensurePageOpen(page, 'updatePageViewport resize')
  try {
    await page.setViewportSize({
      width: Number.parseInt(job.breakpoint, 10),
      height: Number.parseInt(scrollHeight, 10)
    })
    // Allow Chromium to finish reflowing before we continue manipulating the page
    await page.waitForTimeout(1000)
  } catch (err) {
    if (isTargetClosureError(err)) {
      throw new Error(`Target closed during updatePageViewport resize: ${describeError(err)}`)
    }
    throw err
  }

  return scrollHeight
}

const random = (low, high) => {
  return crypto.randomInt(low, high + 1);
}

const handleCloudflareChallenge = async (page, { maxAttempts = 3, frameWaitMs = 5000, retryDelayMs = 2000 } = {}) => {
  if (!page) {
    return false
  }

  const challengePresent = async () => {
    return await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]')
      const bodyText = document.body?.innerText || ''
      const marker = bodyText.includes('Please unblock challenges.cloudflare.com')
      const turnstile = document.querySelector('[data-cf-challenge], .cf-turnstile, #challenge-stage')
      return Boolean(iframe || marker || turnstile)
    })
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const detected = await challengePresent().catch(() => false)
    if (!detected) {
      return false
    }

    const frameHandle = await page.$('iframe[src*="challenges.cloudflare.com"]')
    if (frameHandle) {
      const frame = await frameHandle.contentFrame()
      if (frame) {
        const button = await frame.waitForSelector('input[type="button"], button, #cf-stage input[type="submit"]', { timeout: frameWaitMs }).catch(() => null)
        if (button) {
          await button.click().catch(() => {})
          await frame.waitForTimeout(1500)
        }
      }
    }

    await page.waitForTimeout(retryDelayMs)

    if (!(await challengePresent().catch(() => false))) {
      return true
    }

    await page.reload({ waitUntil: 'domcontentloaded', timeout: frameWaitMs * 3 }).catch(() => {})
    await page.waitForTimeout(retryDelayMs)

    if (!(await challengePresent().catch(() => false))) {
      return true
    }
  }

  return false
}

const awaitResponse = async (page, timeout = 60000) => {
  const MAX_WAITING_TIME_ACCESS_URL = 10000
  let responseEventOccurred = false
  const responseHandler = () => (responseEventOccurred = true)

  const responseWatcher = new Promise(function (resolve) {
    setTimeout(() => {
      if (!responseEventOccurred) {
        resolve()
      } else {
        setTimeout(() => resolve(), MAX_WAITING_TIME_ACCESS_URL)
      }
      page.off('response', responseHandler)
    }, 500)
  })

  page.on('response', responseHandler)

  return Promise.race([
    responseWatcher,
    page.waitForNavigation({ timeout })
  ])
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'

const buildHeaderState = (job) => {
  let userAgentString = pickUserAgentFromHeaders(job)

  if (!userAgentString.length) {
    userAgentString = USER_AGENT
  }

  const headers = {}

  if (job?.args?.headers) {
    job.args.headers.forEach(element => {
      if (element.header && element.header.trim().length) {
        headers[element.header] = element.value
      }
    })
  }

  const deterrenceEnabled = shouldEnableDeterrenceBypass(job?.url)
  if (deterrenceEnabled) {
    logger.debug('Deterrence-Bypass enabled for pantheonsite.io requests')
  }

  return {
    userAgentString,
    headers,
    deterrenceBypass: {
      enabled: deterrenceEnabled,
      headerName: 'Deterrence-Bypass',
      headerValue: '1'
    }
  }
}

module.exports = {
  checkArgs: (obj, field, checkLength = false) => {
    return checkArgs(obj, field, checkLength)
  },

  autoScroll: async (page, job) => {
    if (!checkArgs(job, 'scroll_step')) {
      return;
    }

    const step = job.args.scroll_step || 100;
    const postScrollDelay = job.args.scroll_step_delay || 500;

    try {
      await page.waitForSelector('body', { state: 'attached' });
      const scrollHeight = await page.evaluate('document.body.scrollHeight');

      const vp = page.viewportSize()
      const cx = Math.floor((vp?.width || 1200) / 2)
      const cy = Math.floor((vp?.height || 500) / 2)
      await page.mouse.move(cx, cy)

      for (let totalHeight = 0; totalHeight < scrollHeight; totalHeight += step) {
        await page.mouse.wheel(0, step)
        await page.waitForTimeout(100);
      }
    } catch (e) {
      // Context may be destroyed if page navigates during scroll
      logger.error('autoScroll evaluate failed (page may have navigated)', { error: e?.message || String(e) })
    }

    try {
      await page.waitForTimeout(postScrollDelay);
      await page.evaluate(() => {
        window.scrollTo(0, 0)
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0
      });
      await page.mouse.move(0, 0);
      await page.waitForTimeout(500);
    } catch (e) {}

    return Promise.resolve();
  },

  cutElements: async (page, job) => {
    if (!checkArgs(job, 'cut_elements', true)) {
      return Promise.resolve()
    }

    const cssRules = job.args.cut_elements
      .map(selector => selector.trim())
      .filter(selector => selector.length > 0)
      .map(selector => `${selector} { display: none !important; visibility: hidden !important; }`)
      .join('\n')

    if (cssRules) {
      try {
        await page.addStyleTag({ content: cssRules })
      } catch (e) {
        logger.debug('Failed to inject cut_elements CSS rules', { error: e })
      }
    }

    try {
      return await page.evaluate((_elements) => {
        try {
          window.scrollTo(0, 0)
        } catch (e) {}

        for (let selector of _elements) {
          selector = selector.trim();

          if (selector.length) {
            document.querySelectorAll(selector).forEach((element) => {
              element.style.setProperty('display', 'none', 'important');
              element.style.setProperty('visibility', 'hidden', 'important');

              try {
                element.remove();
              } catch (e) {}
            });
          }
        }

        return true
      }, job.args.cut_elements)
    } catch (e) {
      logger.error('cutElements evaluate failed (page may have navigated)', { error: e?.message || String(e) })
      return false
    }
  },

  addJsCode: async (page, job) => {
    if (!checkArgs(job, 'js_code', true)) {
      return Promise.resolve()
    }

    try {
      await page.evaluate(job.args.js_code)
    } catch (e) {
      logger.debug('Failed to evaluate page', { error: e, js_code: job.args.js_code })
    }

    await page.waitForTimeout(2000)
    return page
  },

  addCssCode: async (page, job) => {
    if (!checkArgs(job, 'css_code', true)) {
      return Promise.resolve()
    }

    try {
      await page.addStyleTag({ content: job.args.css_code });
    } catch (e) {
      logger.error('Failed to add style tag', { error: e, css_code: job.args.css_code });
    }

    await page.waitForTimeout(2000)
    return page;
  },

  addFixtures: async (page, job) => {
    if (!checkArgs(job, 'fixtures', true)) {
      return Promise.resolve()
    }

    try {
      await page.evaluate((_fixtures) => {

        const clampPositive = (value, fallback) => {
          const number = Number.parseFloat(value)
          if (Number.isFinite(number) && number > 0) {
            return Math.round(number)
          }
          return fallback
        }

        const buildInlinePlaceholder = (width, height, label = 'Diffy fixture') => {
          const safeWidth = clampPositive(width, 300)
          const safeHeight = clampPositive(height, 200)
          const text = `${safeWidth}x${safeHeight}`
          const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}">` +
            `<defs><style>@font-face{font-family:'Inter';src:local('Arial')}</style></defs>` +
            `<rect width="100%" height="100%" fill="#d8d8d8"/>` +
            `<line x1="0" y1="0" x2="${safeWidth}" y2="${safeHeight}" stroke="#b0b0b0" stroke-width="2"/>` +
            `<line x1="${safeWidth}" y1="0" x2="0" y2="${safeHeight}" stroke="#b0b0b0" stroke-width="2"/>` +
            `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="'Inter',sans-serif" font-size="${Math.max(12, Math.round(Math.min(safeWidth, safeHeight) / 8))}" fill="#6b6b6b">${text}</text>` +
            `<title>${label}</title>` +
            `</svg>`

          return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
        }

        function diffyImageFixture (el, selector) {
          return new Promise((resolve) => {
            try {
              const w = clampPositive(el.width || el.naturalWidth, 300)
              const h = clampPositive(el.height || el.naturalHeight, 200)
              const src = el.src || null

              if (src && w && h) {
                const placeholderSrc = buildInlinePlaceholder(w, h, 'Diffy image fixture')

                try {
                  el.src = placeholderSrc
                } catch (_) {}

                if (el.hasAttribute('data-src')) {
                  el.setAttribute('data-src', placeholderSrc)
                }

                if (el.hasAttribute('srcset')) {
                  el.setAttribute('srcset', `${placeholderSrc} 1x`)
                }

                try {
                  el.setAttribute('data-diffy-fixture', 'image')
                  el.setAttribute('data-diffy-fixture-size', `${w}x${h}`)
                } catch (_) {}

                if (typeof el.decode === 'function') {
                  el.decode().catch(() => {})
                }
                return resolve()
              }
            } catch (e) {}

          return resolve()
        })
      }

      function diffyBackgroundImageFixture (el) {
        return new Promise((resolve) => {
          try {
            const elStyle = el.currentStyle || window.getComputedStyle(el, false);
            const backgroundImage = elStyle.backgroundImage.slice(4, -1).replace(/\"/g, '');

            if (!backgroundImage) {
              // No background image
              return resolve()
            }

            getImageInfo(backgroundImage)
              .then((imageInfo) => {
                if (imageInfo.width && imageInfo.height) {
                    const width = clampPositive(Math.round(imageInfo.width), 300);
                    const height = clampPositive(Math.round(imageInfo.height), 200);
                    const newBackgroundImageSrc = buildInlinePlaceholder(width, height, 'Diffy background fixture');
                    const newBackgroundImage = new Image();
                    newBackgroundImage.addEventListener('load', () => {
                        el.style.backgroundImage = 'url(' + newBackgroundImageSrc + ')';
                        try {
                          el.setAttribute('data-diffy-fixture', 'background-image');
                          el.setAttribute('data-diffy-fixture-size', `${width}x${height}`);
                        } catch (_) {}
                        resolve();
                    });
                    newBackgroundImage.addEventListener('error', () => {
                        resolve();
                    });

                    // @TODO add timeout in case image is not loaded

                    newBackgroundImage.src = newBackgroundImageSrc;
                } else {
                    resolve();
                }
              })
              .catch(() => {
                return resolve()
              })
          } catch (e) {
            // console.error('Failed to diffy image fixture', e) // TODO: Prettify error dump

            return resolve()
          }
        })
      }

      function getImageInfo (url) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject();
          img.src = url;
        });
      }

      function diffyTextFixture (el, content) {
        return new Promise((resolve) => {
          try {
            el.innerHTML = content
          } catch (e) {
            // console.error('Failed to diffy text fixture', e) // TODO: Prettify error dump
          }

          return resolve()
        })
      }

      const fixturePromises = []

      for (let fixture of _fixtures) {
        const selector = (fixture.selector) ? fixture.selector.trim() : ''
        const type = (fixture.type) ? fixture.type.trim() : ''
        const content = (fixture.content) ? fixture.content.trim() : ''

        if (!selector.length) {
          continue;
        }

        const element = document.querySelectorAll(selector)

        if (!element) {
          continue;
        }

        const elementKeys = Object.keys(element)

        for (let i = 0; i < elementKeys.length; ++i) {
          if (type === 'image') {
            fixturePromises.push(diffyImageFixture(element[elementKeys[i]], selector))
          } else if (type === 'background image') {
            fixturePromises.push(diffyBackgroundImageFixture(element[elementKeys[i]]))
          } else {
            fixturePromises.push(diffyTextFixture(element[elementKeys[i]], content))
          }
        }
      }

      if (fixturePromises.length) {
        return Promise.all(fixturePromises)
      } else {
        return Promise.resolve()
      }

    }, job.args.fixtures)
    } catch (e) {
      logger.error('addFixtures evaluate failed (page may have navigated)', { error: e?.message || String(e) })
    }

    logger.debug('Diffy fixtures were added.')

    await new Promise(resolve => setTimeout(resolve, 5000));
    return page
  },

  hideBanners: async (page, job) => {
    if (!checkArgs(job, 'elements', true)) {
      return Promise.resolve()
    }

    try {
      return await page.evaluate((_elements) => {
        const isVisible = (element) => {
          if (!element) {
            return false
          }
          const style = window.getComputedStyle(element)
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            element.offsetWidth > 0 &&
            element.offsetHeight > 0
          )
        }

        const maskElement = (element) => {
          if (!isVisible(element)) {
            return
          }

          const rect = element.getBoundingClientRect()
          if (!rect || rect.width <= 0 || rect.height <= 0) {
            return
          }

          const overlay = document.createElement('div')
          overlay.dataset.diffyMaskOverlay = 'true'
          Object.assign(overlay.style, {
            display: 'block',
            position: 'absolute',
            top: `${rect.top + window.scrollY}px`,
            left: `${rect.left + window.scrollX}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            backgroundColor: '#00aa00',
            zIndex: '9999',
            pointerEvents: 'none'
          })

          document.body.appendChild(overlay)
        }

        window.scrollTo(0, 0)

        const selectors = Array.isArray(_elements) ? _elements : []
        selectors.forEach((selector) => {
          if (typeof selector !== 'string') {
            return
          }
          const trimmed = selector.trim()
          if (!trimmed.length) {
            return
          }

          document.querySelectorAll(trimmed).forEach((element) => {
            maskElement(element)
          })
        })
      }, job.args.elements)
    } catch (e) {
      logger.error('hideBanners evaluate failed (page may have navigated)', { error: e?.message || String(e) })
    }
  },

  updatePageViewport: async (page, job, maxPageHeight = null) => {
    return updatePageViewport(page, job, maxPageHeight)
  },

  delayBeforeScreenshot: async (page, job) => {
    if (checkArgs(job, 'delay_before_screenshot')) {
      await new Promise(resolve => setTimeout(resolve, job.args.delay_before_screenshot * 1000));
      return page
    }

    return Promise.resolve()
  },

  addCookies: async (job) => {
    if (!checkArgs(job, 'cookies')) {
      return []
    }

    let items = job.args.cookies.split(';')
    let cookies = []
    const urlObj = url.parse(job.url, true)

    items.forEach((item) => {
      let els = item.split('=')
      if (els[0] && els[1]) {
        cookies.push({
          name: els[0],
          value: els[1],
          domain: urlObj.host,
          path: '/',
          expires: Math.round(new Date().getTime() / 1000) + (60 * 60),
          httpOnly: false,
          secure: false,
          session: false
        })
      }
    })

    return cookies
  },

  auth: async (page, job) => {
    // @TODO !checkArgs(job, 'username') || !checkArgs(job, 'usernameSelector') - doesn't exist for netlify
    if (!checkArgs(job, 'url') || !checkArgs(job, 'passwordSelector') || !checkArgs(job, 'submitSelector') || !checkArgs(job, 'password')) {
      return Promise.resolve()
    }

    let url = job.args.url

    const context = page.context();
    await context.clearCookies();

    logger.debug(`Navigating to ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
      logger.debug('Login page never reached networkidle; continuing anyway.');
    });

    await awaitResponse(page, 60000)

    await updatePageViewport(page, job)

    if (checkArgs(job, 'before_login_css')) {
      logger.debug("Clicking before login element.");

      try {
        await page.evaluate((job) => {
          document.querySelector(job.args.before_login_css).click()
        }, job)
      } catch (error) {
        logger.warn('Before login css error', { error, before_login_css: job.args.before_login_css })
      }
    }

    if (job.args.usernameSelector) {
      await page.waitForSelector(job.args.usernameSelector)
      logger.debug("Typing username.");
      await page.type(job.args.usernameSelector, job.args.username, { delay: 10 }); // Increased delay
    }

    await page.waitForSelector(job.args.passwordSelector)
    logger.debug("Typing password.");
    await page.type(job.args.passwordSelector, job.args.password, { delay: 10 }); // Increased delay

    await page.waitForTimeout(DEFAULT_AUTH_SUBMIT_DELAY_MS)

    await page.waitForSelector(job.args.submitSelector)
    logger.debug("Clicking submit button.");
    await page.focus(job.args.submitSelector)
    await page.click(job.args.submitSelector);

    try {
      // Wait for navigation to complete when either the DOM is fully loaded
      // or the network becomes idle (excluding persistent connections like WebSockets)
      // Add a 20-second delay to allow any asynchronous operations to complete before retrieving cookies
      await page.waitForLoadState('networkidle', { timeout: 120000 });
      logger.debug("Navigation after login successful.");
    } catch (error) {
      logger.error('Navigation after login failed', { error })
      // Retry logic or handle the failure as needed
      return Promise.resolve();
    }

    logger.debug("Authentication process completed.");

    const cookies = await context.cookies()
    if (cookies && cookies.length) {
      const cookieNames = cookies.map(cookie => cookie?.name).filter(Boolean)
      logger.debug('Captured authentication cookies.', { cookies: cookieNames })
    } else {
      logger.warn('Authentication completed but no cookies were returned.')
    }

    return cookies
  },

  removeFile: async (filepath) => {
    await fs.rm(filepath, { force: true })
  },

  random: (min, max) => {
    return random(min, max)
  },

  handleCloudflareChallenge: async (page, options = {}) => {
    return handleCloudflareChallenge(page, options)
  },

  /**
   * Get tmp dir for screenshots.
   * @returns {string}
   */
  // getTmpDir: () => {
  //   let tmp = (process.env.TMP_PATH && process.env.TMP_PATH.length) ? this._rTrim(process.env.TMP_PATH) : '/tmp'
  //   tmp += '/diffy'
  //   if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true })
  //   return tmp
  // },
  //
  // Can't use emptyDirSync as it is part of fs-extra that requires node 18 at minimum. We run on 16 still.
  // cleanTmpDir: () => {
  //   const tmp = this.getTmpDir()
  //   fs.emptyDirSync(tmp)
  // },

  setHeaders: async (page, job, preparedState = null) => {
    let state = preparedState

    if (!state) {
      state = buildHeaderState(job)

      if (state.userAgentString.length) {
        logger.debug('User-Agent: "' + state.userAgentString + '"')
      }
    }

    if (page && state.headers && Object.keys(state.headers).length) {
      await page.setExtraHTTPHeaders(state.headers)
    }

    return state
  },

  buildHeaderState: (job) => {
    return buildHeaderState(job)
  },

  shouldApplyDeterrenceHeader: (state, requestUrl, resourceType = '') => {
    return shouldApplyDeterrenceHeader(state, requestUrl, resourceType)
  },

  cropElement: async (page, job) => {
    if (!checkArgs(job, 'crop')) {
      return Promise.resolve()
    }

    try {
      return await page.evaluate(async (_selector) => {

        const getPosition = (el) => {
          if (!el) {
            return
          }
          let xPos = 0
          let yPos = 0
          const rect = el.getBoundingClientRect()
          while (el) {
            if (el.tagName === 'BODY') {
              // deal with browser quirks with body/window/document and page scroll
              const xScroll = el.scrollLeft || document.documentElement.scrollLeft
              const yScroll = el.scrollTop || document.documentElement.scrollTop

              xPos += (el.offsetLeft - xScroll + el.clientLeft)
              yPos += (el.offsetTop - yScroll + el.clientTop)
            } else {
              // for all other non-BODY elements
              xPos += (el.offsetLeft - el.scrollLeft + el.clientLeft)
              yPos += (el.offsetTop - el.scrollTop + el.clientTop)
            }

            el = el.offsetParent
          }

          return {
            left: xPos,
            top: yPos,
            width: rect.width,
            height: rect.height,
          }
        }

        window.scrollTo(0, 0)
        return getPosition(document.querySelector(_selector));

      }, job.args.crop)
    } catch (e) {
      logger.error('cropElement evaluate failed (page may have navigated)', { error: e?.message || String(e) })
      return undefined
    }
  },

  getPageHtml: async (page) => {
    try {
      return await page.evaluate(() => {
        return document.documentElement.outerHTML
      })
    } catch (e) {
      logger.error('getPageHtml failed (page may have navigated)', { error: e?.message || String(e) })
      return ''
    }
  },

  getPageMhtml: async (page) => {
    try {
      const cdp = await page.context().newCDPSession(page);
      const { data } = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
      return data;
    } catch (e) {
      logger.error('getPageMhtml failed (page may have navigated)', { error: e?.message || String(e) })
      return ''
    }
  },

  getImageSize: async (file) => {
    try {
        const metadata = await sharp(file).metadata();
        return {
            height: metadata.height,
            width: metadata.width
        };
    } catch (err) {
        logger.error('Failed to get file metadata', { error: err });
        throw new Error(err.message);
    }
  },

  recordViewportRelativeHeights: async (page) => {
    try {
      return await page.evaluate(() => {
        const viewportHeight = window.innerHeight
        const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'LINK', 'BR', 'HR'])
        window.__diffyRecordedHeights = []

        const walk = (node) => {
          for (const child of node.children) {
            if (!child.offsetHeight) continue
            if (SKIP_TAGS.has(child.tagName)) continue
            if (window.getComputedStyle(child).getPropertyValue('opacity') <= 0) continue

            const ratio = child.offsetHeight / viewportHeight
            if (ratio >= 0.30) {
              window.__diffyRecordedHeights.push({
                node: child,
                height: child.offsetHeight,
                ratio: ratio,
              })
            }
            walk(child)
          }
        }
        walk(document.body)
        return window.__diffyRecordedHeights.length
      })
    } catch (err) {
      logger.warn('recordViewportRelativeHeights failed', { error: err?.message || String(err) })
      return 0
    }
  },

  fixViewportRelativeHeights: async (page, cleanup = false) => {
    try {
      return await page.evaluate((shouldCleanup) => {
        if (!window.__diffyRecordedHeights) return 0

        const viewportHeight = window.innerHeight
        const ORIGINAL_VIEWPORT = 1000
        const viewportGrowthRatio = viewportHeight / ORIGINAL_VIEWPORT
        let fixedCount = 0

        for (const entry of window.__diffyRecordedHeights) {
          if (!document.body.contains(entry.node)) continue

          const currentHeight = entry.node.offsetHeight
          if (currentHeight <= entry.height * 1.5) continue

          const growthRatio = currentHeight / entry.height
          if (growthRatio <= viewportGrowthRatio * 0.5) continue

          entry.node.style.height = entry.height + 'px'
          entry.node.style.maxHeight = entry.height + 'px'
          entry.node.style.minHeight = entry.height + 'px'

          if (entry.node.scrollHeight > entry.node.offsetHeight + 5) {
            entry.node.style.height = ''
            entry.node.style.maxHeight = ''
            entry.node.style.minHeight = ''
          } else {
            fixedCount++
          }
        }

        if (shouldCleanup) {
          delete window.__diffyRecordedHeights
        }

        return fixedCount
      }, cleanup)
    } catch (err) {
      logger.warn('fixViewportRelativeHeights failed', { error: err?.message || String(err) })
      return 0
    }
  },

  detectStretchedElements: async (page) => {
    try {
      return await page.evaluate(async () => {
        const RATIO_THRESHOLD = 0.15
        const HEIGHT_MULTIPLIER = 2
        const PRESERVING_OBJECT_FIT = new Set(['cover', 'contain', 'scale-down'])
        const results = { images: [], backgroundImages: [] }
        const viewportWidth = window.innerWidth

        for (const img of document.querySelectorAll('img')) {
          if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) continue
          const rect = img.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue
          if (PRESERVING_OBJECT_FIT.has(window.getComputedStyle(img).objectFit)) continue
          if (rect.height <= img.naturalHeight * HEIGHT_MULTIPLIER) continue
          const naturalRatio = img.naturalWidth / img.naturalHeight
          const renderedRatio = rect.width / rect.height
          const ratioDiff = Math.abs(naturalRatio - renderedRatio) / naturalRatio
          if (ratioDiff > RATIO_THRESHOLD) {
            const src = img.src || ''
            results.images.push({
              src: src.length > 200 ? src.substring(0, 200) + '...' : src,
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
              renderedWidth: Math.round(rect.width),
              renderedHeight: Math.round(rect.height),
              stretchPercentage: Math.round(ratioDiff * 100),
            })
          }
        }

        const pageHeight = document.documentElement.scrollHeight
        const bgCandidates = []
        for (const el of document.querySelectorAll('div,section,article,header,footer,main,aside,nav,video')) {
          const style = window.getComputedStyle(el)
          const bgImage = style.backgroundImage
          if (!bgImage || bgImage === 'none') continue
          const match = bgImage.match(/url\(["']?([^"')]+)["']?\)/)
          if (!match || !match[1]) continue
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue
          // Skip full-page content wrappers: a normal-width element that spans nearly the
          // entire page height is a content container, not an isolated hero section.
          // Parallax/motion-effects layers are excluded from this check because their
          // rect.width far exceeds the viewport width (e.g. 9488px vs 320px viewport).
          if (rect.width <= viewportWidth * 1.5 && rect.height >= pageHeight * 0.8) continue
          // Clip element width to viewport width so parallax layers (intentionally wider
          // than the viewport) are evaluated at their visible width, not their full width.
          const effectiveWidth = Math.min(rect.width, viewportWidth)
          bgCandidates.push({ url: match[1], rect, effectiveWidth, bgSize: style.backgroundSize })
        }

        if (bgCandidates.length > 0) {
          const PRESERVING_BG_SIZE = new Set(['contain', 'auto', 'auto auto'])
          const checkBg = ({ url, rect, effectiveWidth, bgSize }) => new Promise(resolve => {
            if (PRESERVING_BG_SIZE.has(bgSize.trim())) return resolve(null)
            const img = new Image()
            img.onload = () => {
              if (img.naturalWidth === 0 || img.naturalHeight === 0) return resolve(null)
              if (img.naturalHeight < 300) return resolve(null)
              if (rect.height <= img.naturalHeight * HEIGHT_MULTIPLIER) return resolve(null)
              const naturalRatio = img.naturalWidth / img.naturalHeight
              const renderedRatio = effectiveWidth / rect.height
              const ratioDiff = Math.abs(naturalRatio - renderedRatio) / naturalRatio
              if (ratioDiff <= RATIO_THRESHOLD) return resolve(null)
              resolve({
                url: url.length > 200 ? url.substring(0, 200) + '...' : url,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                renderedWidth: Math.round(effectiveWidth),
                renderedHeight: Math.round(rect.height),
                stretchPercentage: Math.round(ratioDiff * 100),
                backgroundSize: bgSize,
              })
            }
            img.onerror = () => resolve(null)
            img.src = url
          })

          const bgResults = await Promise.all(bgCandidates.map(checkBg))
          for (const r of bgResults) {
            if (r) results.backgroundImages.push(r)
          }
        }

        return results
      })
    } catch (err) {
      logger.warn('detectStretchedElements failed', { error: err?.message || String(err) })
      return null
    }
  },
}
