const process = require('process');
const debug = !!process.env.DEBUG;

const fs = require('fs/promises')
const url = require('url')
const crypto = require('crypto')
const sharp = require('sharp')
const logger = require('./logger')

const DEFAULT_ACCEPT_HEADER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9'
const DEFAULT_CLIENT_HINT_PLATFORM = '"Windows"'
const DEFAULT_LANGUAGES = ['en-US', 'en']

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
  return /Target closed|Session closed|Page closed|Browser has been closed|Protocol error/i.test(message)
}

const ensurePageOpen = (page, label = 'operation') => {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    throw new Error(`Target closed before ${label}`)
  }
}

const PRIMARY_BROWSER_PROFILE = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36',
  locale: 'en-US',
  languages: ['en-US', 'en'],
  timezoneId: 'America/New_York',
  platform: 'Windows',
  hardwareConcurrency: 12,
  deviceMemory: 8,
  devicePixelRatio: 1.25,
  brands: [
    { brand: 'Not_A Brand', version: '8' },
    { brand: 'Chromium', version: '131' },
    { brand: 'Google Chrome', version: '131' }
  ],
  platformVersion: '15.0.0',
  architecture: 'x86',
  bitness: '64',
  maxTouchPoints: 1,
  webglVendor: 'Google Inc. (NVIDIA)',
  webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Ti Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)'
}

const buildAcceptLanguageHeader = (languages = DEFAULT_LANGUAGES) => {
  if (!languages?.length) {
    return DEFAULT_ACCEPT_LANGUAGE
  }

  return languages
    .map((lang, index) => {
      if (index === 0) return lang
      const quality = Math.max(0.1, 1 - index * 0.1).toFixed(1)
      return `${lang};q=${quality}`
    })
    .join(', ')
}

const parseChromeVersions = (userAgent) => {
  if (!userAgent || typeof userAgent !== 'string') {
    return { major: null, full: null }
  }

  const fullMatch = userAgent.match(/Chrome\/([\d.]+)/)
  const majorMatch = userAgent.match(/Chrome\/(\d+)/)

  return {
    major: majorMatch ? majorMatch[1] : null,
    full: fullMatch ? fullMatch[1] : null,
  }
}

const buildClientHintHeaders = (metadata) => {
  const brands = metadata.brands?.length ? metadata.brands : [
    { brand: 'Not_A Brand', version: '8' },
    { brand: 'Chromium', version: '120' },
    { brand: 'Google Chrome', version: '120' },
  ]

  const formatBrands = (collection) => collection
    .map(({ brand, version }) => `"${brand}";v="${version}"`)
    .join(', ')

  return {
    'Sec-CH-UA': formatBrands(brands),
    'Sec-CH-UA-Full-Version-List': formatBrands(brands),
    'Sec-CH-UA-Mobile': metadata.mobile ? '?1' : '?0',
    'Sec-CH-UA-Platform': `"${metadata.platform || DEFAULT_CLIENT_HINT_PLATFORM.replace(/"/g, '')}"`,
    'Sec-CH-UA-Platform-Version': metadata.platformVersion ? `"${metadata.platformVersion}"` : undefined,
    'Sec-CH-UA-Arch': metadata.architecture ? `"${metadata.architecture}"` : undefined,
    'Sec-CH-UA-Bitness': metadata.bitness ? `"${metadata.bitness}"` : undefined,
  }
}

const buildClientHintMetadata = (userAgent, profile = null) => {
  const { major, full } = parseChromeVersions(userAgent)
  const version = major || profile?.brands?.[1]?.version || '120'
  const fullVersion = full || `${version}.0.0.0`

  return {
    brands: profile?.brands?.length ? profile.brands : [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version },
      { brand: 'Google Chrome', version },
    ],
    platform: profile?.platform || DEFAULT_CLIENT_HINT_PLATFORM.replace(/"/g, ''),
    platformVersion: profile?.platformVersion || '15.0.0',
    mobile: Boolean(profile?.mobile ?? false),
    uaFullVersion: fullVersion,
    hardwareConcurrency: profile?.hardwareConcurrency || 8,
    deviceMemory: profile?.deviceMemory || 8,
    languages: profile?.languages || DEFAULT_LANGUAGES,
    architecture: profile?.architecture || 'x86',
    bitness: profile?.bitness || '64',
    maxTouchPoints: profile?.maxTouchPoints ?? (profile?.mobile ? 5 : 1),
    devicePixelRatio: profile?.devicePixelRatio || 1,
    locale: profile?.locale || DEFAULT_LANGUAGES[0],
    timezoneId: profile?.timezoneId || 'UTC',
    webglVendor: profile?.webglVendor,
    webglRenderer: profile?.webglRenderer,
  }
}

