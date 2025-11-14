const uploadS3 = require('./uploadS3.js')
const thumbnail = require('./thumbnail.js')
const func = require('./func.js')
const logger = require('./logger')
const sharp = require('sharp')
const fsPromises = require('node:fs/promises')

const CHROMIUM_SINGLE_CAPTURE_HEIGHT_LIMIT = 16384
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 120000
const LAYOUT_STABILITY_DEFAULT_TIMEOUT_MS = 6000
const LAYOUT_STABILITY_DEFAULT_QUIET_WINDOW_MS = 300
const IMAGE_STABILITY_TIMEOUT_MS = 5000
const FONT_STABILITY_TIMEOUT_MS = 7000
const STABILIZATION_SNIPPET_TIMEOUT_MS = 5000

const sendResult = (job, jobItem, data) => {
  job.status = true
  job.item_result = data
  if (jobItem && Object.hasOwn(jobItem, 'additionalType')) {
    job.item_result.additionalType = jobItem.additionalType
  }
  return job
}

const sendError = (job, error, jobItem) => {
  job.status = false
  job.err = error
  job.item_result = []
  if (jobItem && Object.hasOwn(jobItem, 'additionalType')) {
    job.item_result.additionalType = jobItem.additionalType
  }
  return job
}

const handleIncapsula = async (page, maxRetries = 5) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const iframeDetected = await page.$('iframe#main-iframe');
    if (iframeDetected) {
      const html = await page.content();
      const isIncapsula = html.includes('_Incapsula_Resource');

      if (isIncapsula) {
        logger.debug(`Incapsula iframe detected (attempt ${attempt + 1}/${maxRetries + 1})`);

        await page.mouse.move(300, 100);
        await page.mouse.click(300, 100);
        await page.keyboard.type('test');
        await page.keyboard.press('Tab');
        await page.evaluate(() => window.scrollBy(0, 100));

        const cleared = await page.waitForFunction(
            () => !document.querySelector('iframe#main-iframe'),
            { timeout: 10000 }
        ).catch(() => false);

        if (cleared) {
          logger.info('Incapsula iframe cleared. Proceeding...');
        }

        if (attempt < maxRetries) {
          logger.warn('iframe did not disappear. Retrying page reload...');
          await page.reload();
          try {
            await page.waitForLoadState('networkidle', { timeout: 10000 });
          } catch (e) {
            logger.warn('networkidle timeout after reload; retrying with load');
            try {
              await page.waitForLoadState('load', { timeout: 5000 });
            } catch (e2) {
              logger.warn('load timeout after reload; continuing');
            }
          }
        } else {
          logger.error('Incapsula iframe still present after all retries.');
        }
      }
    }
  }
}

const saveError = async (job, jobItem, errorText) => {
  let filenameKey
  let filename

  try {
    if (errorText && (errorText.includes('SOCKETTIMEOUT') || errorText.includes('SOCKETTIMEDOUT'))) {
      errorText = 'Diffy was unable to take the screenshot.\n' +
          'Looks like we have overloaded your server. Please try lowering number of workers for this environment under Project Settings -> Advanced -> Performance'
    }

    errorText = 'Error: ' + errorText
    const width = (jobItem && Object.hasOwn(jobItem, 'breakpoint')) ? jobItem.breakpoint : 1024
    filenameKey = Math.floor(Date.now() / 1000) + '-' + (func.random(0, 999999999)).toString()

    const fileExtension = width < 16000 ? '.webp' : '.png';
    filename = '/tmp/screenshot-error-' + filenameKey + fileExtension
    const thumbnailFilepath = filename.replace(fileExtension, '-thumbnail' + fileExtension)

    await thumbnail.createErrorImage(filename, errorText, width)

    const s3Url = await uploadS3.upload(filename).catch((err) => {
      throw new Error('Can\'t upload screenshot: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
    })

    await thumbnail.generateImageThumbnail(filename, thumbnailFilepath).catch((err) => {
      throw new Error('Can\'t generate thumbnail: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
    })

    const s3UrlThumbnail = await uploadS3.upload(thumbnailFilepath).catch((err) => {
      throw new Error('Can\'t upload thumbnail: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
    })

    // Not need to remove "htmlFilename/mhtmlFilename" because we use stream and not creating real file.
    // Async remove files.
    await func.removeFile(filename)
    await func.removeFile(thumbnailFilepath)

    return sendResult(job, jobItem, {
      'full': s3Url,
      'thumbnail': s3UrlThumbnail,
      'html': '',
      'data': 'Error: ' + JSON.stringify(job),
      'log_data': '',
      'error': {
        'message': errorText
      }
    })
  } catch (err) {
    return sendResult(job, jobItem, {
      'full': '',
      'thumbnail': '',
      'html': '',
      'data': 'Error: Can\'t generate error image. ' + errorText + ' => ' + (err && Object.hasOwn(err, 'message')) ? err.message : err,
      'log_data': '',
    })
  }
}

async function disableGifAnimation(page) {
  await page.evaluate(() => {
    Array.from(document.images)
        .filter((image) => /^(?!data:).*\.gif$/i.test(image.src))
        .forEach((image) => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          canvas.width = image.width;
          canvas.height = image.height;

          try {
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

            image.src = canvas.toDataURL('image/gif');
          } catch (e) {
            const clonedCanvas = canvas.cloneNode(true);

            Array.from(image.attributes).forEach((attr) => {
              clonedCanvas.setAttribute(attr.name, attr.value);
            });

            image.replaceWith(clonedCanvas);
          }
        });
  });
}

// Safe helpers to avoid calling into a closed target.
const ensureOpen = (page, label = 'operation') => {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    throw new Error(`Page closed before ${label}`)
  }
}

const coerceTimeoutMs = (value, fallback) => {
  if (value === undefined || value === null) {
    return fallback
  }

  let numeric = value

  if (typeof numeric === 'string') {
    const trimmed = numeric.trim()
    if (!trimmed.length) {
      return fallback
    }

    numeric = Number.parseFloat(trimmed)
  }

  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric < 0) {
    return fallback
  }

  if (numeric === 0) {
    return 0
  }

  // Treat small values as seconds to remain backward compatible with existing configs.
  if (numeric > 0 && numeric < 1000) {
    return numeric * 1000
  }

  return numeric
}

