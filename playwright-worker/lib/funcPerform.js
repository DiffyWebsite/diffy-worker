const request = require('request') // @TODO use node http module
const uploadS3 = require('./uploadS3.js')
const thumbnail = require('./thumbnail.js')
const func = require('./func.js')
const logger = require('./logger')

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

// TODO Add Url checking into the process
const checkUrl = async (url, job) => {
  const options = {
    method: 'HEAD',
    rejectUnauthorized: false,
    requestCert: false,
    strictSSL: false,
    insecureHTTPParser: true,
    timeout: 20 * 1000,
    pool: { maxSockets: Infinity },
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.11; rv:46.0) Gecko/20100101 Firefox/46.0' },
  }

  if (func.checkArgs(job, 'headers', true)) {
    job.args.headers.forEach(item => {
      if (item.hasOwnProperty('header') && item.header) {
        if (item.header.toLowerCase() === 'user-agent' && item.hasOwnProperty('value') && item.value.length) {
          options.headers['user-agent'] = item.value;
        }

        if (item.header.toLowerCase() === 'x-vercel-protection-bypass') {
          options.headers['x-vercel-protection-bypass'] = item.value;
        }
      }
    });
  }

  if (
    job.hasOwnProperty('basicAuth') && job.basicAuth &&
    job.basicAuth.hasOwnProperty('user') && job.basicAuth.user &&
    job.basicAuth.hasOwnProperty('password') && job.basicAuth.password
  ) {
    options.auth = {
      user: job.basicAuth.user,
      pass: job.basicAuth.password
    }
  }

  let lastException;

  try {
    await checkURLRequest(url, options, job)
    return true
  } catch (e) {
    logger.error('Failed to checkUrl', { url, error: e });
    lastException = e;
  }

  try {
    options.method = 'GET'
    await checkURLRequest(url, options, job)
    return true
  } catch (e) {
    logger.error('Failed to checkUrl (GET)', { url, error: e });
    lastException = e;
  }

  if (job.args.url) {
    try {
      await checkURLRequest(job.args.url, options, job)
      return true
    } catch (e) {
      logger.error('Failed to checkUrl (get, auth)', { url: job.args.url, error: e });
      lastException = e;
    }
  }

  throw lastException;
}

const checkURLRequest = function (url, options, job) {
  return new Promise((resolve, reject) => {
    if (func.checkArgs(job, 'cookies')) {
      let j = request.jar()
      let cookie = request.cookie(job.args.cookies)
      j.setCookie(cookie, url)
      options.jar = j
    } else {
      options.jar = true
    }

    requestLoop(url, options, 2, 1000, (err, res) => {
      if (err) {
        return reject(err)
      }

      if (!res || !res.hasOwnProperty('statusCode')) {
        return reject('Can\'t resolve GET request')
      }

      try {
        if (job.args.auth && job.args.auth.type === 'netlify' && res.statusCode === 401) {
          return resolve()
        } else if (res.statusCode === 0 || (res.statusCode >= 400 && !([403, 404].indexOf(res.statusCode) !== -1))) {
          return reject('Wrong status code => ' + res.statusCode + ': ' + res.statusMessage)
        }

        return resolve()
      } catch (e) {
        return reject('checkUrlError: ' + (e && e.hasOwnProperty('message')) ? e.message : e)
      }
    })
  })
}