const ensureHeader = (headers, name, value) => {
  if (!headers) {
    return
  }

  const existing = Object.keys(headers).find((headerName) => headerName.toLowerCase() === name.toLowerCase())

  if (!existing || headers[existing] === undefined || headers[existing] === null || headers[existing] === '') {
    headers[name] = value
  }
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



const buildHeaderConfig = (job) => {
  const headers = {}
  let profile = null
  let userAgentString = ''

  if (checkArgs(job, 'headers', true)) {
    const userAgentHeader = job.args.headers.find(item => {
      return (Object.hasOwn(item, 'header') && item.header && item.header.toLowerCase() === 'user-agent')
    })

    if (userAgentHeader && Object.hasOwn(userAgentHeader, 'value') && userAgentHeader.value.length) {
      userAgentString = userAgentHeader.value
    }
  }

  if (!userAgentString.length) {
    // Use a single, consistent profile for stable VRT runs.
    profile = PRIMARY_BROWSER_PROFILE
    userAgentString = profile.userAgent
  } else {
    profile = {
      locale: DEFAULT_LANGUAGES[0],
      languages: DEFAULT_LANGUAGES,
      timezoneId: 'UTC',
      platform: DEFAULT_CLIENT_HINT_PLATFORM.replace(/"/g, ''),
      hardwareConcurrency: 8,
      deviceMemory: 8,
      brands: null,
      architecture: 'x86',
      bitness: '64',
      devicePixelRatio: 1,
      maxTouchPoints: 1,
    }
  }

  if (userAgentString.length) {
    logger.debug('User-Agent: "' + userAgentString + '"')
  }

  if (job.args.headers) {
    job.args.headers.forEach(element => {
      if (element.header && element.header.trim().length) {
        headers[element.header] = element.value
      }
    })
  }

  ensureHeader(headers, 'Accept', DEFAULT_ACCEPT_HEADER)
  ensureHeader(headers, 'Accept-Language', buildAcceptLanguageHeader(['en-US','en']))
  ensureHeader(headers, 'Upgrade-Insecure-Requests', '1')

  // Build consistent Client Hints: fixed platform/versions derived from locked profile
  const clientHints = buildClientHintMetadata(userAgentString, {
    ...profile,
    locale: 'en-US',
    languages: ['en-US','en'],
    timezoneId: 'UTC',
  })
  const clientHintHeaders = buildClientHintHeaders(clientHints)
  Object.entries(clientHintHeaders)
    .filter(([, value]) => value !== undefined)
    .forEach(([name, value]) => ensureHeader(headers, name, value))

  if (job.url && job.url.includes('pantheonsite.io')) {
    headers['Deterrence-Bypass'] = '1'
    logger.debug('Deterrence-Bypass set')
  }

  return {
    userAgent: userAgentString,
    extraHeaders: headers,
    clientHints,
    locale: 'en-US',
    languages: ['en-US','en'],
    timezoneId: 'UTC',
  }
}

const applyHeadersToContext = async (context, headerConfig) => {
  if (headerConfig?.extraHeaders && Object.keys(headerConfig.extraHeaders).length) {
    await context.setExtraHTTPHeaders(headerConfig.extraHeaders)
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

    let scrollHeight = 0;
    let totalHeight = 0;
    const maxIterations = 250;
    const startTime = Date.now();
    const maxDurationMs = 45 * 1000;

    let iteration;
    for (iteration = 0; iteration < maxIterations; iteration++) {
      await page.waitForSelector('body');
      scrollHeight = await page.evaluate('document.body.scrollHeight');
      await page.evaluate('window.scrollBy(0, 100)');
      totalHeight += 100;

      if (totalHeight >= scrollHeight) {
        break;
      }

      if ((Date.now() - startTime) > maxDurationMs) {
        logger.warn('autoScroll aborted: reached duration cap', {
          iterations: iteration + 1,
          elapsedMs: Date.now() - startTime,
          scrollHeight,
        });
        break;
      }
    }

    if (totalHeight < scrollHeight) {
      logger.warn('autoScroll exited before reaching bottom', {
        iterations: iteration,
        totalHeight,
        scrollHeight,
      });
    }

    try {
      await page.evaluate('window.scrollTo(0, 0)');
      // also no timeout here
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

    return page;
  },

  addFixtures: async (page, job) => {
    if (!checkArgs(job, 'fixtures', true)) {
      return Promise.resolve()
    }

    const parseDelayCollection = (value) => {
      if (Array.isArray(value)) {
        return value
      }
      if (typeof value === 'string') {
        return value.split(/[\s,]+/)
      }
      return []
    }

    const defaultDelays = [250, 750, 1500]
    const parsedDelays = parseDelayCollection(job.args.fixture_reapply_delays_ms)
    const delayNumbers = parsedDelays
      .map((delay) => Number.parseInt(delay, 10))
      .filter((delay) => Number.isFinite(delay) && delay > 0)
    const reapplyDelays = delayNumbers.length ? delayNumbers : defaultDelays

    let persistWindowMs = reapplyDelays.length ? Math.max(...reapplyDelays) : 0
    const persistOverride = Number.parseInt(
      job.args.fixture_persist_ms ?? job.args.fixture_persist_window_ms,
      10,
    )
    if (Number.isFinite(persistOverride) && persistOverride > 0) {
      persistWindowMs = persistOverride
    }

    const summary = await page.evaluate(async ({ fixtures, reapplyDelays, persistWindowMs }) => {
      const clampPositive = (value, fallback) => {
        const number = Number.parseFloat(value)
        if (Number.isFinite(number) && number > 0) {
          return Math.round(number)
        }
        return fallback
      }

      const deriveBoxDimensions = (node, fallbackWidth = 300, fallbackHeight = 200) => {
        if (!node) {
          return { width: fallbackWidth, height: fallbackHeight }
        }

        const style = window.getComputedStyle(node)
        const rect = typeof node.getBoundingClientRect === 'function'
          ? node.getBoundingClientRect()
          : { width: 0, height: 0 }

        const candidatesWidth = [
          node.naturalWidth,
          node.width,
          node.clientWidth,
          clampPositive(node.getAttribute?.('width'), 0),
          clampPositive(style?.width, 0),
          clampPositive(rect?.width, 0),
        ].filter(value => Number.isFinite(value) && value > 0)

        const candidatesHeight = [
          node.naturalHeight,
          node.height,
          node.clientHeight,
          clampPositive(node.getAttribute?.('height'), 0),
          clampPositive(style?.height, 0),
          clampPositive(rect?.height, 0),
        ].filter(value => Number.isFinite(value) && value > 0)

        const width = candidatesWidth.length ? Math.max(...candidatesWidth) : fallbackWidth
        const height = candidatesHeight.length ? Math.max(...candidatesHeight) : fallbackHeight

        return {
          width: clampPositive(width, fallbackWidth),
          height: clampPositive(height, fallbackHeight),
        }
      }

      const buildInlinePlaceholder = (width, height, label = 'Diffy fixture') => {
        const safeWidth = clampPositive(width, 300)
        const safeHeight = clampPositive(height, 200)
        const text = `${safeWidth}×${safeHeight}`
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

      if (!Array.isArray(fixtures) || !fixtures.length) {
        return {
          attempts: 0,
          applied: 0,
          persistWindowMs,
          watchersActive: false,
          fixtureCount: 0,
        }
      }

      const ensureManager = () => {
        const existing = window.__diffyFixtureManager
        if (existing && typeof existing.destroy === 'function') {
          existing.destroy()
        }

        const getDescriptor = (node, prop) => {
          let current = node
          while (current) {
            const descriptor = Object.getOwnPropertyDescriptor(current, prop)
            if (descriptor) {
              return descriptor
            }
            current = Object.getPrototypeOf(current)
          }
          return null
        }

        const manager = {
          fixtures: [],
          reapplyFixtures: [],
          observers: [],
          timers: [],
          lockedMap: new Map(),
          applyingDepth: 0,
          isApplying () {
            return this.applyingDepth > 0
          },
          incrementApplying () {
            this.applyingDepth += 1
          },
          decrementApplying () {
            if (this.applyingDepth > 0) {
              this.applyingDepth -= 1
            }
          },
          registerFixture (rawFixture) {
            const selector = typeof rawFixture?.selector === 'string'
              ? rawFixture.selector.trim()
              : ''
            if (!selector) {
              return
            }

            const rawType = typeof rawFixture?.type === 'string'
              ? rawFixture.type.trim().toLowerCase()
              : ''
            const type = rawType === 'image'
              ? 'image'
              : (rawType === 'background image' || rawType === 'background-image')
                ? 'background'
                : 'text'

            const entry = {
              selector,
              type,
              apply: null,
              reapply: type === 'text',
            }

            if (entry.type === 'text') {
              const rawContent = rawFixture?.content
              const contentString = typeof rawContent === 'string'
                ? rawContent
                : (rawContent ?? '').toString()
              entry.content = contentString
              entry.hashValue = `${contentString.length}`
              entry.locked = new WeakMap()

              const lockNode = (node) => {
                if (!node) {
                  return null
                }
                let setterMap = entry.locked.get(node)
                if (setterMap) {
                  return setterMap
                }

                setterMap = {}
                const lockedProps = manager.lockedMap.get(node) || new Set()

                const props = ['innerHTML', 'textContent', 'innerText']
                for (const prop of props) {
                  const descriptor = getDescriptor(node, prop)
                  if (!descriptor || typeof descriptor.set !== 'function') {
                    continue
                  }

                  const originalSetter = descriptor.set.bind(node)
                  const originalGetter = descriptor.get ? descriptor.get.bind(node) : null

                  setterMap[prop] = originalSetter

                  const lockedDescriptor = {
                    configurable: true,
                    enumerable: descriptor.enumerable,
                    get () {
                      if (originalGetter) {
                        try {
                          return originalGetter()
                        } catch (_) {
                          return contentString
                        }
                      }
                      return contentString
                    },
                    set () {
                      try {
                        originalSetter(contentString)
                      } catch (_) {}
                      try {
                        node.setAttribute('data-diffy-fixture', 'text')
                        node.setAttribute('data-diffy-fixture-hash', entry.hashValue)
                      } catch (_) {}
                    },
                  }

                  try {
                    Object.defineProperty(node, prop, lockedDescriptor)
                    lockedProps.add(prop)
                  } catch (_) {}
                }

                if (lockedProps.size) {
                  manager.lockedMap.set(node, lockedProps)
                  entry.locked.set(node, setterMap)
                }

                return setterMap
              }

              entry.apply = (node) => {
                if (!node) {
                  return false
                }

                const setterMap = lockNode(node) || {}
                const expected = entry.content
                let changed = false

                if (node.innerHTML !== expected) {
                  manager.incrementApplying()
                  try {
                    if (typeof setterMap.innerHTML === 'function') {
                      setterMap.innerHTML(expected)
                    } else {
                      node.innerHTML = expected
                    }
                    changed = true
                  } catch (_) {
                    changed = false
                  } finally {
                    manager.decrementApplying()
                  }
                }

                try {
                  node.setAttribute('data-diffy-fixture', 'text')
                  node.setAttribute('data-diffy-fixture-hash', entry.hashValue)
                } catch (_) {}

                return changed
              }

              this.reapplyFixtures.push(entry)
            } else if (entry.type === 'image') {
              entry.apply = (node) => new Promise((resolve) => {
                try {
                  const { width, height } = deriveBoxDimensions(node)
                  const placeholderSrc = buildInlinePlaceholder(width, height, 'Diffy image fixture')
                  const currentSrc = node?.src || ''

                  if (currentSrc === placeholderSrc) {
                    resolve(false)
                    return
                  }

                  node.src = placeholderSrc

                  if (node.hasAttribute('data-src')) {
                    node.setAttribute('data-src', placeholderSrc)
                  }

                  if (node.hasAttribute('srcset')) {
                    node.setAttribute('srcset', `${placeholderSrc} 1x`)
                  }

                  try {
                    node.setAttribute('data-diffy-fixture', 'image')
                    node.setAttribute('data-diffy-fixture-size', `${width}x${height}`)
                  } catch (_) {}

                  if (typeof node.decode === 'function') {
                    node.decode().catch(() => {})
                  }

                  resolve(true)
                } catch (_) {
                  resolve(false)
                }
              })
            } else {
              entry.apply = (node) => new Promise((resolve) => {
                try {
                  const { width, height } = deriveBoxDimensions(node)
                  const placeholderSrc = buildInlinePlaceholder(width, height, 'Diffy background fixture')
                  const currentBackground = node.style.backgroundImage || ''

                  if (currentBackground.includes(placeholderSrc)) {
                    resolve(false)
                    return
                  }

                  node.style.backgroundImage = `url(${placeholderSrc})`
                  try {
                    node.setAttribute('data-diffy-fixture', 'background-image')
                    node.setAttribute('data-diffy-fixture-size', `${width}x${height}`)
                  } catch (_) {}

                  resolve(true)
                } catch (_) {
                  resolve(false)
                }
              })
            }

            this.fixtures.push(entry)
          },
          applyFixture (entry, { recordMetrics = true } = {}) {
            const nodes = Array.from(document.querySelectorAll(entry.selector))
            if (!nodes.length) {
              return Promise.resolve({ attempts: 0, applied: 0 })
            }

            const tasks = nodes.map((node) => {
              try {
                const outcome = entry.apply(node)
                return outcome && typeof outcome.then === 'function'
                  ? outcome.then(Boolean)
                  : Promise.resolve(Boolean(outcome))
              } catch (_) {
                return Promise.resolve(false)
              }
            })

            return Promise.allSettled(tasks).then((results) => {
              if (!recordMetrics) {
                return { attempts: 0, applied: 0 }
              }

              let applied = 0
              results.forEach((result) => {
                if (result.status === 'fulfilled' && result.value) {
                  applied += 1
                }
              })

              return {
                attempts: nodes.length,
                applied,
              }
            })
          },
          applyAll ({ recordMetrics = true, reapplyOnly = false } = {}) {
            const targets = reapplyOnly ? this.reapplyFixtures : this.fixtures
            if (!targets.length) {
              return Promise.resolve({ attempts: 0, applied: 0 })
            }

            const applies = targets.map((entry) => this.applyFixture(entry, { recordMetrics }))

            return Promise.all(applies).then((results) => {
              if (!recordMetrics) {
                return { attempts: 0, applied: 0 }
              }

              return results.reduce((acc, result) => {
                acc.attempts += result.attempts || 0
                acc.applied += result.applied || 0
                return acc
              }, { attempts: 0, applied: 0 })
            })
          },
          scheduleReapply () {
            if (!this.reapplyFixtures.length || this.scheduled) {
              return
            }
            this.scheduled = true
            Promise.resolve().then(() => {
              this.scheduled = false
              this.applyAll({ recordMetrics: false, reapplyOnly: true }).catch(() => {})
            })
          },
          activateObservers () {
            if (!this.reapplyFixtures.length || typeof MutationObserver !== 'function') {
              return
            }
            const target = document.documentElement || document.body
            if (!target) {
              return
            }
            const observer = new MutationObserver(() => {
              if (this.isApplying()) {
                return
              }
              this.scheduleReapply()
            })
            observer.observe(target, { childList: true, characterData: true, subtree: true })
            this.observers.push(observer)
          },
          destroy () {
            this.observers.forEach((observer) => {
              try {
                observer.disconnect()
              } catch (_) {}
            })
            this.observers = []

            this.timers.forEach((handle) => {
              clearTimeout(handle)
            })
            this.timers = []

            this.lockedMap.forEach((props, node) => {
              props.forEach((prop) => {
                try {
                  delete node[prop]
                } catch (_) {}
              })
              try {
                if (node.dataset) {
                  delete node.dataset.diffyFixture
                  delete node.dataset.diffyFixtureHash
                }
              } catch (_) {}
            })
            this.lockedMap.clear()

            this.fixtures = []
            this.reapplyFixtures = []
            this.applyingDepth = 0
          },
        }

        window.__diffyFixtureManager = manager
        return manager
      }

      const manager = ensureManager()
      const normalizedFixtures = fixtures.filter((fixture) => fixture && typeof fixture.selector === 'string')

      normalizedFixtures.forEach((fixture) => manager.registerFixture(fixture))

      const metrics = await manager.applyAll({ recordMetrics: true })

      if (manager.reapplyFixtures.length) {
        manager.activateObservers()
      }

      if (Array.isArray(reapplyDelays) && reapplyDelays.length) {
        reapplyDelays.forEach((delay) => {
          const handle = setTimeout(() => {
            manager.applyAll({ recordMetrics: false, reapplyOnly: true }).catch(() => {})
          }, delay)
          manager.timers.push(handle)
        })
      }

      return {
        attempts: metrics.attempts,
        applied: metrics.applied,
        persistWindowMs,
        watchersActive: manager.reapplyFixtures.length > 0 && typeof MutationObserver === 'function',
        fixtureCount: normalizedFixtures.length,
      }
    }, {
      fixtures: job.args.fixtures,
      reapplyDelays,
      persistWindowMs,
    })

    logger.debug('Diffy fixtures were added.', summary)

    return page
  },

  hideBanners: async (page, job) => {
    if (!checkArgs(job, 'elements', true)) {
      return Promise.resolve()
    }

    return page.evaluate((_elements) => {
      const ensureMaskManager = () => {
        if (window.__diffyMaskManager) {
          return window.__diffyMaskManager
        }

        const overlays = new Map()
        let scheduled = false

        const clampPositive = (value, fallback) => {
          const number = Number.parseFloat(value)
          if (Number.isFinite(number) && number > 0) {
            return number
          }
          return fallback
        }

        const clamp = (value, min, max) => {
          if (!Number.isFinite(value)) {
            return value
          }

          if (Number.isFinite(min) && value < min) {
            return min
          }

          if (Number.isFinite(max) && value > max) {
            return max
          }

          return value
        }

        const syncOverlay = (entry) => {
          if (!entry?.element || !entry.overlay || !entry.element.isConnected) {
            if (entry?.resizeObserver) {
              try {
                entry.resizeObserver.disconnect()
              } catch (_) {}
            }
            if (entry?.overlay?.isConnected) {
              entry.overlay.remove()
            }
            overlays.delete(entry?.element)
            return
          }

          const element = entry.element
          const overlay = entry.overlay
          const rect = element.getBoundingClientRect()
          const computed = window.getComputedStyle(element)

          const widthCandidates = [
            rect.width,
            element.offsetWidth,
            element.scrollWidth,
            clampPositive(computed?.width, 0),
          ].filter((candidate) => Number.isFinite(candidate) && candidate > 0)

          const heightCandidates = [
            rect.height,
            element.offsetHeight,
            element.scrollHeight,
            clampPositive(computed?.height, 0),
          ].filter((candidate) => Number.isFinite(candidate) && candidate > 0)

          const width = widthCandidates.length ? Math.max(...widthCandidates) : 0
          const height = heightCandidates.length ? Math.max(...heightCandidates) : 0

          if (!width || !height) {
            overlay.style.display = 'none'
            return
          }

          const extra = 2
          const position = computed?.position || 'static'
          const isFixed = position === 'fixed'
          const scrollX = window.scrollX || window.pageXOffset || document.documentElement?.scrollLeft || 0
          const scrollY = window.scrollY || window.pageYOffset || document.documentElement?.scrollTop || 0
          const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0
          const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0
          const hasViewportBounds = Number.isFinite(viewportWidth) && viewportWidth > 0 && Number.isFinite(viewportHeight) && viewportHeight > 0

          const baseTop = isFixed ? rect.top : rect.top + scrollY
          const baseLeft = isFixed ? rect.left : rect.left + scrollX
          const baseBottom = baseTop + height
          const baseRight = baseLeft + width

          let targetTop = baseTop - extra
          let targetLeft = baseLeft - extra
          let targetBottom = baseBottom + extra
          let targetRight = baseRight + extra

          if (hasViewportBounds) {
            const minLeft = isFixed ? 0 : scrollX
            const maxRight = (isFixed ? 0 : scrollX) + viewportWidth
            const minTop = isFixed ? 0 : scrollY
            const maxBottom = (isFixed ? 0 : scrollY) + viewportHeight

            targetLeft = clamp(targetLeft, minLeft, maxRight)
            targetRight = clamp(targetRight, minLeft, maxRight)
            targetTop = clamp(targetTop, minTop, maxBottom)
            targetBottom = clamp(targetBottom, minTop, maxBottom)
          }

          const finalWidth = Math.max(0, targetRight - targetLeft)
          const finalHeight = Math.max(0, targetBottom - targetTop)

          if (!finalWidth || !finalHeight) {
            overlay.style.display = 'none'
            return
          }

          overlay.style.display = 'block'
          overlay.style.position = isFixed ? 'fixed' : 'absolute'
          overlay.style.top = `${targetTop}px`
          overlay.style.left = `${targetLeft}px`
          overlay.style.width = `${finalWidth}px`
          overlay.style.height = `${finalHeight}px`
          overlay.style.borderRadius = computed?.borderRadius || '0'
        }

        const scheduleSyncAll = () => {
          if (scheduled) {
            return
          }
          scheduled = true
          requestAnimationFrame(() => {
            scheduled = false
            overlays.forEach((entry) => syncOverlay(entry))
          })
        }

        window.addEventListener('scroll', scheduleSyncAll, { passive: true })
        window.addEventListener('resize', scheduleSyncAll)

        const manager = {
          overlays,
          scheduleSyncAll,
          syncOverlay,
          attach (element) {
            if (!element || overlays.has(element)) {
              scheduleSyncAll()
              return
            }

            const overlay = document.createElement('div')
            overlay.dataset.diffyMaskOverlay = 'true'
            Object.assign(overlay.style, {
              display: 'none',
              position: 'absolute',
              top: '0',
              left: '0',
              width: '0',
              height: '0',
              backgroundColor: '#00aa00',
              opacity: '1',
              mixBlendMode: 'normal',
              pointerEvents: 'none',
              margin: '0',
              padding: '0',
              border: '0',
              zIndex: '2147483647',
              boxSizing: 'border-box',
              transform: 'translate3d(0,0,0)',
            })

            document.body.appendChild(overlay)

            const entry = { element, overlay }

            if (typeof ResizeObserver === 'function') {
              entry.resizeObserver = new ResizeObserver(() => scheduleSyncAll())
              try {
                entry.resizeObserver.observe(element)
              } catch (_) {}
            }

            overlays.set(element, entry)
            syncOverlay(entry)
          },
        }

        window.__diffyMaskManager = manager
        return manager
      }

      const isHiddenByAttrs = (element) => {
        let current = element
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          if (current.hasAttribute?.('hidden') || current.hasAttribute?.('inert')) {
            return true
          }
          const ariaHidden = current.getAttribute?.('aria-hidden')
          if (ariaHidden && ariaHidden !== 'false') {
            return true
          }
          current = current.parentElement
        }
        return false
      }

      const intersectsViewport = (rect) => {
        const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0
        const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0
        if (!viewportWidth || !viewportHeight) {
          return true
        }
        return !(
          rect.bottom <= 0 ||
          rect.right <= 0 ||
          rect.top >= viewportHeight ||
          rect.left >= viewportWidth
        )
      }

      const isVisible = (element) => {
        if (!element || isHiddenByAttrs(element)) {
          return false
        }

        const style = window.getComputedStyle(element)
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          parseFloat(style.opacity || '1') <= 0
        ) {
          return false
        }

        if (element.offsetParent === null && style.position !== 'fixed') {
          return false
        }

        const rect = element.getBoundingClientRect()
        if (!rect || rect.width <= 0 || rect.height <= 0 || !intersectsViewport(rect)) {
          return false
        }

        return (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0)
      }

      const manager = ensureMaskManager()

      const selectors = Array.isArray(_elements)
        ? _elements
        : []

      selectors.forEach((selector) => {
        if (typeof selector !== 'string') {
          return
        }
        const trimmed = selector.trim()
        if (!trimmed.length) {
          return
        }

        const nodes = Array.from(document.querySelectorAll(trimmed))
        nodes.forEach((node) => {
          if (!isVisible(node)) {
            return
          }
          manager.attach(node)
        })
      })

      manager.scheduleSyncAll()

      return {
        maskedSelectors: selectors.length,
        maskedElements: manager.overlays.size,
      }
    }, job.args.elements)
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
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
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

    return context.cookies()
  },

  removeFile: async (filepath) => {
    await fs.rm(filepath, { force: true })
  },

  random: (min, max) => {
    return random(min, max)
  },

  buildHeaderConfig: (job) => {
    return buildHeaderConfig(job)
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

  setHeaders: async (context, job, precomputedConfig = null) => {
    const headerConfig = precomputedConfig ?? buildHeaderConfig(job)
    await applyHeadersToContext(context, headerConfig)
    return headerConfig
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
    try {
      const cdp = await page.context().newCDPSession(page);
      const { data } = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
      return data;
    } catch (err) {
      // WebKit and Firefox do not support CDP. Fallback to empty string.
      logger.warn('MHTML capture not supported; skipping', { error: (err && err.message) ? err.message : String(err) })
      return '';
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
  }
}