const isTimeoutError = (error) => {
  if (!error) {
    return false
  }

  if (error.name === 'TimeoutError') {
    return true
  }

  const message = (error && Object.hasOwn(error, 'message')) ? error.message : String(error)
  return /Timeout\s+\d+ms\s+exceeded/i.test(message)
}

const screenshotWithAdaptiveTimeout = async (page, options, label, logContext = {}) => {
  ensureOpen(page, label)

  try {
    return await page.screenshot(options)
  } catch (err) {
    if (!isTimeoutError(err) || options.timeout === undefined || options.timeout === 0) {
      throw err
    }

    logger.warn(`${label} timed out; retrying without capture timeout`, {
      ...logContext,
      timeoutMs: options.timeout,
    })

    ensureOpen(page, `${label} retry`)
    const retryOptions = { ...options, timeout: 0 }
    return page.screenshot(retryOptions)
  }
}

const safeEval = async (page, fn, arg, label = 'evaluate') => {
  ensureOpen(page, label)
  return page.evaluate(fn, arg)
}

const safeWaitForFunction = async (page, predicate, options, label = 'waitForFunction') => {
  ensureOpen(page, label)
  return page.waitForFunction(predicate, options)
}

const safeAddStyleTag = async (page, opts, label = 'addStyleTag') => {
  ensureOpen(page, label)
  return page.addStyleTag(opts)
}

const runStabilizationSnippet = async (page, code, { timeoutMs = STABILIZATION_SNIPPET_TIMEOUT_MS } = {}) => {
  if (!code || !code.toString().trim().length) {
    return { executed: false }
  }

  ensureOpen(page, 'stabilization snippet start')

  try {
    const result = await safeEval(page, ({ source, timeout }) => {
      return new Promise((resolve, reject) => {
        let settled = false
        const finish = (fn, value) => {
          if (settled) return
          settled = true
          fn(value)
        }

        const timer = setTimeout(() => finish(reject, new Error('stabilization script timed out')), timeout)

        try {
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
          const executor = new AsyncFunction(source)

          Promise.resolve(executor.call(window))
              .then((value) => {
                clearTimeout(timer)
                finish(resolve, value)
              })
              .catch((error) => {
                clearTimeout(timer)
                finish(reject, error)
              })
        } catch (error) {
          clearTimeout(timer)
          finish(reject, error)
        }
      })
    }, { source: code, timeout: timeoutMs }, 'stabilization snippet evaluation')

    return {
      executed: true,
      result,
    }
  } catch (error) {
    logger.warn('Stabilization snippet failed', { error: error?.message || String(error) })
    return {
      executed: false,
      error: error?.message || String(error),
    }
  }
}

const waitForFontFaces = async (page, {
  timeoutMs = FONT_STABILITY_TIMEOUT_MS,
} = {}) => {
  ensureOpen(page, 'font-stability start')

  try {
    const result = await safeEval(page, ({ timeout }) => {
      if (!document.fonts || typeof document.fonts.ready?.then !== 'function') {
        return { supported: false, status: 'unsupported', pending: [] }
      }

      const snapshotPending = () => {
        const pending = []
        try {
          document.fonts.forEach((fontFace) => {
            if (fontFace?.status === 'loading') {
              pending.push({
                family: fontFace.family || '',
                weight: fontFace.weight || '',
                style: fontFace.style || '',
              })
            }
          })
        } catch (_) {}
        return pending
      }

      return new Promise((resolve) => {
        let settled = false

        const finish = (status, timedOut = false) => {
          if (settled) return
          settled = true
          resolve({
            supported: true,
            status,
            timedOut,
            pending: snapshotPending(),
          })
        }

        const timer = setTimeout(() => finish(document.fonts.status || 'timeout', true), timeout)

        document.fonts.ready
          .then(() => {
            clearTimeout(timer)
            finish('loaded', false)
          })
          .catch(() => {
            clearTimeout(timer)
            finish(document.fonts.status || 'error', false)
          })
      })
    }, { timeout: timeoutMs }, 'fonts.ready monitor')

    if (result?.supported && result.pending?.length) {
      logger.warn('Fonts still pending after readiness wait', {
        pendingFonts: result.pending.slice(0, 5),
        pendingCount: result.pending.length,
      })
    }

    if (result?.timedOut) {
      logger.warn('Font readiness timed out', { timeoutMs })
    }

    return result
  } catch (error) {
    logger.warn('Font readiness wait failed', { error: error?.message || String(error) })
    return { supported: false, status: 'error', error: error?.message || String(error) }
  }
}

