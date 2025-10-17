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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

const randomIntegerBetween = (min, max) => {
  if (max <= min) {
    return min
  }
  return crypto.randomInt(min, max + 1)
}

const randomFloatBetween = (min, max) => Math.random() * (max - min) + min

const BROWSER_PROFILES = [
  {
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
  },
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36',
    locale: 'en-US',
    languages: ['en-US', 'en', 'en-GB'],
    timezoneId: 'America/Los_Angeles',
    platform: 'macOS',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    devicePixelRatio: 2,
    brands: [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: '130' },
      { brand: 'Google Chrome', version: '130' }
    ],
    platformVersion: '14.0.0',
    architecture: 'x86',
    bitness: '64',
    maxTouchPoints: 3,
    webglVendor: 'Google Inc. (ATI Technologies Inc.)',
    webglRenderer: 'ANGLE (ATI Technologies Inc., AMD Radeon Pro 560X OpenGL Engine, OpenGL 4.1)'
  },
  {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.90 Safari/537.36',
    locale: 'en-GB',
    languages: ['en-GB', 'en'],
    timezoneId: 'Europe/London',
    platform: 'Linux',
    hardwareConcurrency: 16,
    deviceMemory: 16,
    devicePixelRatio: 1,
    brands: [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: '129' },
      { brand: 'Google Chrome', version: '129' }
    ],
    platformVersion: '6.8.0',
    architecture: 'x86',
    bitness: '64',
    maxTouchPoints: 1,
    webglVendor: 'Google Inc. (Intel Inc.)',
    webglRenderer: 'ANGLE (Intel Inc., Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  }
]

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
    profile = BROWSER_PROFILES[0]
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

