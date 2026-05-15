const uploadS3 = require('./uploadS3.js')
const thumbnail = require('./thumbnail.js')
const func = require('./func.js')
const logger = require('./logger')
const sharp = require('sharp')

const SCREENSHOT_TILE_HEIGHT = 8000

const formatLoggedError = (error) => {
  if (!error) {
    return { message: 'Unknown error' }
  }

  if (typeof error === 'string') {
    return { message: error }
  }

  const details = {
    name: error.name || 'Error',
    message: error.message || String(error)
  }

  if (error.stack) {
    details.stack = error.stack
  }

  if (Object.hasOwn(error, 'code')) {
    details.code = error.code
  }

  return details
}

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

const captureTiledScreenshot = async (page, filename, width, height, scale) => {
  const client = await page.context().newCDPSession(page)
  const composites = []
  const tileHeightLimit = Math.max(1, Math.floor(SCREENSHOT_TILE_HEIGHT / scale))

  for (let top = 0; top < height; top += tileHeightLimit) {
    const tileHeight = Math.min(tileHeightLimit, height - top)
    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: top,
        width,
        height: tileHeight,
        scale
      }
    })

    composites.push({
      input: Buffer.from(screenshot.data, 'base64'),
      left: 0,
      top: Math.round(top * scale)
    })
  }

  await sharp({
    create: {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .composite(composites)
    .png()
    .toFile(filename)
}

const captureScreenshot = async (page, filename, isWebkit) => {
  try {
    await page.screenshot({
      path: filename,
      captureBeyondViewport: false,
    })
    return
  } catch (error) {
    if (isWebkit) {
      throw error
    }

    logger.warn('single screenshot failed, falling back to tiled screenshot', {
      error: error?.message || String(error)
    })
  }

  const viewport = page.viewportSize()
  const width = viewport?.width || await page.evaluate(() => window.innerWidth)
  const height = viewport?.height || await page.evaluate(() => window.innerHeight)
  const scale = await page.evaluate(() => window.devicePixelRatio || 1)

  try {
    await captureTiledScreenshot(page, filename, width, height, scale)
    logger.info('tiled screenshot captured', {
      width,
      height,
      scale,
      tileHeight: SCREENSHOT_TILE_HEIGHT
    })
  } catch (error) {
    logger.warn('tiled screenshot failed, falling back to single viewport screenshot', {
      error: error?.message || String(error),
      width,
      height,
      scale
    })

    await page.screenshot({
      path: filename,
      captureBeyondViewport: false,
    })
  }
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

        const cleared = await pollUntil(page, () => !document.querySelector('iframe#main-iframe'), {
          timeoutMs: 10000,
          intervalMs: 200,
          label: 'Incapsula iframe removal',
        }).catch(() => false)

        if (cleared) {
          logger.info('Incapsula iframe cleared. Proceeding...');
          return;
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
      throw new Error('Can\'t upload screenshot: ' + err.name + ': ' + ((err && Object.hasOwn(err, 'message')) ? err.message : err))
    })

    await thumbnail.generateImageThumbnail(filename, thumbnailFilepath).catch((err) => {
      throw new Error('Can\'t generate thumbnail: ' + err.name + ': ' + ((err && Object.hasOwn(err, 'message')) ? err.message : err))
    })

    const s3UrlThumbnail = await uploadS3.upload(thumbnailFilepath).catch((err) => {
      throw new Error('Can\'t upload thumbnail: ' + err.name + ': ' + ((err && Object.hasOwn(err, 'message')) ? err.message : err))
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
      'data': 'Error: Can\'t generate error image. ' + errorText + ' => ' + ((err && Object.hasOwn(err, 'message')) ? err.message : err),
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

const safeAddStyleTag = async (page, opts, label = 'addStyleTag') => {
  ensureOpen(page, label)
  return page.addStyleTag(opts)
}

const pollUntil = async (page, predicate, {
  timeoutMs = 5000,
  intervalMs = 200,
  predicateArg,
  label = 'condition',
} = {}) => {
  ensureOpen(page, label)
  const endTime = Date.now() + timeoutMs

  while (Date.now() < endTime) {
    const result = await safeEval(page, predicate, predicateArg, `${label} evaluate`)
    if (result) {
      return true
    }

    const delay = Math.min(intervalMs, Math.max(0, endTime - Date.now()))
    if (delay > 0) {
      await page.waitForTimeout(delay)
    }
    ensureOpen(page, `${label} wait`)
  }

  throw new Error(`Timeout waiting for ${label}`)
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
      let page;
      let jsConsole = [];
      const maxPageHeightIfError = 50000;

      try {
        const maxPageHeight = (Object.hasOwn(job, 'attempts') && job.attempts > 0) ? (maxPageHeightIfError / job.attempts) : maxPageHeightIfError

        const viewportWidth = parseInt(jobItem.breakpoint) || 800;
        const baseViewport = { width: viewportWidth, height: 1000 };
        const recademicsMobileStabilizationEnabled = (
          Object.hasOwn(jobItem, 'project_id') &&
          jobItem.project_id === 26297 &&
          viewportWidth <= 480
        );
        const headerState = await func.buildHeaderState(jobItem);
        const userAgentString = headerState.userAgentString;

        const hasBasicAuth = (
            Object.hasOwn(jobItem, 'basicAuth') && jobItem.basicAuth &&
            Object.hasOwn(jobItem.basicAuth, 'user') && jobItem.basicAuth.user &&
            Object.hasOwn(jobItem.basicAuth, 'password') && jobItem.basicAuth.password
        );

        page = await browser.newPage({
          viewport: baseViewport,
          bypassCSP: true,
          ignoreHTTPSErrors: true,
          userAgent: userAgentString,
          deviceScaleFactor: (Object.hasOwn(jobItem.args, 'retina_images') && jobItem.args.retina_images) ? 2 : 1,
          locale: 'en-US',
          timezoneId: 'UTC',
          hasTouch: false,
          ...(hasBasicAuth ? {
            httpCredentials: {
              username: jobItem.basicAuth.user,
              password: jobItem.basicAuth.password,
            }
          } : {}),
        });

        const isWebkit = browser.browserType().name() === 'webkit';

        const browserContext = page.context();
        await func.setHeaders(page, jobItem, headerState);

        if (Object.hasOwn(jobItem.args, 'night_mode') && jobItem.args.night_mode) {
          await page.emulateMedia({colorScheme: 'dark'});
        }

        logger.debug('browser.newPage', {jobItem})

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
              type: 'error',
              text: String(e),
              location: {},
            }
          }

          jsConsole.push(consoleMes)
        })

        await browserContext.clearCookies();
        logger.debug('setHeaders prepared', {
          userAgent: userAgentString,
          extraHeaders: headerState?.headers || {}
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
        if (hasBasicAuth) {
          const baseUrlIsHttp = url.startsWith('http://');
          basicAuthRouteConfig = {
            header: `Basic ${Buffer.from(`${jobItem.basicAuth.user}:${jobItem.basicAuth.password}`).toString('base64')}`,
            targetHost: (() => {
              try {
                return new URL(jobItem.base_url).host;
              } catch (e) {
                return null;
              }
            })(),
            downgradeToHttp: baseUrlIsHttp
          };

          page.on('response', async (res) => {
            const status = res.status();
            const resUrl = res.url();

            if (status === 401) {
              try {
                const body = await res.text();
                logger.debug('[401 Response]', resUrl, body.slice(0, 300));
              } catch (e) {
                // Page/context may have closed before we could read the body
                logger.debug('[401 Response]', resUrl, '(body unavailable - page closed)');
              }
            }

            if (status >= 300 && status < 400) {
              logger.debug('[REDIRECT]', status, '→', res.headers()['location']);
            }
          });
        }

        const deterrenceState = headerState?.deterrenceBypass
        const selectiveHeaderRoutingEnabled = callRailBlockEnabled || basicAuthRouteConfig || deterrenceState?.enabled

        if (selectiveHeaderRoutingEnabled) {
          await page.route('**/*', async (route) => {
            const request = route.request();
            const requestUrl = request.url();

            if (callRailBlockEnabled) {
              try {
                if (/swap_session\.json/i.test(new URL(requestUrl).pathname)) {
                  route.abort().catch((error) => {
                    logger.warn('Failed to abort blocked request', { error, requestUrl });
                  });
                  return;
                }
              } catch (_) {}
            }

            let headersOverride = null;
            let overriddenUrl = requestUrl;

            const ensureHeadersCopy = () => {
              if (!headersOverride) {
                headersOverride = { ...request.headers() };
              }
              return headersOverride;
            };

            if (basicAuthRouteConfig) {
              const reqHost = (() => { try { return new URL(requestUrl).host; } catch (_) { return null; } })();
              const hostMatches = !basicAuthRouteConfig.targetHost || reqHost === basicAuthRouteConfig.targetHost;
              if (hostMatches) {
                const headers = ensureHeadersCopy();
                headers.Authorization = basicAuthRouteConfig.header;
              }

              // Only downgrade HTTPS to HTTP when the base URL was originally HTTP
              if (basicAuthRouteConfig.downgradeToHttp) {
                try {
                  const host = new URL(requestUrl).host;
                  if (host && basicAuthRouteConfig.targetHost && host === basicAuthRouteConfig.targetHost) {
                    overriddenUrl = overriddenUrl.replace(/^https:/, 'http:');
                  }
                } catch (_) {}
              }
            }

            if (deterrenceState && func.shouldApplyDeterrenceHeader(deterrenceState, requestUrl, request.resourceType())) {
              const headers = ensureHeadersCopy();
              headers[deterrenceState.headerName] = deterrenceState.headerValue;
            }

            const hasHeaderOverrides = headersOverride && Object.keys(headersOverride).length > 0;
            const needsUrlOverride = overriddenUrl !== requestUrl;

            const continueWithLogging = async (options) => {
              try {
                await route.continue(options);
              } catch (error) {
                logger.warn('Failed to continue request', {
                  requestUrl,
                  requestMethod: request.method(),
                  resourceType: request.resourceType(),
                  isNavigationRequest: typeof request.isNavigationRequest === 'function'
                    ? request.isNavigationRequest()
                    : undefined,
                  overrides: {
                    headerKeys: headersOverride ? Object.keys(headersOverride) : [],
                    urlChanged: Boolean(options && options.url && options.url !== requestUrl),
                  },
                  error: formatLoggedError(error)
                });
              }
            };

            const headerOverrideOptions = hasHeaderOverrides ? { headers: headersOverride } : undefined;

            if (!needsUrlOverride) {
              await continueWithLogging(headerOverrideOptions);
              return;
            }

            let originalProtocol;
            let overrideProtocol;
            try {
              originalProtocol = new URL(requestUrl).protocol;
              overrideProtocol = new URL(overriddenUrl).protocol;
            } catch (error) {
              logger.warn('Failed to parse URLs for override; continuing without URL change', {
                requestUrl,
                attemptedUrl: overriddenUrl,
                error: formatLoggedError(error)
              });
              await continueWithLogging(headerOverrideOptions);
              return;
            }

            if (originalProtocol === overrideProtocol) {
              await continueWithLogging({
                ...headerOverrideOptions,
                url: overriddenUrl
              });
              return;
            }

            const fetchHeaders = hasHeaderOverrides ? headersOverride : request.headers();
            const requestMethod = request.method();
            const postData = request.postData();

            const fetchOptions = {
              url: overriddenUrl,
              headers: fetchHeaders,
              ...(requestMethod && requestMethod !== 'GET' ? { method: requestMethod } : {}),
              ...(postData ? { postData } : {})
            };

            let fetchResponse;
            try {
              fetchResponse = await route.fetch(fetchOptions);
            } catch (error) {
              logger.warn('Failed to fetch overridden protocol request; falling back to original URL', {
                requestUrl,
                attemptedUrl: overriddenUrl,
                requestMethod,
                resourceType: request.resourceType(),
                error: formatLoggedError(error)
              });
              await continueWithLogging(headerOverrideOptions);
              return;
            }

            try {
              await route.fulfill({ response: fetchResponse });
            } catch (error) {
              logger.warn('Failed to fulfill fetched response; continuing without URL override', {
                requestUrl,
                attemptedUrl: overriddenUrl,
                requestMethod,
                resourceType: request.resourceType(),
                error: formatLoggedError(error)
              });
              await continueWithLogging(headerOverrideOptions);
            }
          });
        }

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
          await browserContext.addCookies(cookies)
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
          logger.debug('page was not loaded by networkidle')

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
            logger.warn('page was not loaded by load or domcontentloaded', {error: err, url})
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
          await page.waitForTimeout(1000)
        }
        logger.debug('page.goto done')

        await safeEval(page, async () => {
          if (!document.fonts || typeof document.fonts.ready?.then !== 'function') {
            return null
          }

          await document.fonts.ready
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        }, undefined, 'fonts.ready wait')
        await pollUntil(page, () => document.readyState === 'complete', {
          timeoutMs: 30000,
          intervalMs: 250,
          label: 'document.readyState === complete',
        }).catch((error) => {
          logger.warn('document.readyState wait failed', {error});
        })
        await page.waitForTimeout(1000)

        // @see https://github.com/ygerasimov/diffy-pm/issues/250 (wp-rocket fix)
        try {
          await safeEval(page, () => {
            try {
              window.dispatchEvent(new Event('touchstart'));
              window.document.dispatchEvent(new Event('touchstart'));
            } catch (e) {
            }
          }, undefined, 'wp-rocket-fix');
        } catch (e) {
          logger.warn('wp-rocket-fix evaluate failed (page may have navigated)', { error: e?.message || String(e) })
        }

        await func.addCssCode(page, jobItem)
        logger.debug('addCssCode done')

        const stretchedImagesStabilizationEnabled = Boolean(jobItem.args?.stretched_images_stabilization)

        // Fix for project 26297 (recademics.com): Elementor motion-effects backgrounds
        if (recademicsMobileStabilizationEnabled) {
          await safeAddStyleTag(page, {
            content: `
              .elementor-motion-effects-layer {
                transform: none !important;
                height: 100% !important;
              }
            `
          }).catch((e) => logger.warn('Failed to add motion effects fix for project 26297', { error: e }))
        }

        // #see https://github.com/ygerasimov/diffy-pm/issues/339
        if (Object.hasOwn(jobItem, 'project_id') && jobItem.project_id === 20882) {
          await func.cutElements(page, jobItem)
        }

        await func.autoScroll(page, jobItem)
        logger.debug('autoScroll done')

        if (stretchedImagesStabilizationEnabled && !page.isClosed()) {
          const recordedCount = await func.recordViewportRelativeHeights(page)
          logger.debug('recordViewportRelativeHeights done', { recordedCount })
        }

        ensureOpen(page, 'cutElements')
        let is_cut

        try {
          is_cut = await func.cutElements(page, jobItem)
        } catch (e) {
          logger.warn('is_cut execution failed', {
            is_cut,
            page_closed: page.isClosed(),
            url: jobItem.url,
            breakpoint: jobItem.breakpoint,
            error: e?.message || e
          })
        }

        if (is_cut && !page.isClosed()) {
          await page.setViewportSize({width: parseInt(jobItem.breakpoint), height: 100})
          await page.waitForTimeout(1000)
          if (!stretchedImagesStabilizationEnabled) {
            await func.updatePageViewport(page, jobItem, maxPageHeight)
          }
        }

        logger.debug('cutElements done')

        const stabilizationEnabled = Boolean(Object.hasOwn(jobItem.args, 'stabilization') && jobItem.args.stabilization)

        if (stretchedImagesStabilizationEnabled && stabilizationEnabled && !page.isClosed()) {
          await page.setViewportSize({width: parseInt(jobItem.breakpoint), height: 1000})
          await page.waitForTimeout(500)
        }

        if (stabilizationEnabled && Object.hasOwn(jobItem.args, 'stabilization_code') && jobItem.args.stabilization_code) {
          try {
            await (async () => {
              await eval(jobItem.args.stabilization_code);
            })();
          } catch (error) {
            logger.warn('stabilization_code execution failed', { error: error?.message || String(error) })
          }
        }

        const initialViewportHeight = await func.updatePageViewport(page, jobItem, maxPageHeight)
        logger.debug('updatePageViewport done', {page_height: initialViewportHeight})

        if (stretchedImagesStabilizationEnabled && !page.isClosed()) {
          const fixedCount = await func.fixViewportRelativeHeights(page)
          if (fixedCount > 0) {
            logger.info('Fixed viewport-relative stretched elements', { fixedCount })
          }
        }

        // Viewport height now equals the full page height, so every element is "in view".
        // Dispatch a synthetic scroll event so scroll-reveal libraries (AOS, ScrollReveal,
        // WOW.js, etc.) re-evaluate visibility and re-add their reveal classes to elements
        // that were reset to opacity:0 when we scrolled back to the top earlier.
        if (!page.isClosed()) {
          try {
            await page.evaluate(() => {
              window.dispatchEvent(new Event('scroll', { bubbles: true }))
              document.dispatchEvent(new Event('scroll', { bubbles: true }))
            })
            await page.waitForTimeout(300)
          } catch (e) {}
        }

        if (stabilizationEnabled) {
          try {
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
          } catch (e) {
            // Context may be destroyed if page navigates during stabilization
            logger.error('Stabilization evaluate failed (page may have navigated)', { error: e?.message || String(e) })
          }
        }

        await func.delayBeforeScreenshot(page, jobItem)
        logger.debug('delayBeforeScreenshot done')

        await func.addJsCode(page, jobItem)
        logger.debug('addJsCode done')

        await func.addFixtures(page, jobItem)
        logger.debug('addFixtures done')

        await func.hideBanners(page, jobItem)
        logger.debug('hideBanners done')

        if (!page.isClosed()) {
          await page.setViewportSize({width: parseInt(jobItem.breakpoint), height: 100})
          await page.waitForTimeout(1000)
          await func.updatePageViewport(page, jobItem, maxPageHeight)
        }

        await func.autoScroll(page, jobItem)
        logger.debug('double autoScroll done')

        let pageHeight = await func.updatePageViewport(page, jobItem, maxPageHeight)

        data.pageArea = pageHeight * jobItem.breakpoint

        logger.debug('updatePageViewport done')

        if (!page.isClosed()) {
          try {
            await page.evaluate(() => {
              window.dispatchEvent(new Event('scroll', { bubbles: true }))
              document.dispatchEvent(new Event('scroll', { bubbles: true }))
            })
            await page.waitForTimeout(300)
          } catch (e) {}
        }

        if (recademicsMobileStabilizationEnabled && !page.isClosed()) {
          await safeEval(page, () => {
            const snapToWholePixel = (element) => {
              const rect = element.getBoundingClientRect()
              const offset = Math.round(rect.top) - rect.top

              if (Math.abs(offset) < 0.01) {
                return
              }

              element.style.setProperty('position', 'relative', 'important')
              element.style.setProperty('top', `${offset}px`, 'important')
            }

            document.querySelectorAll('.e-n-accordion-item-title, .faq-text-block .elementor-widget-container')
              .forEach(snapToWholePixel)
          }, undefined, 'recademics faq text stabilization').catch((e) => {
            logger.warn('Failed to stabilize FAQ text for project 26297', { error: e })
          })

          try {
            await page.waitForTimeout(100)
          } catch (e) {}
        }

        if (stretchedImagesStabilizationEnabled && !page.isClosed()) {
          await page.setViewportSize({width: parseInt(jobItem.breakpoint), height: 100})
          await page.waitForTimeout(500)
          pageHeight = await func.updatePageViewport(page, jobItem, maxPageHeight)

          data.pageArea = pageHeight * jobItem.breakpoint
          logger.debug('final viewport recalculation after stabilization', {page_height: pageHeight})
        }

        const is_crop = await func.cropElement(page, jobItem)

        logger.debug('cropElement done')

        if (!page.isClosed()) {
          const stretchedElements = await func.detectStretchedElements(page)
          if (stretchedElements) {
            if (stretchedElements.images.length > 0) {
              logger.warn('Stretched images detected', {
                count: stretchedElements.images.length,
                images: stretchedElements.images,
              })
            }
            if (stretchedElements.backgroundImages.length > 0) {
              logger.warn('Stretched background images detected', {
                count: stretchedElements.backgroundImages.length,
                images: stretchedElements.backgroundImages,
              })
            }
          }
        }

        const filenameKey = Math.floor(Date.now() / 1000) + '-' + (func.random(0, 999999999)).toString()
        let filename = '/tmp/screenshot-' + filenameKey + '.png'

        const htmlFilename = '/tmp/html-' + filenameKey + '.html'

        let mhtmlFilename = '';
        if (Object.hasOwn(jobItem, 'mhtml') && jobItem.mhtml && !isWebkit) {
          mhtmlFilename = '/tmp/mhtml-' + filenameKey + '.mhtml'
        }

        const jsConsoleFilename = '/tmp/jsConsole-' + filenameKey + '.json'
        let thumbnailFilepath = filename.replace('.png', '-thumbnail.png')

        logger.debug('start screenshot')

        if (jobItem.project_id === 21292 && parseInt(jobItem.breakpoint) === 1440 && !page.isClosed()) {
          const hasScrollHash = await page.evaluate(() => window.location.hash === '#scroll')
          if (hasScrollHash) {
            await page.evaluate(() => {
              const scrollValue = 230
              window.scrollTo(0, scrollValue)

              if (document.scrollingElement) {
                document.scrollingElement.scrollTop = scrollValue
              }

              window.dispatchEvent(new Event('scroll', { bubbles: true }))
              document.dispatchEvent(new Event('scroll', { bubbles: true }))
            })
            await page.waitForTimeout(500)
          }
        }

        await captureScreenshot(page, filename, isWebkit)

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
          throw new Error('Can\'t upload screenshot: ' + err.name + ': ' + ((err && Object.hasOwn(err, 'message')) ? err.message : err))
        })

        logger.debug('uploadS3 done')

        await thumbnail.generateImageThumbnail(filename, thumbnailFilepath).catch((err) => {
          throw new Error('Can\'t generate thumbnail: ' + err.name + ': ' + ((err && Object.hasOwn(err, 'message')) ? err.message : err))
        })

        logger.debug('generateImageThumbnail done')

        const s3UrlThumbnail = await uploadS3.upload(thumbnailFilepath).catch((err) => {
          throw new Error('Can\'t upload thumbnail: ' + err.name + ': ' + ((err && Object.hasOwn(err, 'message')) ? err.message : err))
        })

        logger.debug('uploadS3Thumbnail done')

        const s3HtmlUrl = await uploadS3.uploadFileString(htmlFilename, pageHtml).catch((err) => {
          throw new Error('Can\'t upload html file: ' + err.name + ': ' + ((err && Object.hasOwn(err, 'message')) ? err.message : err))
        })

        logger.debug('uploadHtmlFileString done')

        let s3MhtmlUrl = ''

        if (mhtmlFilename) {
          s3MhtmlUrl = await uploadS3.uploadFileString(mhtmlFilename, pageMhtml).catch((err) => {
            throw new Error('Can\'t upload mhtml file: ' + err.name + ': ' + ((err && Object.hasOwn(err, 'message')) ? err.message : err))
          })

          logger.debug('uploadMhtmlFileString done', {job_item: jobItem})
        }

        const s3JsConsoleUrl = await uploadS3.uploadFileString(jsConsoleFilename, JSON.stringify(jsConsole)).catch((err) => {
          throw new Error('Can\'t upload jsConsole file: ' + err.name + ': ' + ((err && Object.hasOwn(err, 'message')) ? err.message : err))
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
        if (page) {
          try {
            await page.close()
          } catch (e) {
            logger.error('Failed to close page', { error: formatLoggedError(e) })
          }
          page = null
        }

        // Retry once for transient target/session closed errors
        const msg = (err && Object.hasOwn(err, 'message')) ? err.message : err.toString()
        lastErr = msg
        const transient = /Target closed|Session closed|Protocol error|Execution context was destroyed/.test(msg)
        if (attempt < maxAttempts && transient) {
          logger.warn('Retrying after transient closure', {attempt, msg})
          continue
        }
        logger.error('perform error:', { error: formatLoggedError(err) })
        return sendError(job, msg, jobItem)
      }
    }
  },

  saveError: async (job, jobItem, errorText) => {
    return saveError(job, jobItem, errorText)
  },

  saveTimeoutError: async (job, jobItem) => {
    return saveError(job, jobItem, 'Timeout error: too big page, or too big resources on the page.')
  },
}