const waitForVisualStability = async (page, {
  totalTimeoutMs = LAYOUT_STABILITY_DEFAULT_TIMEOUT_MS,
  quietWindowMs = LAYOUT_STABILITY_DEFAULT_QUIET_WINDOW_MS,
  waitForFonts = false,
} = {}) => {
  ensureOpen(page, 'visual-stability start')

  let fontsSettled = null
  if (waitForFonts) {
    try {
      await safeEval(page, () => {
        if (!document.fonts || typeof document.fonts.ready?.then !== 'function') {
          return true
        }
        return document.fonts.ready.then(() => true)
      }, undefined, 'fonts.ready wait')
      fontsSettled = true
    } catch (error) {
      fontsSettled = false
      logger.warn('Font readiness wait failed', { error: error?.message || String(error) })
    }
  }

  let imagesSettled = false
  try {
    await safeWaitForFunction(
        page,
        () => Array.from(document.images || []).every((img) => {
          if (!img) return true
          if (!img.complete) return false
          if (typeof img.naturalWidth === 'number') {
            return img.naturalWidth > 0
          }
          const rect = img.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }),
        { timeout: IMAGE_STABILITY_TIMEOUT_MS },
        'images.complete wait'
    )
    imagesSettled = true
  } catch (error) {
    logger.warn('Image load stabilization timed out', {
      timeoutMs: IMAGE_STABILITY_TIMEOUT_MS,
      error: error?.message || String(error),
    })
  }

  const quietMs = Math.max(quietWindowMs, 100)
  const endTime = Date.now() + totalTimeoutMs
  let layoutSettled = false

  try {
    const initStatus = await safeEval(page, ({ quietWindow }) => {
      const monitor = window.__diffyLayoutShiftMonitor || {
        lastShiftTs: performance.now(),
        quietWindow,
        unsupported: typeof PerformanceObserver !== 'function',
      }

      monitor.quietWindow = quietWindow
      if (monitor.unsupported) {
        window.__diffyLayoutShiftMonitor = monitor
        return { unsupported: true }
      }

      if (!monitor.observer && typeof PerformanceObserver === 'function') {
        try {
          monitor.observer = new PerformanceObserver((list) => {
            const entries = list.getEntries()
            if (!entries?.length) {
              return
            }

            const now = performance.now()
            for (const entry of entries) {
              if (entry?.hadRecentInput) continue
              monitor.lastShiftTs = now
              break
            }
          })
          monitor.observer.observe({ type: 'layout-shift', buffered: true })
        } catch (observerError) {
          monitor.error = observerError?.message || String(observerError)
        }
      }

      const buffered = performance.getEntriesByType?.('layout-shift') || []
      if (buffered?.length) {
        const lastBuffered = buffered
            .filter((entry) => entry && !entry.hadRecentInput)
            .map((entry) => entry.startTime)
        if (lastBuffered.length) {
          monitor.lastShiftTs = Math.max(monitor.lastShiftTs, ...lastBuffered, performance.now())
        }
      } else {
        monitor.lastShiftTs = performance.now()
      }

      window.__diffyLayoutShiftMonitor = monitor
      return {
        unsupported: false,
        error: monitor.error || null,
      }
    }, { quietWindow: quietMs }, 'init layout shift monitor')

    if (initStatus?.unsupported) {
      layoutSettled = true
    } else if (initStatus?.error) {
      logger.warn('Layout shift observer unavailable', { error: initStatus.error })
      layoutSettled = true
    } else {
      const maxChecks = Math.max(Math.ceil(totalTimeoutMs / Math.max(quietWindowMs, 100)) + 5, 10)
      let checks = 0

      while (Date.now() < endTime && checks < maxChecks) {
        const state = await safeEval(page, ({ quietWindow }) => {
          const monitor = window.__diffyLayoutShiftMonitor
          if (!monitor || monitor.unsupported) {
            return { settled: true, unsupported: true }
          }
          if (monitor.error) {
            return { settled: true, error: monitor.error }
          }

          const now = performance.now()
          const lastShiftTs = typeof monitor.lastShiftTs === 'number' ? monitor.lastShiftTs : now
          const delta = now - lastShiftTs
          return {
            settled: delta >= quietWindow,
            delta,
          }
        }, { quietWindow: quietMs }, 'check layout stability')

        if (state?.unsupported) {
          layoutSettled = true
          break
        }

        if (state?.error) {
          logger.warn('Layout stabilization observer error', { error: state.error })
          layoutSettled = true
          break
        }

        if (state?.settled) {
          layoutSettled = true
          break
        }

        await page.waitForTimeout(Math.min(quietMs, 200))
        checks += 1
      }

      if (checks >= maxChecks) {
        logger.warn('Layout stabilization aborted after max checks', {
          totalTimeoutMs,
          quietMs,
          performedChecks: checks,
        })
      }
    }
  } catch (error) {
    logger.warn('Layout stabilization check failed', { error: error?.message || String(error) })
  }

  if (!layoutSettled) {
    logger.warn('Layout stabilization timed out', {
      quietWindowMs: quietMs,
      totalTimeoutMs,
    })
  }

  try {
    await safeEval(page, () => {
      const monitor = window.__diffyLayoutShiftMonitor
      if (monitor?.observer && typeof monitor.observer.disconnect === 'function') {
        monitor.observer.disconnect()
      }
    }, undefined, 'cleanup layout shift monitor')
  } catch (_) {
  }

  return {
    fontsSettled,
    imagesSettled,
    layoutSettled,
  }
}

