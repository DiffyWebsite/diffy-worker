const process = require('process');
const debug = !!process.env.DEBUG;

const fs = require('fs/promises')
const url = require('url')
const crypto = require('crypto')
const sharp = require('sharp')
const logger = require('./logger')

const checkArgs = (obj, field, checkLength = false) => {
  let result = (Object.hasOwn(obj, 'args') && obj.args && Object.hasOwn(obj.args, field))
  if (checkLength) {
    return (result && obj.args[field].length)
  } else {
    return result
  }
}

const updatePageViewport = async (page, job, maxPageHeight = null) => {
  let scrollHeight = await page.evaluate(`(async () => {
        return document.documentElement.scrollHeight;
    })()`)

  if (maxPageHeight && scrollHeight > maxPageHeight) {
    scrollHeight = maxPageHeight
  }

  await page.setViewport({ width: Number.parseInt(job.breakpoint), height: Number.parseInt(scrollHeight) })
  await new Promise(resolve => setTimeout(resolve, 1000));
  return scrollHeight
}

const random = (low, high) => {
  return crypto.randomInt(low, high + 1);
}

const awaitResponse = async (page) => {
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
    page.waitForNavigation({ timeout: 60000 })
  ])
}

module.exports = {
  checkArgs: (obj, field, checkLength = false) => {
    return checkArgs(obj, field, checkLength)
  },

  autoScroll: async (page, job) => {
    if (!checkArgs(job, 'scroll_step')) {
      return;
    }

    let scrollHeight = 0;
    let totalHeight = 0;

    do {
      // Need to wait if page is reloaded (see: https://github.com/ygerasimov/diffy-pm/issues/122)
      await page.waitForSelector('body')
      scrollHeight = await page.evaluate('document.body.scrollHeight');

      await page.waitForSelector('body')
      await page.evaluate('window.scrollBy(0, 100)');
      totalHeight += 100;

      await new Promise(resolve => setTimeout(resolve, 100));
    } while (totalHeight < scrollHeight)

    try {
      await page.evaluate('window.scrollTo(0, 0)')
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {}

    return Promise.resolve();
  },

  cutElements: async (page, job) => {
    if (!checkArgs(job, 'cut_elements', true)) {
      return Promise.resolve()
    }

    return page.evaluate((_elements) => {
      try {
        window.scrollTo(0, 0)
      } catch (e) {}

      for (let selector of _elements) {
        selector = selector.trim();

        if (selector.length) {
          document.querySelectorAll(selector)
            .forEach((element) => {
              element.remove();
            });
        }
      }

      return true
    }, job.args.cut_elements)
  },

  addJsCode: async (page, job) => {
    if (!checkArgs(job, 'js_code', true)) {
      return Promise.resolve()
    }

    try {
      await page.evaluate(job.args.js_code)
    } catch (e) {
      logger.warn('Failed to evaluate page', { error: e, js_code: job.args.js_code })
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
    return page
  },

  addCssCode: async (page, job) => {
    if (!checkArgs(job, 'css_code', true)) {
      return Promise.resolve()
    }

    try {
      await page.addStyleTag({ content: job.args.css_code })
    } catch (e) {
      logger.error('Failed to add style tag', { error: e, css_code: job.args.css_code })
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
    return page
  },

  addFixtures: async (page, job) => {
    if (!checkArgs(job, 'fixtures', true)) {
      return Promise.resolve()
    }

    await page.evaluate((_fixtures) => {

      function diffyImageFixture (el, selector) {
        return new Promise((resolve, reject) => {
          try {
            const w = el.width || null
            const h = el.height || null
            const src = el.src || null

            if (src && w && h) {
              el.addEventListener('load', () => {
                resolve();
              });
              el.addEventListener('error', (e) => {
                // console.error('Failed to diffy image fixture', e) // TODO: Prettify error dump
                reject(e);
              });

              // @TODO add timeout in case image is not loaded

              /**
               * @TODO check if we want to depend on picsum.photos service
               * idea: copy images for all resolutions to s3 and expose via cloudfront (fast and stable)
               */

              el.src = `https://picsum.photos/id/0/${w}/${h}`

              if (el.hasAttribute('data-src')) {
                el.setAttribute('data-src', el.src)
              }

              if (el.hasAttribute('srcset')) {
                el.setAttribute('srcset', el.src + ' 1x')
              }
            } else {
              // console.error('Can\'t add diffy image fixture', selector, src, h, w) // TODO: Prettify error dump
              return resolve()
            }
          } catch (e) {
            // console.error('Failed to diffy image fixture', e) // TODO: Prettify error dump
            return resolve()
          }
        })
      }

      function diffyBackgroundImageFixture (el) {
        return new Promise((resolve) => {
          try {
            const elStyle = el.currentStyle || window.getComputedStyle(el, false);
            const backgroundImage = elStyle.backgroundImage.slice(4, -1).replace(/"/g, '');

            if (!backgroundImage) {
              // No background image
              return resolve()
            }

            getImageInfo(backgroundImage)
              .then((imageInfo) => {
                if (imageInfo.width && imageInfo.height) {
                    const newBackgroundImageSrc = `https://picsum.photos/id/0/${Math.round(imageInfo.width)}/${Math.round(imageInfo.height)}`;
                    const newBackgroundImage = new Image();
                    newBackgroundImage.addEventListener('load', () => {
                        el.style.backgroundImage = 'url(' + newBackgroundImageSrc + ')';

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

    logger.debug('Diffy fixtures were added.')

    await new Promise(resolve => setTimeout(resolve, 5000));
    return page
  },

  hideBanners: async (page, job) => {
    if (!checkArgs(job, 'elements', true)) {
      return Promise.resolve()
    }

    return page.evaluate((_elements) => {
      document.body.style.position = 'relative';

      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            element.offsetWidth > 0 &&
            element.offsetHeight > 0
        );
      };

      const vrtPaintOver = (element) => {
        if (!isVisible(element)) {
          return;
        }

        const rect = element.getBoundingClientRect();

        const div = document.createElement('div');
        Object.assign(div.style, {
          display: 'block',
          position: 'absolute',
          top: `${rect.top + window.scrollY}px`,
          left: `${rect.left + window.scrollX}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          backgroundColor: 'green',
          zIndex: '9999',
          pointerEvents: 'none'
        });

        document.body.appendChild(div);
      };

      window.scrollTo(0, 0)

      _elements.forEach((selector) => {
        selector = selector.trim();
        if (!selector.length) return;

        document.querySelectorAll(selector).forEach((element) => {
          vrtPaintOver(element);
        });
      });
    }, job.args.elements);
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

    // Clear cookies for url.
    let cookies = await page.cookies(url)
    await page.deleteCookie(...cookies)

    logger.debug(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: ['domcontentloaded', 'networkidle2'] })
    await awaitResponse(page)

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

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (job.args.usernameSelector) {
      await page.waitForSelector(job.args.usernameSelector)
      logger.debug("Typing username.");
      await page.type(job.args.usernameSelector, job.args.username, { delay: 10 }); // Increased delay
    }

    await page.waitForSelector(job.args.passwordSelector)
    logger.debug("Typing password.");
    await page.type(job.args.passwordSelector, job.args.password, { delay: 10 }); // Increased delay

    await page.waitForSelector(job.args.submitSelector)
    logger.debug("Clicking submit button.");
    await page.focus(job.args.submitSelector)
    await page.click(job.args.submitSelector);

    try {
      // Wait for navigation to complete when either the DOM is fully loaded
      // or the network becomes idle (excluding persistent connections like WebSockets)
      // Add a 20-second delay to allow any asynchronous operations to complete before retrieving cookies
      await page.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle2'], timeout: 120000 });
      await new Promise(resolve => setTimeout(resolve, 20000));
      logger.debug("Navigation after login successful.");
    } catch (error) {
      logger.error('Navigation after login failed', { error })
      // Retry logic or handle the failure as needed
      return Promise.resolve();
    }

    logger.debug("Authentication process completed.");

    return page.cookies()
  },

  removeFile: async (filepath) => {
    await fs.rm(filepath, { force: true })
  },

  random: (min, max) => {
    return random(min, max)
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

  setHeaders: async (page, job) => {
    let userAgentString = ''

    let headers = {}
    if (checkArgs(job, 'headers', true)) {
      let userAgent = job.args.headers.filter(item => {
        return (Object.hasOwn(item, 'header') && item.header && item.header.toLowerCase() === 'user-agent')
      })

      if (userAgent && userAgent.length) {
        if (Object.hasOwn(userAgent[0], 'value') && userAgent[0].value.length) {
          userAgentString = userAgent[0].value
        }
      }
    }

    if (userAgentString.length === 0) {
      const userAgentsPool = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.2420.81',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 OPR/109.0.0.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 OPR/109.0.0.0',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux i686; rv:124.0) Gecko/20100101 Firefox/124.0'
      ];

      userAgentString = userAgentsPool[Math.floor(Math.random() * userAgentsPool.length)];
    }

    if (userAgentString.length) {
      logger.debug('User-Agent: "' + userAgentString + '"');
      await page.setUserAgent(userAgentString)
    }

    if (!checkArgs(job, 'headers', true)) {
      return
    }

    job.args.headers.forEach(element => {
      if (element.header.trim().length) {
        headers[element.header] = element.value
      }
    })

    if (Object.keys(headers).length) {
      await page.setExtraHTTPHeaders(headers)
    }
  },

  cropElement: async (page, job) => {
    if (!checkArgs(job, 'crop')) {
      return Promise.resolve()
    }

    return page.evaluate(async (_selector) => {

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

  },

  getPageHtml: async (page) => {
    return page.evaluate(() => {
      return document.documentElement.outerHTML
    })
  },

  getPageMhtml: async (page) => {
    const cdp = await page.target().createCDPSession();
    const { data } = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
    return data;
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
  }
}