const requestLoop = function (url, options, attemptsLeft, retryDelay, callback, lastError = null) {
  if (attemptsLeft <= 0) {
    callback((lastError ?? new Error('checkUrlError')))
  } else {
    request(url, options, function (error, response) {
      const recoverableErrors = ['ESOCKETTIMEDOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED']
      if (error && recoverableErrors.includes(error.code)) {
        setTimeout((function () {
          requestLoop(url, options, --attemptsLeft, retryDelay, callback, error)
        }), retryDelay)
      } else {
        callback(error, response)
      }
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

module.exports = {

  perform: async (browser, job, jobItem) => {
    let data = {};
    let context;
    let page;
    let jsConsole = [];
    const maxPageHeightIfError = 50000;

    // try {
    //   await checkUrl(jobItem.url, jobItem)
    //   logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url,'check url done')
    // } catch (e) {
    //   return await saveError(job, jobItem, 'CheckURL ' + ((e && e, 'message')) ? e.message : e.toString())
    // }

    try {
      const maxPageHeight = (Object.hasOwn(job, 'attempts') && job.attempts > 0) ? (maxPageHeightIfError / job.attempts) : maxPageHeightIfError

      const viewportWidth = parseInt(jobItem.breakpoint) || 800;
      const baseViewport = { width: viewportWidth, height: 1000 };
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
      await func.applyHeadersToContext(context, headerConfig);
      await func.applyStealth(context, headerConfig);
      page = await context.newPage();

      if (Object.hasOwn(jobItem.args, 'night_mode') && jobItem.args.night_mode) {
        await page.emulateMedia({ colorScheme: 'dark' });
      }

      logger.debug('browser.newContext', { jobItem })

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
      logger.debug('setHeaders prepared', { userAgent: headerConfig.userAgent, extraHeaders: headerConfig.extraHeaders || {} })

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

      if (callRailBlockEnabled) {
        await page.route('**/*swap_session.json*', (route) => {
          route.abort().catch((error) => {
            logger.warn('Failed to abort CallRail request', { error, requestUrl: route.request().url() });
          });
        });
      }

      if (basicAuthRouteConfig) {
        await page.route('**', (route) => {
          const request = route.request();
          const requestUrl = request.url();

          const headers = {
            ...request.headers(),
            Authorization: basicAuthRouteConfig.header,
          };

          let overriddenUrl = requestUrl;
          const currentHost = (() => {
            try {
              return new URL(overriddenUrl).host;
            } catch (e) {
              return null;
            }
          })();

          if (currentHost && basicAuthRouteConfig.targetHost && currentHost === basicAuthRouteConfig.targetHost) {
            overriddenUrl = overriddenUrl.replace(/^https:/, 'http:');
          }

          route.continue({ headers, url: overriddenUrl }).catch((error) => {
            logger.warn('Failed to continue basic auth request', { error, requestUrl });
          });
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
        logger.debug('authCookies', { authCookies })
        cookies = cookies.concat(authCookies)
      }

      if (cookies?.length) {
        await context.addCookies(cookies)
      }

      try {
        const origin = new URL(url).origin
        await context.grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write', 'notifications', 'camera', 'microphone'], { origin })
      } catch (error) {
        logger.warn('Failed to grant permissions for origin', { error })
      }

      await func.simulatePreNavigation(page, url)

      let response;

      try {
        await page.waitForTimeout(func.random(120, 380));
        response = await page.goto(url, { waitUntil: 'networkidle' })

        await handleIncapsula(page);
        await func.handleCloudflareChallenge(page, { frameWaitMs: 8000, retryDelayMs: 2500 }).catch((error) => {
          logger.warn('Cloudflare challenge handling failed', { error })
        })
        const unresolvedChallenge = await page.evaluate(() => {
          const bodyText = document.body?.innerText || ''
          return bodyText.includes('Please unblock challenges.cloudflare.com')
        }).catch(() => false)
        if (unresolvedChallenge) {
          throw new Error('Cloudflare challenge unresolved: Please unblock challenges.cloudflare.com')
        }
      } catch (err) {
        logger.warn('page was not loaded by networkidle', { url })

        try {
          response = await page.goto(url, { waitUntil: 'load' })
          await page.waitForLoadState('domcontentloaded', { timeout: 120000 }).catch(() => {})
          await func.handleCloudflareChallenge(page, { frameWaitMs: 8000, retryDelayMs: 2500 }).catch((error) => {
            logger.warn('Cloudflare challenge handling failed (retry branch)', { error })
          })
          const unresolvedChallenge = await page.evaluate(() => {
            const bodyText = document.body?.innerText || ''
            return bodyText.includes('Please unblock challenges.cloudflare.com')
          }).catch(() => false)
          if (unresolvedChallenge) {
            throw new Error('Cloudflare challenge unresolved after reload')
          }
        } catch (err) {
          logger.error('page was not loaded by load or domcontentloaded', { error: err, url })
        }
      }

      logger.debug('page loaded done')

      // Disable animation / transition (exclude diff from animation)
      logger.debug('disable css animation')

      await page.addStyleTag({
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
      }).catch((e) => logger.warn('Failed to add style tag to disable animation', { error: e }))

      try {
        await disableGifAnimation(page)
      } catch (e) {
        logger.warn('Failed to disable GIF animation', { error: e })
      }

      await page.setViewportSize({ width: parseInt(jobItem.breakpoint), height: 1000 })
      logger.debug('page.goto done')

      await page.evaluate(() => document.fonts.ready.then(() => true))
      await page.waitForFunction(() => document.readyState === 'complete');

      await func.humanLikeInteraction(page)

      // @see https://github.com/ygerasimov/diffy-pm/issues/250 (wp-rocket fix)
      await page.evaluate(() => {
        try {
          window.dispatchEvent(new Event('touchstart'));
          window.document.dispatchEvent(new Event('touchstart'));
        } catch (e) {}
      });

      await func.addCssCode(page, jobItem)
      logger.debug('addCssCode done')

      // #see https://github.com/ygerasimov/diffy-pm/issues/339
      if (Object.hasOwn(jobItem, 'project_id') && jobItem.project_id === 20882) {
        await func.cutElements(page, jobItem)
      }

      await func.autoScroll(page, jobItem)
      logger.debug('autoScroll done')

      if (Object.hasOwn(jobItem.args, 'stabilization') && jobItem.args.stabilization) {
          await (async () => {
              await eval(jobItem.args.stabilization_code);
          })();
      }

      let page_height = await func.updatePageViewport(page, jobItem, maxPageHeight)
      logger.debug('updatePageViewport done', { page_height })

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
        await func.hideBanners(page, { args: { elements: ['iframe[src*="google.com/maps"]'] } })
      }

      await func.delayBeforeScreenshot(page, jobItem)

      await func.addJsCode(page, jobItem)
      logger.debug('addJsCode done')

      logger.debug('delayBeforeScreenshot done')
      const is_cut = await func.cutElements(page, jobItem)
      if (is_cut) {
        // We need decrease height after cut.
        await page.setViewportSize({ width: parseInt(jobItem.breakpoint), height: 100 })
        await func.updatePageViewport(page, jobItem, maxPageHeight)
      }
      logger.debug('cutElements done')

      await func.addFixtures(page, jobItem)
      logger.debug('addFixtures done')

      await func.hideBanners(page, jobItem)
      logger.debug('hideBanners done')

      // Recalculate page height after modifications.
      await page.setViewportSize({ width: parseInt(jobItem.breakpoint), height: 100 })
      await func.updatePageViewport(page, jobItem, maxPageHeight)

      await func.autoScroll(page, jobItem)
      logger.debug('double autoScroll done')
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

      // Take deterministic full-page screenshot of the entire scrollable height
      // without introducing extra transparent padding.
      // Notes:
      // - Use fullPage: true to stitch the entire document height.
      // - Set omitBackground: false to ensure opaque output and avoid
      //   compositing differences.
      // - Ensure the page finished layout after updates by forcing a sync reflow.
      await page.evaluate(() => {
        // Force a reflow to settle layout before capture
        void document.body.offsetHeight;
      });
      await page.screenshot({
        path: filename,
        fullPage: true,
        omitBackground: false
      })

      logger.debug('screenshot done')
      const pageHtml = await func.getPageHtml(page)
      logger.debug('pageHtml done')

      let pageMhtml = ''
      if (mhtmlFilename) {
        pageMhtml = await func.getPageMhtml(page)
        logger.debug('pageMhtml done', { jobItem })
      }

      if (is_crop) {
        await thumbnail.crop(filename, is_crop)
        data.pageArea = is_crop.height * is_crop.width
      }

      await page.close()
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
          logger.error('Failed to write file', { error: err });
        }

        if (mhtmlFilename) {
          try {
            fs.writeFileSync(mhtmlFilename, pageMhtml);
          } catch (err) {
            logger.error('Failed to write MHTML file', { error: err });
          }
        }

        try {
          fs.writeFileSync(jsConsoleFilename, JSON.stringify(jsConsole));
        } catch (err) {
          logger.error('Failed to write file', { error: err });
        }

        return {
          screenshot: filename,
          html: htmlFilename,
          mhtml: mhtmlFilename,
          jsConsole: jsConsoleFilename
        }
      }

      const s3Url = await uploadS3.upload(filename).catch((err) => {
        logger.error('Failed to upload file to S3', { error: err });
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

        logger.debug('uploadMhtmlFileString done', { job_item: jobItem })
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
      logger.error('perform error:', { error: err })

      if (page) {
        try {
          await page.close()
        } catch (e) {
          logger.error('Failed to close page', { error: e })
        }
        page = null
      }

      if (context) {
        try {
          await context.close()
        } catch (e) {
          logger.error('Failed to close context', { error: e })
        }
        context = null
      }

      return sendError(job, (err && Object.hasOwn(err, 'message')) ? err.message : err.toString(), jobItem)
    }
  },

  saveError: async (job, jobItem, errorText) => {
    return saveError(job, jobItem, errorText)
  },

  saveTimeoutError: async (job, jobItem) => {
    return saveError(job, jobItem, 'Timeout error: too big page, or too big resources on the page.')
  },
}