const applyStealthToContext = async (context, clientHints) => {
  if (!context || typeof context.addInitScript !== 'function') {
    return
  }

  const hints = clientHints || buildClientHintMetadata()
  const config = {
    brands: hints.brands || [
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: '120' },
      { brand: 'Google Chrome', version: '120' }
    ],
    platform: hints.platform || 'Windows',
    mobile: typeof hints.mobile === 'boolean' ? hints.mobile : false,
    uaFullVersion: hints.uaFullVersion || '120.0.0.0',
    hardwareConcurrency: hints.hardwareConcurrency || 8,
    deviceMemory: hints.deviceMemory || 8,
    languages: hints.languages || DEFAULT_LANGUAGES,
    maxTouchPoints: typeof hints.maxTouchPoints === 'number' ? hints.maxTouchPoints : 1,
    devicePixelRatio: hints.devicePixelRatio || 1,
    architecture: hints.architecture || 'x86',
    bitness: hints.bitness || '64',
    locale: hints.locale || DEFAULT_LANGUAGES[0],
    timeZone: clientHints?.timezoneId || 'UTC',
    webglVendor: clientHints?.webglVendor || 'Google Inc.',
    webglRenderer: clientHints?.webglRenderer || 'ANGLE (Google Inc., Vulkan 1.3) ',
    plugins: [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ],
  }

  await context.addInitScript((cfg) => {
    try {
      const override = (object, property, value) => {
        Object.defineProperty(object, property, {
          get: () => value,
          configurable: true,
        })
      }

      override(Navigator.prototype, 'webdriver', undefined)

      if (!window.chrome) {
        Object.defineProperty(window, 'chrome', {
          value: { runtime: {} },
          configurable: true,
        })
      } else if (!window.chrome.runtime) {
        window.chrome.runtime = {}
      }

      override(Navigator.prototype, 'languages', cfg.languages)
      override(Navigator.prototype, 'language', cfg.languages?.[0] || 'en-US')
      override(Navigator.prototype, 'platform', cfg.platform)
      override(Navigator.prototype, 'hardwareConcurrency', cfg.hardwareConcurrency)
      override(Navigator.prototype, 'deviceMemory', cfg.deviceMemory)
      override(Navigator.prototype, 'maxTouchPoints', cfg.maxTouchPoints)

      Object.defineProperty(Navigator.prototype, 'plugins', {
        get: () => cfg.plugins,
        configurable: true,
      })

      const originalQuery = navigator.permissions.query.bind(navigator.permissions)
      navigator.permissions.query = (parameters) => (
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      )

      const createPermissionStatus = (state) => ({ state, onchange: null })
      const permissionOverrides = {
        microphone: 'granted',
        camera: 'granted',
        notifications: Notification.permission,
        geolocation: 'granted',
        midi: 'denied',
        clipboard: 'granted',
      }

      navigator.permissions.query = async (descriptor) => {
        const name = descriptor && descriptor.name
        if (name && name in permissionOverrides) {
          return createPermissionStatus(permissionOverrides[name])
        }
        return originalQuery(descriptor)
      }

      const brandEntries = cfg.brands.map(({ brand, version }) => ({ brand, version }))

      const userAgentDataPayload = {
        brands: brandEntries,
        mobile: cfg.mobile,
        platform: cfg.platform,
        getHighEntropyValues: async (keys) => {
          const data = {
            brands: brandEntries,
            mobile: cfg.mobile,
            platform: cfg.platform,
            architecture: 'x86',
            bitness: '64',
            model: '',
            uaFullVersion: cfg.uaFullVersion,
            fullVersionList: brandEntries.map(({ brand, version }) => ({ brand, version: cfg.uaFullVersion })),
          }

          const result = {}
          if (Array.isArray(keys)) {
            keys.forEach((key) => {
              if (Object.hasOwn(data, key)) {
                result[key] = data[key]
              }
            })
          }

          return result
        },
        toJSON: () => ({
          brands: brandEntries,
          mobile: cfg.mobile,
          platform: cfg.platform,
        }),
      }

      if (!navigator.userAgentData) {
        Object.defineProperty(navigator, 'userAgentData', {
          get: () => userAgentDataPayload,
          configurable: true,
        })
      }

      if (!window.navigator.connection) {
        Object.defineProperty(window.navigator, 'connection', {
          value: {
            downlink: 10,
            effectiveType: '4g',
            rtt: 50,
            saveData: false,
          },
          configurable: true,
        })
      }

      try {
        Object.defineProperty(window, 'devicePixelRatio', {
          get: () => cfg.devicePixelRatio,
          configurable: true,
        })
      } catch (err) {}

      const patchGetParameter = (proto) => {
        if (!proto || !proto.prototype) return
        const originalGetParameter = proto.prototype.getParameter
        Object.defineProperty(proto.prototype, 'getParameter', {
          value: function (parameter) {
            if (parameter === this.RENDERER || parameter === this.UNMASKED_RENDERER_WEBGL) {
              return cfg.webglRenderer
            }
            if (parameter === this.VENDOR || parameter === this.UNMASKED_VENDOR_WEBGL) {
              return cfg.webglVendor
            }
            return originalGetParameter.call(this, parameter)
          },
        })
      }

      patchGetParameter(window.WebGLRenderingContext)
      patchGetParameter(window.WebGL2RenderingContext)

      if (!window.navigator.mediaDevices) {
        window.navigator.mediaDevices = {}
      }

      const fakeDevice = (kind, label) => ({
        deviceId: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
        groupId: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
        kind,
        label,
      })

      window.navigator.mediaDevices.enumerateDevices = async () => ([
        fakeDevice('audioinput', 'External Microphone'),
        fakeDevice('audiooutput', 'Internal Speakers'),
        fakeDevice('videoinput', 'Integrated Webcam'),
      ])

      const geolocation = {
        getCurrentPosition: (success, error) => {
          const coords = {
            latitude: 40.7128,
            longitude: -74.0060,
            accuracy: 12,
            altitudeAccuracy: 8,
          }
          success?.({ coords, timestamp: Date.now() })
        },
        watchPosition: (success) => {
          const id = setInterval(() => {
            geolocation.getCurrentPosition(success)
          }, 60000)
          return id
        },
        clearWatch: (id) => clearInterval(id),
      }

      if (!navigator.geolocation) {
        Object.defineProperty(navigator, 'geolocation', {
          value: geolocation,
          configurable: true,
        })
      }

      if (!navigator.clipboard) {
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            writeText: async () => {},
            readText: async () => '',
          },
          configurable: true,
        })
      }

      const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions
      Intl.DateTimeFormat.prototype.resolvedOptions = function (...args) {
        const options = originalResolvedOptions.apply(this, args) || {}
        options.timeZone = cfg.timeZone
        options.locale = cfg.locale
        return options
      }

      const originalOffset = Date.prototype.getTimezoneOffset
      Date.prototype.getTimezoneOffset = function () {
        try {
          const formatter = Intl.DateTimeFormat('en-US', { timeZone: cfg.timeZone, timeZoneName: 'short' })
          const parts = formatter.formatToParts(this)
          const zoneName = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT'
          if (/GMT([+-]\d{2})/.test(zoneName)) {
            const sign = zoneName.includes('-') ? -1 : 1
            const hours = parseInt(zoneName.slice(4, 6), 10)
            return -sign * hours * 60
          }
        } catch (error) {}
        return originalOffset.call(this)
      }

      const originalCanvasToDataURL = HTMLCanvasElement.prototype.toDataURL
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        const context = this.getContext('2d')
        if (context) {
          context.getImageData(0, 0, 1, 1)
        }
        return originalCanvasToDataURL.apply(this, args)
      }
    } catch (error) {
      // Swallow stealth init errors to avoid leaking to the page context.
    }
  }, config)
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
      await page.waitForSelector('body');
      scrollHeight = await page.evaluate('document.body.scrollHeight');
      await page.evaluate('window.scrollBy(0, 100)');
      totalHeight += 100;
      // no timeout here
    } while (totalHeight < scrollHeight);

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

    return page
  },

  hideBanners: async (page, job) => {
    if (!checkArgs(job, 'elements', true)) {
      return Promise.resolve()
    }

    return page.evaluate((_elements) => {
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

        const overlay = document.createElement('div');
        Object.assign(overlay.style, {
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

        document.body.appendChild(overlay);
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

  applyHeadersToContext: async (context, headerConfig) => {
    await applyHeadersToContext(context, headerConfig)
  },

  applyStealth: async (context, hintsOrHeaderConfig = null) => {
    const hints = hintsOrHeaderConfig?.clientHints || hintsOrHeaderConfig
    await applyStealthToContext(context, hints)
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

  setHeaders: async (context, job) => {
    const headerConfig = buildHeaderConfig(job)
    await applyHeadersToContext(context, headerConfig)
    await applyStealthToContext(context, headerConfig.clientHints)
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
    const cdp = await page.context().newCDPSession(page);
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