module.exports = {

  perform: async (browser, job, jobItem) => {
    // Bounded retry in case target/session closes mid-pipeline.
    const maxAttempts = 2
    let attempt = 0
    let lastErr

    while (attempt < maxAttempts) {
      attempt++

      let data = {};
      let context;
      let page;
      let jsConsole = [];
      const maxPageHeightIfError = 50000;

      try {
        const maxPageHeight = (Object.hasOwn(job, 'attempts') && job.attempts > 0) ? (maxPageHeightIfError / job.attempts) : maxPageHeightIfError

        const viewportWidth = parseInt(jobItem.breakpoint) || 800;
        const baseViewport = {width: viewportWidth, height: 1000};
        const headerConfig = func.buildHeaderConfig(jobItem);

        // This worker runs WebKit only; mirror desktop Safari defaults.

        const wantsRetina = !(Object.hasOwn(jobItem.args || {}, 'retina_images') && jobItem.args.retina_images === false)
        const contextOptions = {
          viewport: baseViewport,
          bypassCSP: true,
          ignoreHTTPSErrors: true,
          userAgent: headerConfig.userAgent,
          deviceScaleFactor: wantsRetina ? 2 : 1,
          locale: headerConfig.locale,
          timezoneId: headerConfig.timezoneId,
          hasTouch: false,
          isMobile: false,
        };

        if (
            Object.hasOwn(jobItem, 'basicAuth') && jobItem.basicAuth &&
            Object.hasOwn(jobItem.basicAuth, 'user') && jobItem.basicAuth.user &&
            Object.hasOwn(jobItem.basicAuth, 'password') && jobItem.basicAuth.password
        ) {
          contextOptions.httpCredentials = {
            username: jobItem.basicAuth.user,
            password: jobItem.basicAuth.password,
          };
        }

        context = await browser.newContext(contextOptions);

        // Adjust navigator properties and feature shims to resemble Safari on macOS as closely as practical.
        try {
          await context.addInitScript(({ languages }) => {
            try {
              const defineRO = (obj, prop, value) => {
                try {
                  Object.defineProperty(obj, prop, { get: () => value, configurable: true });
                } catch (_) {}
              };

              defineRO(navigator, 'platform', 'MacIntel');
              defineRO(navigator, 'vendor', 'Apple Computer, Inc.');
              defineRO(navigator, 'maxTouchPoints', 0);
              defineRO(navigator, 'hardwareConcurrency', 8);
              defineRO(navigator, 'language', languages && languages[0] ? languages[0] : 'en-US');
              defineRO(navigator, 'languages', Array.isArray(languages) && languages.length ? languages : ['en-US','en']);
              try { defineRO(navigator, 'productSub', '20030107'); } catch (_) {}
              try { defineRO(navigator, 'vendorSub', ''); } catch (_) {}
              try { defineRO(navigator, 'product', 'Gecko'); } catch (_) {}
              try {
                // Safari currently has no UA-CH; ensure userAgentData is undefined.
                Object.defineProperty(navigator, 'userAgentData', { get: () => undefined, configurable: true });
              } catch (_) {}

              // Keep webdriver falsy for parity.
              try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch (_) {}

              // Safari does not expose window.chrome
              try {
                Object.defineProperty(window, 'chrome', { get: () => undefined, configurable: true });
              } catch (_) {}

              // Minimal PluginArray/MimeTypeArray to resemble Safari (often empty arrays on desktop).
              try {
                const makeArrayLike = (name) => {
                  const arr = [];
                  Object.defineProperty(arr, 'item', { value: (i) => arr[i] || null, configurable: true });
                  Object.defineProperty(arr, 'namedItem', { value: () => null, configurable: true });
                  Object.defineProperty(arr, 'refresh', { value: () => {}, configurable: true });
                  Object.defineProperty(arr, 'toString', { value: () => `[object ${name}]`, configurable: true });
                  return arr;
                };
                const plugins = makeArrayLike('PluginArray');
                const mimeTypes = makeArrayLike('MimeTypeArray');
                defineRO(navigator, 'plugins', plugins);
                defineRO(navigator, 'mimeTypes', mimeTypes);
              } catch (_) {}

              // Remove non-Safari navigator features
              try { Object.defineProperty(navigator, 'deviceMemory', { get: () => undefined, configurable: true }); } catch (_) {}
              try { Object.defineProperty(navigator, 'connection', { get: () => undefined, configurable: true }); } catch (_) {}

              // WebGL renderer/vendor hints similar to Safari
              const spoofWebGL = (proto) => {
                if (!proto || typeof proto.getParameter !== 'function') return;
                const original = proto.getParameter;
                proto.getParameter = function(param){
                  try {
                    // WEBGL_debug_renderer_info constants
                    if (param === 0x9245 /* UNMASKED_VENDOR_WEBGL */) return 'Apple Inc.';
                    if (param === 0x9246 /* UNMASKED_RENDERER_WEBGL */) return 'Apple GPU';
                  } catch (_) {}
                  return original.call(this, param);
                };
              };
              try { spoofWebGL(WebGLRenderingContext?.prototype); } catch (_) {}
              try { spoofWebGL(WebGL2RenderingContext?.prototype); } catch (_) {}

              // Media feature shims: color-gamut, prefers-contrast, forced-colors, inverted-colors
              try {
                const origMatch = window.matchMedia;
                if (typeof origMatch === 'function') {
                  window.matchMedia = function(q){
                    try {
                      const query = String(q || '').toLowerCase();
                      if (/(^|\s)\(\s*color-gamut\s*:\s*srgb\s*\)/.test(query)) {
                        return { matches: true, media: q, onchange: null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } };
                      }
                      if (/(^|\s)\(\s*prefers-contrast\s*:\s*no-preference\s*\)/.test(query)) {
                        return { matches: true, media: q, onchange: null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } };
                      }
                      if (/(^|\s)\(\s*forced-colors\s*:\s*none\s*\)/.test(query)) {
                        return { matches: true, media: q, onchange: null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } };
                      }
                      if (/(^|\s)\(\s*inverted-colors\s*:\s*none\s*\)/.test(query)) {
                        return { matches: true, media: q, onchange: null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } };
                      }
                    } catch (_) {}
                    return origMatch.apply(this, arguments);
                  };
                }
              } catch (_) {}

              // Screen parity typical for desktop Safari
              try {
                Object.defineProperty(window.screen, 'colorDepth', { get: () => 24, configurable: true });
                Object.defineProperty(window.screen, 'pixelDepth', { get: () => 24, configurable: true });
              } catch (_) {}

              // Avoid overriding DPR and window metrics to let engine report native values

              // Pointer/hover media features for desktop Safari
              try {
                const origMatch2 = window.matchMedia;
                if (typeof origMatch2 === 'function') {
                  window.matchMedia = function(q){
                    try {
                      const query = String(q || '').toLowerCase();
                      if (/(^|\s)\(\s*hover\s*:\s*hover\s*\)/.test(query)) {
                        return { matches: true, media: q, onchange: null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } };
                      }
                      if (/(^|\s)\(\s*any-hover\s*:\s*hover\s*\)/.test(query)) {
                        return { matches: true, media: q, onchange: null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } };
                      }
                      if (/(^|\s)\(\s*pointer\s*:\s*fine\s*\)/.test(query)) {
                        return { matches: true, media: q, onchange: null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } };
                      }
                      if (/(^|\s)\(\s*any-pointer\s*:\s*fine\s*\)/.test(query)) {
                        return { matches: true, media: q, onchange: null, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } };
                      }
                    } catch (_) {}
                    return origMatch2.apply(this, arguments);
                  };
                }
              } catch (_) {}

              // Media codec support similar to Safari (no WebM by default; H.264 AAC popular)
              try {
                const patchCanPlay = (proto) => {
                  if (!proto || typeof proto.canPlayType !== 'function') return;
                  const original = proto.canPlayType;
                  proto.canPlayType = function(type){
                    try {
                      const t = String(type || '').toLowerCase();
                      if (t.includes('webm')) return '';
                      if (t.includes('video/mp4') && (t.includes('avc1') || t.includes('h264'))) return 'probably';
                      if (t.includes('audio/mp4') || t.includes('mp4a')) return 'probably';
                    } catch (_) {}
                    return original.call(this, type);
                  };
                };
                patchCanPlay(HTMLVideoElement?.prototype);
                patchCanPlay(HTMLAudioElement?.prototype);
              } catch (_) {}

              // CSS.supports for common WebKit-prefixed properties
              try {
                if (window.CSS && typeof window.CSS.supports === 'function') {
                  const origSupports = window.CSS.supports.bind(window.CSS);
                  window.CSS.supports = function(prop, value) {
                    try {
                      if (arguments.length === 1) {
                        const text = String(prop || '').toLowerCase();
                        if (text.includes('-webkit-appearance')) return true;
                        if (text.includes('image-set(')) return true;
                      } else {
                        const p = String(prop || '').toLowerCase();
                        if (p === '-webkit-appearance') return true;
                      }
                    } catch (_) {}
                    return origSupports.apply(this, arguments);
                  }
                }
              } catch (_) {}

              // APIs/objects seen in Safari desktop
              try {
                Object.defineProperty(window, 'safari', {
                  configurable: true,
                  get: () => ({
                    pushNotification: {
                      toString: () => '[object SafariRemoteNotification]'
                    }
                  })
                });
              } catch (_) {}

              // APIs not present in Safari desktop
              try { navigator.getBattery && delete navigator.getBattery; } catch (_) {}
            } catch (_) {}
          }, { languages: headerConfig.languages || ['en-US','en'] });
        } catch (e) {
          logger.warn('Failed to install Safari-like navigator shim', { error: e?.message || String(e) });
        }
        await func.setHeaders(context, jobItem, headerConfig);
        page = await context.newPage();

        if (Object.hasOwn(jobItem.args, 'night_mode') && jobItem.args.night_mode) {
          await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
        } else {
          // Default to light scheme and no reduced motion to match typical Safari desktop defaults.
          await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
        }

        logger.debug('browser.newContext', {jobItem})

        await page.setDefaultNavigationTimeout(90000)
        await page.setDefaultTimeout(30000)

        logger.debug('setDefaultNavigationTimeout done')

        page.on('console', msg => {
          let consoleMes
          try {
            consoleMes = {
              type: msg.type(),
              text: msg.text(),
              location: msg.location(),
            }
          } catch (e) {
            consoleMes = {
              type: e.type(),
              text: e.text(),
              location: e.location(),
            }
          }

          jsConsole.push(consoleMes)
        })

        await context.clearCookies();
        logger.debug('setHeaders prepared', {
          userAgent: headerConfig.userAgent,
          extraHeaders: headerConfig.extraHeaders || {}
        })

        if (!Object.hasOwn(jobItem, 'url') || !Object.hasOwn(jobItem, 'breakpoint')) {
          throw new Error('Cannot find url or breakpoint options')
        }

        let url = jobItem.url;

        if (jobItem.url && jobItem.base_url) {
          // Base URL can have GET parameters. We need to merge them with url.
          let pageUrl = new URL(jobItem.url);
          let pageUrlParameters = pageUrl.searchParams;
          let pageUrlHash = pageUrl.hash;

          let baseUrl = new URL(jobItem.base_url);
          let baseUrlParameters = baseUrl.searchParams;

          // We override base URL parameters with ones from the page.
          pageUrlParameters.forEach((value, key) => {
            baseUrlParameters.set(key, value);
          });

          url = jobItem.url.replace(/[\?#].*$/, '');

          const parametersString = baseUrlParameters.toString();
          if (parametersString) {
            url += '?' + parametersString;
          }

          if (pageUrlHash) {
            url += pageUrlHash;
          }
        }

        const callRailBlockEnabled = Object.hasOwn(jobItem, 'project_id') && jobItem.project_id === 21791;
        let basicAuthRouteConfig = null;
        if (
            Object.hasOwn(jobItem, 'basicAuth') && jobItem.basicAuth &&
            Object.hasOwn(jobItem.basicAuth, 'user') && jobItem.basicAuth.user &&
            Object.hasOwn(jobItem.basicAuth, 'password') && jobItem.basicAuth.password &&
            url.startsWith('http://')
        ) {
          basicAuthRouteConfig = {
            header: `Basic ${Buffer.from(`${jobItem.basicAuth.user}:${jobItem.basicAuth.password}`).toString('base64')}`,
            targetHost: (() => {
              try {
                return new URL(jobItem.base_url).host;
              } catch (e) {
                return null;
              }
            })()
          };

          page.on('response', async (res) => {
            const status = res.status();
            const resUrl = res.url();

            if (status === 401) {
              const body = await res.text();
              logger.debug('[401 Response]', resUrl, body.slice(0, 300));
            }

            if (status >= 300 && status < 400) {
              logger.debug('[REDIRECT]', status, '→', res.headers()['location']);
            }
          });
        }

        const defaultBlockedHosts = [
          'www.google-analytics.com', 'analytics.google.com', 'ssl.google-analytics.com',
          'www.googletagmanager.com', 'googletagmanager.com', 'www.googletagservices.com',
          'connect.facebook.net', 'static.hotjar.com', 'script.hotjar.com', 'cdn.segment.com',
          'api.segment.io', 'static.ads-twitter.com', 'bat.bing.com', 'cdn.fullstory.com',
          'rs.fullstory.com', 'snap.licdn.com', 'cdn.heapanalytics.com', 'js.intercomcdn.com',
          'widget.intercom.io', 'hs-analytics.net', 'hs-scripts.com', 'googlesyndication.com',
          'doubleclick.net'
        ];

        const shouldBlockRequest = (urlString) => {
          try {
            const parsed = new URL(urlString);
            if (callRailBlockEnabled && /swap_session\.json/i.test(parsed.pathname)) {
              return true;
            }

            return defaultBlockedHosts.some((host) => parsed.host.endsWith(host));
          } catch (_) {
            return false;
          }
        };

        await page.route('**/*', (route) => {
          const request = route.request();
          const requestUrl = request.url();

          if (shouldBlockRequest(requestUrl)) {
            route.abort().catch((error) => {
              logger.warn('Failed to abort blocked request', { error, requestUrl });
            });
            return;
          }

          let continueOptions = null;

          if (basicAuthRouteConfig) {
            const headers = {
              ...request.headers(),
              Authorization: basicAuthRouteConfig.header,
            };

            let overriddenUrl = requestUrl;
            try {
              const host = new URL(requestUrl).host;
              if (host && basicAuthRouteConfig.targetHost && host === basicAuthRouteConfig.targetHost) {
                overriddenUrl = overriddenUrl.replace(/^https:/, 'http:');
              }
            } catch (_) {}

            continueOptions = { headers, url: overriddenUrl };
          }

          route.continue(continueOptions || undefined).catch((error) => {
            logger.warn('Failed to continue request', { error, requestUrl });
          });
        });

        // Add new cookies.
        let cookies = await func.addCookies(jobItem)
        logger.debug('addCookies done')

        const authCookies = await func.auth(page, jobItem).catch((err) => {
          const message = (err && Object.hasOwn(err, 'message')) ? err.message : err;
          data.auth_error = `${err?.name || 'AuthError'}: ${message}`;
          return null;
        })

        logger.debug('auth done')

        if (authCookies) {
          logger.debug('authCookies', {authCookies})
          cookies = cookies.concat(authCookies)
        }

        if (cookies?.length) {
          await context.addCookies(cookies)
        }

        // Only attempt permission grants when explicitly requested in job args.
        const requestedPerms = (() => {
          const arg = jobItem?.args?.grant_permissions
          if (!arg) return null
          if (Array.isArray(arg)) return arg
          if (arg === true) return ['geolocation', 'notifications', 'camera', 'microphone']
          return null
        })()

        if (requestedPerms && requestedPerms.length) {
          try {
            const origin = new URL(url).origin
            await context.grantPermissions(requestedPerms, { origin })
          } catch (firstErr) {
            try {
              await context.grantPermissions(requestedPerms)
            } catch (finalErr) {
              logger.warn('Failed to grant permissions (ignored)', { error: finalErr })
            }
          }
        }

        let response;
        // Allow per-job override, but default to 'networkidle'.
        const requestedWaitUntil = (jobItem?.args?.navigation_wait_until || '').toString().toLowerCase();
        const navWaitUntil = ['networkidle', 'load', 'domcontentloaded'].includes(requestedWaitUntil)
          ? requestedWaitUntil
          : 'networkidle';

        try {
          await page.waitForTimeout(func.random(120, 380));
          response = await page.goto(url, { waitUntil: navWaitUntil })

          await handleIncapsula(page);
          await func.handleCloudflareChallenge(page, {frameWaitMs: 8000, retryDelayMs: 2500}).catch((error) => {
            logger.warn('Cloudflare challenge handling failed', {error})
          })
          const unresolvedChallenge = await page.evaluate(() => {
            const bodyText = document.body?.innerText || ''
            return bodyText.includes('Please unblock challenges.cloudflare.com')
          }).catch(() => false)
          if (unresolvedChallenge) {
            throw new Error('Cloudflare challenge unresolved: Please unblock challenges.cloudflare.com')
          }
        } catch (err) {
          logger.warn('page was not loaded by first strategy', { url, waitUntil: navWaitUntil })

          try {
            response = await page.goto(url, {waitUntil: 'load'})
            await page.waitForLoadState('domcontentloaded', {timeout: 120000}).catch(() => {
            })
            await func.handleCloudflareChallenge(page, {frameWaitMs: 8000, retryDelayMs: 2500}).catch((error) => {
              logger.warn('Cloudflare challenge handling failed (retry branch)', {error})
            })
            const unresolvedChallenge = await page.evaluate(() => {
              const bodyText = document.body?.innerText || ''
              return bodyText.includes('Please unblock challenges.cloudflare.com')
            }).catch(() => false)
            if (unresolvedChallenge) {
              throw new Error('Cloudflare challenge unresolved after reload')
            }
          } catch (err) {
            logger.error('page was not loaded by load or domcontentloaded', {error: err, url})
          }
        }

        // Ensure DOM is at least parsed and <body> attached/visible before proceeding.
        try {
          await page.waitForLoadState('domcontentloaded', { timeout: 45000 })
        } catch (e) {
          logger.warn('domcontentloaded wait skipped/failed', { error: e?.message || String(e) })
        }

        try {
          await page.waitForSelector('body', { state: 'visible', timeout: 20000 })
        } catch (e) {
          logger.warn('Body not visible after navigation; retrying with attached', { error: e?.message || String(e) })
          try {
            await page.waitForSelector('body', { state: 'attached', timeout: 10000 })
          } catch (e2) {
            logger.warn('Body not attached after navigation', { error: e2?.message || String(e2) })
          }
        }

        logger.debug('page loaded done')

        // Disable animation / transition (exclude diff from animation)
        logger.debug('disable css animation')

        await safeAddStyleTag(page, {
          content: `
            /* Disable animations for deterministic VRT */
            *, *::after, *::before {
              transition-delay: 0s !important;
              transition-duration: 0s !important;
              animation-delay: -0.0001s !important;
              animation-duration: 0s !important;
              animation-play-state: paused !important;
              caret-color: transparent !important;
              color-adjust: exact !important;
            }
            /* Preserve site font choices; do not override font-family */
            html, body { -webkit-text-size-adjust: 100%; }
          `
        }).catch((e) => logger.warn('Failed to add style tag to disable animation', {error: e}))

        try {
          ensureOpen(page, 'disableGifAnimation');
          await disableGifAnimation(page)
        } catch (e) {
          logger.warn('Failed to disable GIF animation', {error: e})
        }

        if (!page.isClosed()) {
          await page.setViewportSize({width: parseInt(jobItem.breakpoint), height: 1000})
        }
        logger.debug('page.goto done')

        // Align with root: wait for fonts and readyState, add short settle delay
        try { await safeEval(page, () => document.fonts && document.fonts.ready, undefined, 'fonts.ready gate') } catch (_) {}
        await safeWaitForFunction(page, () => document.readyState === 'complete', undefined, 'readyState complete');
        try { await page.waitForTimeout(1000) } catch (_) {}

        // Align with root: avoid extra stabilization phases for parity

        // @see https://github.com/ygerasimov/diffy-pm/issues/250 (wp-rocket fix)
        await safeEval(page, () => {
          try {
            window.dispatchEvent(new Event('touchstart'));
            window.document.dispatchEvent(new Event('touchstart'));
          } catch (e) {
          }
        }, undefined, 'wp-rocket-fix');

        await func.addCssCode(page, jobItem)
        logger.debug('addCssCode done')

        // #see https://github.com/ygerasimov/diffy-pm/issues/339
        if (Object.hasOwn(jobItem, 'project_id') && jobItem.project_id === 20882) {
          await func.cutElements(page, jobItem)
        }

        await func.autoScroll(page, jobItem)
        logger.debug('autoScroll done')

        let stabilizationSnippetResult = null
        if (Object.hasOwn(jobItem.args, 'stabilization') && jobItem.args.stabilization) {
          stabilizationSnippetResult = await runStabilizationSnippet(page, jobItem.args.stabilization_code)
          logger.debug('stabilization snippet executed', {
            executed: stabilizationSnippetResult?.executed,
            error: stabilizationSnippetResult?.error,
          })
        }

        const initialViewportHeight = await func.updatePageViewport(page, jobItem, maxPageHeight)
        logger.debug('updatePageViewport done', {page_height: initialViewportHeight})

        if (Object.hasOwn(jobItem.args, 'stabilization') && jobItem.args.stabilization) {
          await page.evaluate(async () => {

            const stabilizeHeight = async (elementsHeights, level) => {
              for (const element of elementsHeights) {
                if (document.body.contains(element.node)) {
                  if (
                      element.height !== element.node.offsetHeight &&
                      element.viewportRatio >= 0.40
                  ) {
                    element.node.style.height = element.height + 'px'
                    element.node.style.maxHeight = element.height + 'px'
                    element.node.style.minHeight = element.height + 'px'

                    if (element.node.scrollHeight === element.node.offsetHeight) {
                      continue
                    }
                  }

                  if (element.childNodes.length) {
                    await stabilizeHeight(element.childNodes, level + 1)
                  }
                }
              }
            }

            await stabilizeHeight(window.diffyElementsHeights ?? [], 1);
          })

          // hide google maps
          await func.hideBanners(page, {args: {elements: ['iframe[src*="google.com/maps"]']}})
        }

        await func.delayBeforeScreenshot(page, jobItem)

        await func.addJsCode(page, jobItem)
        logger.debug('addJsCode done')

        logger.debug('delayBeforeScreenshot done')
        ensureOpen(page, 'cutElements')
        const is_cut = await func.cutElements(page, jobItem)
        if (is_cut) {
          // We need decrease height after cut.
          if (!page.isClosed()) {
            await page.setViewportSize({width: parseInt(jobItem.breakpoint), height: 100})
            await func.updatePageViewport(page, jobItem, maxPageHeight)
          }
        }
        logger.debug('cutElements done')

        await func.addFixtures(page, jobItem)
        logger.debug('addFixtures done')

        await func.hideBanners(page, jobItem)
        logger.debug('hideBanners done')

        // Recalculate page height after modifications.
        if (!page.isClosed()) {
          await page.setViewportSize({width: parseInt(jobItem.breakpoint), height: 100})
          await func.updatePageViewport(page, jobItem, maxPageHeight)
        }

        await func.autoScroll(page, jobItem)
        logger.debug('double autoScroll done')

        // Skip lazy image promotion and extra stabilization to mirror root behavior

        const takeoverHeight = await page.evaluate(() => {
          let maxHeight = Math.max(
              document.documentElement?.scrollHeight || 0,
              document.body?.scrollHeight || 0,
              document.documentElement?.offsetHeight || 0,
              document.body?.offsetHeight || 0,
              document.documentElement?.clientHeight || 0,
              document.body?.clientHeight || 0,
              window.innerHeight || 0,
          )

          if (window.visualViewport) {
            const vv = window.visualViewport
            maxHeight = Math.max(maxHeight, Math.ceil((vv.pageTop || 0) + vv.height))
          }

          const elements = Array.from(document.querySelectorAll('*'))
          for (const el of elements) {
            const rect = el.getBoundingClientRect()
            if (!rect) continue
            const computed = window.getComputedStyle(el)
            const marginBottom = parseFloat(computed.marginBottom || '0')
            const localBottom = rect.bottom + window.scrollY + (Number.isFinite(marginBottom) ? marginBottom : 0)
            if (Number.isFinite(localBottom)) {
              maxHeight = Math.max(maxHeight, Math.ceil(localBottom))
            }
          }

          return Math.max(0, Math.ceil(maxHeight))
        })

        const normalizedHeight = Math.min(takeoverHeight, maxPageHeight)
        const pageHeight = await func.updatePageViewport(page, jobItem, normalizedHeight)

        data.pageArea = pageHeight * jobItem.breakpoint

        logger.debug('updatePageViewport done')

        const is_crop = await func.cropElement(page, jobItem)

        logger.debug('cropElement done')

        const filenameKey = Math.floor(Date.now() / 1000) + '-' + (func.random(0, 999999999)).toString()
        let filename = '/tmp/screenshot-' + filenameKey + '.png'

        const htmlFilename = '/tmp/html-' + filenameKey + '.html'

        let mhtmlFilename = '';
        if (Object.hasOwn(jobItem, 'mhtml') && jobItem.mhtml) {
          try {
            const bt = page.context()?.browser()?.browserType?.()
            const name = typeof bt?.name === 'function' ? bt.name() : null
            if (name === 'chromium') {
              mhtmlFilename = '/tmp/mhtml-' + filenameKey + '.mhtml'
            } else {
              logger.info('MHTML requested but unsupported by browser; skipping')
            }
          } catch (_) {
            logger.info('MHTML requested; browser type unknown; skipping')
          }
        }

        const jsConsoleFilename = '/tmp/jsConsole-' + filenameKey + '.json'
        let thumbnailFilepath = filename.replace('.png', '-thumbnail.png')

        logger.debug('start screenshot')

        // Take deterministic full-page screenshot of the entire scrollable height
        // without introducing extra transparent padding.
        // Notes:
        // - Use fullPage: true to stitch the entire document height.
        // - Set omitBackground: false to ensure opaque output and avoid
        //   compositing differences.
        // - Ensure the page finished layout after updates by forcing a sync reflow.
        if (page.isClosed()) throw new Error('Page closed before capture')
        ensureOpen(page, 'pre-capture reflow')
        await page.evaluate(() => {
          // Force a reflow to settle layout before capture
          void document.body.offsetHeight;
        });

        if (page.isClosed()) throw new Error('Page closed before capture')
        await page.waitForTimeout(150)

        if (page.isClosed()) throw new Error('Page closed before capture')

        const animationsSetting = jobItem?.args?.stabilization ? 'disabled' : undefined
        const screenshotTimeoutEnvValue =
            process.env.PLAYWRIGHT_SCREENSHOT_TIMEOUT_MS ??
            process.env.PLAYWRIGHT_SCREENSHOT_TIMEOUT ??
            process.env.SCREENSHOT_TIMEOUT_MS ??
            process.env.SCREENSHOT_TIMEOUT
        const screenshotTimeoutMs = coerceTimeoutMs(
            screenshotTimeoutEnvValue,
            DEFAULT_SCREENSHOT_TIMEOUT_MS
        )

        const captureViewportOnly = async (reason, extra = {}) => {
          ensureOpen(page, 'viewport-only capture')

          try {
            await page.evaluate(() => window.scrollTo(0, 0))
          } catch (_) {}

          try {
            await page.setViewportSize(baseViewport)
          } catch (_) {}

          await page.waitForTimeout(50)

          const viewportSize = typeof page.viewportSize === 'function'
              ? page.viewportSize()
              : baseViewport

          logger.warn(reason, {
            ...extra,
            viewportWidth: viewportSize?.width,
            viewportHeight: viewportSize?.height,
            fallback: 'viewport-only',
          })

          const viewportScreenshotOptions = {
            path: filename,
            fullPage: false,
            omitBackground: false,
            timeout: screenshotTimeoutMs,
          }

          if (animationsSetting) {
            viewportScreenshotOptions.animations = animationsSetting
          }

          await screenshotWithAdaptiveTimeout(
              page,
              viewportScreenshotOptions,
              'viewport-only screenshot',
              {
                ...extra,
                reason,
              }
          )

          if (viewportSize?.width && viewportSize?.height) {
            data.pageArea = viewportSize.width * viewportSize.height
          }
        }

        // Single-shot capture like root: viewport already expanded to full page height
        try {
          const screenshotOptions = {
            path: filename,
            fullPage: false,
            omitBackground: false,
            timeout: screenshotTimeoutMs,
          }

          if (animationsSetting) {
            screenshotOptions.animations = animationsSetting
          }

          await screenshotWithAdaptiveTimeout(
              page,
              screenshotOptions,
              'single-shot screenshot',
              { pageHeight, timeoutMs: screenshotTimeoutMs }
          )
        } catch (err) {
          const message = err && Object.hasOwn(err, 'message') ? err.message : String(err)
          await captureViewportOnly('Single-shot capture failed; captured visible area instead.', {
            pageHeight,
            error: message,
          })
        }

        logger.debug('screenshot done')
        const pageHtml = await func.getPageHtml(page)
        logger.debug('pageHtml done')

        let pageMhtml = ''
        if (mhtmlFilename) {
          pageMhtml = await func.getPageMhtml(page)
          logger.debug('pageMhtml done', {jobItem})
        }

        if (is_crop) {
          await thumbnail.crop(filename, is_crop)
          data.pageArea = is_crop.height * is_crop.width
        }

        if (page && !page.isClosed()) {
          await page.close()
        }
        logger.debug('page close done')
        page = null

        if (context) {
          await context.close();
          logger.debug('context close done');
          context = null;
        }

        // check webp format
        const screenshotSize = await func.getImageSize(filename)
        let webpWasUsed = false

        if (screenshotSize.height < 16000 && screenshotSize.width < 16000) {
          const filenameWebp = filename.replace('.png', '.webp')

          await thumbnail.webp(filename, filenameWebp)

          filename = filenameWebp
          thumbnailFilepath = thumbnailFilepath.replace('.png', '.webp')

          webpWasUsed = true
        }

        logger.debug('screenshot created')

        if (jobItem.local) {
          const fs = require('node:fs');
          try {
            fs.writeFileSync(htmlFilename, pageHtml);
          } catch (err) {
            logger.error('Failed to write file', {error: err});
          }

          if (mhtmlFilename) {
            try {
              fs.writeFileSync(mhtmlFilename, pageMhtml);
            } catch (err) {
              logger.error('Failed to write MHTML file', {error: err});
            }
          }

          try {
            fs.writeFileSync(jsConsoleFilename, JSON.stringify(jsConsole));
          } catch (err) {
            logger.error('Failed to write file', {error: err});
          }

          return {
            screenshot: filename,
            html: htmlFilename,
            mhtml: mhtmlFilename,
            jsConsole: jsConsoleFilename
          }
        }

        const s3Url = await uploadS3.upload(filename).catch((err) => {
          logger.error('Failed to upload file to S3', {error: err});
          throw new Error('Can\'t upload screenshot: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
        })

        logger.debug('uploadS3 done')

        await thumbnail.generateImageThumbnail(filename, thumbnailFilepath).catch((err) => {
          throw new Error('Can\'t generate thumbnail: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
        })

        logger.debug('generateImageThumbnail done')

        const s3UrlThumbnail = await uploadS3.upload(thumbnailFilepath).catch((err) => {
          throw new Error('Can\'t upload thumbnail: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
        })

        logger.debug('uploadS3Thumbnail done')

        const s3HtmlUrl = await uploadS3.uploadFileString(htmlFilename, pageHtml).catch((err) => {
          throw new Error('Can\'t upload html file: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
        })

        logger.debug('uploadHtmlFileString done')

        let s3MhtmlUrl = ''

        if (mhtmlFilename) {
          s3MhtmlUrl = await uploadS3.uploadFileString(mhtmlFilename, pageMhtml).catch((err) => {
            throw new Error('Can\'t upload mhtml file: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
          })

          logger.debug('uploadMhtmlFileString done', {job_item: jobItem})
        }

        const s3JsConsoleUrl = await uploadS3.uploadFileString(jsConsoleFilename, JSON.stringify(jsConsole)).catch((err) => {
          throw new Error('Can\'t upload jsConsole file: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
        })

        logger.debug('uploadJsConsoleFileString done')

        // Not need to remove "htmlFilename/mhtmlFilename" because we use stream and not creating real file.
        // Async remove files.
        await func.removeFile(filename)
        await func.removeFile(thumbnailFilepath)

        if (webpWasUsed) {
          await func.removeFile(filename.replace('.webp', '.png'))
        }

        return sendResult(job, jobItem, {
          'full': s3Url,
          'thumbnail': s3UrlThumbnail,
          'html': s3HtmlUrl,
          'mhtml': s3MhtmlUrl,
          'jsConsole': s3JsConsoleUrl,
          'data': data,
          'log_data': '',
          'status': response ? response.status() : null,
        })
      } catch (err) {
        logger.error('perform error:', {error: err})

        if (page) {
          try {
            await page.close()
          } catch (e) {
            logger.error('Failed to close page', {error: e})
          }
          page = null
        }

        if (context) {
          try {
            await context.close()
          } catch (e) {
            logger.error('Failed to close context', {error: e})
          }
          context = null
        }

        // Retry once for transient target/session closed errors
        const msg = (err && Object.hasOwn(err, 'message')) ? err.message : err.toString()
        lastErr = msg
        const transient = /Target closed|Session closed|Protocol error/.test(msg)
        if (attempt < maxAttempts && transient) {
          logger.warn('Retrying after transient closure', {attempt, msg})
          continue
        }
        return sendError(job, msg, jobItem)
      }
      return sendError(job, lastErr || 'Unknown error', jobItem)
    }
  },

  saveError: async (job, jobItem, errorText) => {
    return saveError(job, jobItem, errorText)
  },

  saveTimeoutError: async (job, jobItem) => {
    return saveError(job, jobItem, 'Timeout error: too big page, or too big resources on the page.')
  },
}
