const uploadS3 = require('./uploadS3.js')
const thumbnail = require('./thumbnail.js')
const func = require('./func.js')
const logger = require('./logger')
const LAYOUT_STABILITY_DEFAULT_TIMEOUT_MS = 6000
const LAYOUT_STABILITY_DEFAULT_QUIET_WINDOW_MS = 300
const IMAGE_STABILITY_TIMEOUT_MS = 5000
const FONT_STABILITY_TIMEOUT_MS = 7000

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

        const contextOptions = {
          viewport: baseViewport,
          bypassCSP: true,
          ignoreHTTPSErrors: true,
          userAgent: headerConfig.userAgent,
          deviceScaleFactor: (Object.hasOwn(jobItem.args, 'retina_images') && jobItem.args.retina_images) ? 2 : 1,
          locale: headerConfig.locale,
          timezoneId: headerConfig.timezoneId,
          hasTouch: (headerConfig.clientHints?.maxTouchPoints ?? 0) > 1,
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
        await func.setHeaders(context, jobItem, headerConfig);
        page = await context.newPage();

        if (Object.hasOwn(jobItem.args, 'night_mode') && jobItem.args.night_mode) {
          await page.emulateMedia({colorScheme: 'dark'});
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

        let response;

        try {
          await page.waitForTimeout(func.random(120, 380));
          response = await page.goto(url, {waitUntil: 'networkidle'})

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
          logger.warn('page was not loaded by networkidle', {url})

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

        logger.debug('page loaded done')

        // Disable animation / transition (exclude diff from animation)
        logger.debug('disable css animation')

        await safeAddStyleTag(page, {
          content: `
            *, *::after, *::before {
              transition-delay: 0s !important;
              transition-duration: 0s !important;
              animation-delay: -0.0001s !important;
              animation-duration: 0s !important;
              animation-play-state: paused !important;
              caret-color: transparent !important;
              color-adjust: exact !important;
            }
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

        await safeWaitForFunction(page, () => document.readyState === 'complete', undefined, 'readyState complete');

        const stabilitySummary = await waitForVisualStability(page)
        logger.debug('visual stabilization complete', stabilitySummary)

        const fontReadyInitial = await waitForFontFaces(page)
        logger.debug('font readiness after initial stabilization', fontReadyInitial)

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

        const stabilizationEnabled = Boolean(Object.hasOwn(jobItem.args, 'stabilization') && jobItem.args.stabilization)

        if (stabilizationEnabled) {
          await (async () => {
            await eval(jobItem.args.stabilization_code);
          })();

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
        }

        const initialViewportHeight = await func.updatePageViewport(page, jobItem, maxPageHeight)
        logger.debug('updatePageViewport done', {page_height: initialViewportHeight})

        if (stabilizationEnabled) {
          const googleMapSelectors = ['iframe[src*="google.com/maps"]']
          logger.debug('Attempting to hide Google Maps iframes', { selectors: googleMapSelectors })
          try {
            await page.evaluate((selectors) => {
              selectors.forEach((selector) => {
                if (typeof selector !== 'string') {
                  return
                }
                document.querySelectorAll(selector).forEach((node) => {
                  try {
                    if (!node.dataset) {
                      node.dataset = {}
                    }
                    node.dataset.diffyMaskOverlay = 'true'
                  } catch (_) {}
                })
              })
            }, googleMapSelectors)

            const mapMaskResult = await func.hideBanners(page, {
              args: {
                elements: googleMapSelectors
              }
            })

            const maskStats = {
              maskedSelectors: mapMaskResult?.maskedSelectors ?? 0,
              maskedElements: mapMaskResult?.maskedElements ?? 0,
            }

            if (maskStats.maskedElements > 0) {
              logger.info('Google Maps mask applied', maskStats)
            } else {
              logger.warn('Google Maps mask applied but no elements were hidden', maskStats)
            }
          } catch (mapMaskErr) {
            logger.error('Failed to hide Google Maps iframes', { error: mapMaskErr })
          }
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

        try {
          await safeEval(page, () => {
            const images = Array.from(document.querySelectorAll('img'))
            for (const img of images) {
              try {
                if (img.loading === 'lazy') {
                  img.loading = 'eager'
                }
                if (img.getAttribute('loading') === 'lazy') {
                  img.setAttribute('loading', 'eager')
                }

                if (!img.getAttribute('src')) {
                  const lazySrc = img.getAttribute('data-src') ||
                    img.getAttribute('data-lazy-src') ||
                    img.getAttribute('data-original') ||
                    img.dataset?.src ||
                    img.dataset?.original

                  if (lazySrc) {
                    img.setAttribute('src', lazySrc)
                  }
                }

                if (!img.getAttribute('srcset')) {
                  const lazySrcset = img.getAttribute('data-srcset') ||
                    img.getAttribute('data-lazy-srcset') ||
                    img.getAttribute('data-src-set') ||
                    img.dataset?.srcset

                  if (lazySrcset) {
                    img.setAttribute('srcset', lazySrcset)
                  }
                }
              } catch (_) {
              }
            }
          }, undefined, 'promote lazy-loaded images')
        } catch (error) {
          logger.warn('Failed to promote lazy images', { error: error?.message || String(error) })
        }

        const postScrollStability = await waitForVisualStability(page, {
          totalTimeoutMs: Math.max(LAYOUT_STABILITY_DEFAULT_TIMEOUT_MS, 12000),
          quietWindowMs: Math.max(LAYOUT_STABILITY_DEFAULT_QUIET_WINDOW_MS, 400),
        })
        const fontReadyFinal = await waitForFontFaces(page)

        logger.debug('post-scroll visual stabilization complete', {
          postScrollStability,
          fontReadyFinal,
        })


        const pageHeight = await func.updatePageViewport(page, jobItem, maxPageHeight)

        data.pageArea = pageHeight * jobItem.breakpoint

        logger.debug('updatePageViewport done')

        const is_crop = await func.cropElement(page, jobItem)

        logger.debug('cropElement done')

        const filenameKey = Math.floor(Date.now() / 1000) + '-' + (func.random(0, 999999999)).toString()
        let filename = '/tmp/screenshot-' + filenameKey + '.png'

        const htmlFilename = '/tmp/html-' + filenameKey + '.html'

        let mhtmlFilename = '';
        if (Object.hasOwn(jobItem, 'mhtml') && jobItem.mhtml) {
          mhtmlFilename = '/tmp/mhtml-' + filenameKey + '.mhtml'
        }

        const jsConsoleFilename = '/tmp/jsConsole-' + filenameKey + '.json'
        let thumbnailFilepath = filename.replace('.png', '-thumbnail.png')

        logger.debug('start screenshot')

        await page.screenshot({
          path: filename,
          captureBeyondViewport: false,
        })

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
