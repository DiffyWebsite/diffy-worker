const request = require('request') // @TODO use node http module
const uploadS3 = require('./uploadS3.js')
const thumbnail = require('./thumbnail.js')
const func = require('./func.js')
const { Logger } = require('./logger')
const fs = require("node:fs");
const path = require('path');

const debug = !!process.env.DEBUG;

const logger = new Logger(debug)

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
    logger.error(url, 'Failed to checkUrl', e);
    lastException = e;
  }

  try {
    options.method = 'GET'
    await checkURLRequest(url, options, job)
    return true
  } catch (e) {
    logger.error(url, 'Failed to checkUrl (GET)', e);
    lastException = e;
  }

  if (job.args.url) {
    try {
      await checkURLRequest(job.args.url, options, job)
      return true
    } catch (e) {
      logger.error(job.args.url, 'Failed to checkUrl (get, auth)', e);
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

const debugLog = (data, jobItem = {}, additional = null, finishJob = false) => {
  if (debug) {
    const jobId = (jobItem && Object.hasOwn(jobItem, 'id')) ? jobItem.id : 'noJobId';
    const projectId = (jobItem && Object.hasOwn(jobItem, 'project_id')) ? jobItem.project_id : 'noProjectId';
    const breakpoint = (jobItem && Object.hasOwn(jobItem, 'breakpoint')) ? jobItem.breakpoint : 'noBreakpoint';
    const url = (jobItem && Object.hasOwn(jobItem, 'url')) ? jobItem.url : 'noUrl';

    const log = { data, additional };

    logger.info(jobId + ':' + breakpoint + ':' + url, data, log);
  }
};

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
      page = await browser.newPage();

      await func.setHeaders(page, jobItem)
      await page.setExtraHTTPHeaders({
        Referer: 'https://www.facinghistory.org'
      });
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'setHeaders done')

      // Cache fonts (cron is set to clear every day /tmp/fonts)
      const cacheDir = path.resolve('/tmp/fonts/' + jobItem.project_id);
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      await page.setRequestInterception(true);

      page.on('request', request => {
        const url = request.url();
        const fileName = path.basename(url);
        const files = fs.readdirSync(cacheDir);
        const cachedFile = files.find(file => file.startsWith(fileName));

        if (url.endsWith('.css') && cachedFile) {
          const [originalFileName, contentType] = cachedFile.split('___');
          const filePath = path.join(cacheDir, cachedFile);
          const cachedFileBuffer = fs.readFileSync(filePath);
          return request.respond({
            status: 200,
            contentType: contentType.replace(/_/g, '/'),
            body: cachedFileBuffer,
          });
        } else if (url.includes('font') && cachedFile) {
          const [originalFontName, contentType] = cachedFile.split('___');
          const fontPath = path.join(cacheDir, cachedFile);
          const cachedFontBuffer = fs.readFileSync(fontPath);
          return request.respond({
            status: 200,
            contentType: contentType.replace(/_/g, '/'),
            body: cachedFontBuffer,
          });
        }

        request.continue();
      });

      page.on('response', async response => {
        const url = response.url();
        const fileName = path.basename(url);

        if ((url.endsWith('.css') || url.includes('font')) && response.ok()) {
          try {
            const buffer = await response.buffer();

            const contentLengthHeader = response.headers()['content-length'];
            const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

            let validFile = true;
            if (contentLength && contentLength !== buffer.length) {
              logger.warn(
                  jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url,
                  'Skipping cache',
              );

              validFile = false;
            }

            if (validFile) {
              const contentType = response.headers()['content-type'] || '';
              const safeContentType = contentType.replace(/\//g, '_');
              const filePath = path.join(cacheDir, `${fileName}___${safeContentType}`);

              fs.writeFileSync(filePath, buffer);

              logger.info(
                  jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url,
                  `Successfully cached: ${fileName}, size: ${buffer.length} bytes`
              );
            }
          } catch (error) {
            logger.warn(
                jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url,
                'Error caching resource',
                error
            );
          }
        }
      });

      if (Object.hasOwn(jobItem.args, 'night_mode') && jobItem.args.night_mode) {
        // Emulate dark mode
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      }

      if (Object.hasOwn(jobItem.args, 'retina_images') && jobItem.args.retina_images) {
        await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 1000, deviceScaleFactor: 2 })
      }

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url,'browser.newPage', jobItem)

      // set global timeout and disable CSP
      await page.setBypassCSP(true)
      await page.setDefaultNavigationTimeout(120000)
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'setDefaultNavigationTimeout done')
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

      // Remove all browser Cookies.
      const client = await page.target().createCDPSession();
      await client.send('Network.clearBrowserCookies');
      await new Promise(resolve => setTimeout(resolve, 1000));

      if (!Object.hasOwn(jobItem, 'url') || !Object.hasOwn(jobItem, 'breakpoint')) {
        throw new Error('Cannot find url or breakpoint options')
      }

      let url = jobItem.url;

      if (jobItem.url && jobItem.base_url) {
        // Base URL can have GET parameters. We need to merge them with url.
        let pageUrl = new URL(jobItem.url);
        let pageUrlParameters = pageUrl.searchParams;

        let baseUrl = new URL(jobItem.base_url);
        let baseUrlParameters = baseUrl.searchParams;

        // We override base URL parameters with ones from the page.
        pageUrlParameters.forEach((value, key) => {
          baseUrlParameters.set(key, value);
        });

        const parameters_regex = /(\?.*)/gi;
        url = jobItem.url.replaceAll(parameters_regex, '');

        const parametersString = baseUrlParameters.toString();
        if (parametersString) {
          url += '?' + parametersString;
        }
      }

      if (
        Object.hasOwn(jobItem, 'basicAuth') && jobItem.basicAuth &&
        Object.hasOwn(jobItem.basicAuth, 'user') && jobItem.basicAuth.user &&
        Object.hasOwn(jobItem.basicAuth, 'password') && jobItem.basicAuth.password
      ) {
        await page.authenticate({ username: jobItem.basicAuth.user, password: jobItem.basicAuth.password })
      }

      // Add new cookies.
      let cookies = await func.addCookies(jobItem)
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'addCookies done')
      const authCookies = await func.auth(page, jobItem).catch((err) => {
        data.auth_error = err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err
      })

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'auth done')
      if (authCookies) {
        logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'authCookies', authCookies)
        cookies = cookies.concat(authCookies)
      }

      if (cookies) {
        await page.setCookie(...cookies)
      }

      if (Object.hasOwn(jobItem, 'project_id') && jobItem.project_id === 21791) {
        // @see https://support.callrail.com/hc/en-us/articles/5711492051085-Preventing-a-number-from-swapping-on-a-website
        logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'Apply calltrkNoswap')

        await page.setRequestInterception(true);
        page.on('request', interceptedRequest => {
          if (interceptedRequest.url().endsWith('swap_session.json')) {
            interceptedRequest.abort();
          } else {
            interceptedRequest.continue();
          }
        });
      }

      try {
        await page.goto(url, { timeout: 120000, waitUntil: ['networkidle2'] })
      } catch (err) {
        logger.warn(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'page was not loaded by networkidle2')

        try {
          await page.goto(url, { timeout: 120000, waitUntil: ['load', 'domcontentloaded'] })
        } catch (err) {
          logger.error(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'page was not loaded by load or domcontentloaded')
        }
      }

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'page loaded done')

      // Disable animation / transition (exclude diff from animation)
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'disable css animation')

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
      }).catch((e) => logger.warn(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'Failed to add style tag', e))

      try {
        await disableGifAnimation(page)
      } catch (e) {
        logger.warn(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'Failed to disable GIF animation', e)
      }

      await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 1000 })
      await new Promise(resolve => setTimeout(resolve, 1000));
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'page.goto done')

      logger.startTimer('waitFontsReady', jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url);
      await page.evaluate(() => document.fonts.ready);
      logger.endTimer('waitFontsReady', jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url);
      await new Promise(resolve => setTimeout(resolve, 3000));

      // @see https://github.com/ygerasimov/diffy-pm/issues/250 (wp-rocket fix)
      await page.evaluate(() => {
        try {
          window.dispatchEvent(new Event('touchstart'));
          window.document.dispatchEvent(new Event('touchstart'));
        } catch (e) {}
      });

      await func.addCssCode(page, jobItem)
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'addCssCode done')

      // #see https://github.com/ygerasimov/diffy-pm/issues/339
      if (Object.hasOwn(jobItem, 'project_id') && jobItem.project_id === 20882) {
        await func.cutElements(page, jobItem)
      }

      await func.autoScroll(page, jobItem)
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'autoScroll done')

      if (Object.hasOwn(jobItem.args, 'stabilization') && jobItem.args.stabilization) {
          await (async () => {
              await eval(jobItem.args.stabilization_code);
          })();
      }

      let page_height = await func.updatePageViewport(page, jobItem, maxPageHeight)
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'updatePageViewport done', { page_height })

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
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'addJsCode done')

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'delayBeforeScreenshot done')
      const is_cut = await func.cutElements(page, jobItem)
      if (is_cut) {
        // We need decrease height after cut.
        await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 100 })
        await func.updatePageViewport(page, jobItem, maxPageHeight)
      }
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'cutElements done')

      await func.addFixtures(page, jobItem)
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'addFixtures done')

      await func.hideBanners(page, jobItem)
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'hideBanners done')

      // Recalculate page height after modifications.
      await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 100 })
      await func.updatePageViewport(page, jobItem, maxPageHeight)

      await func.autoScroll(page, jobItem)
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'double autoScroll done')
      const pageHeight = await func.updatePageViewport(page, jobItem, maxPageHeight)

      data.pageArea = pageHeight * jobItem.breakpoint

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'updatePageViewport done')

      const is_crop = await func.cropElement(page, jobItem)

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url,'cropElement done')

      const filenameKey = Math.floor(Date.now() / 1000) + '-' + (func.random(0, 999999999)).toString()
      let filename = '/tmp/screenshot-' + filenameKey + '.png'

      const htmlFilename = '/tmp/html-' + filenameKey + '.html'

      let mhtmlFilename = '';
      if (Object.hasOwn(jobItem, 'mhtml') && jobItem.mhtml) {
        mhtmlFilename = '/tmp/mhtml-' + filenameKey + '.mhtml'
      }

      const jsConsoleFilename = '/tmp/jsConsole-' + filenameKey + '.json'
      let thumbnailFilepath = filename.replace('.png', '-thumbnail.png')

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'start screenshot')

      await page.screenshot({
        path: filename,
        captureBeyondViewport: false,
      })

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'screenshot done')
      const pageHtml = await func.getPageHtml(page)
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'pageHtml done')

      let pageMhtml = ''
      if (mhtmlFilename) {
        pageMhtml = await func.getPageMhtml(page)
        debugLog('pageMhtml done', jobItem)
      }

      if (is_crop) {
        await thumbnail.crop(filename, is_crop)
        data.pageArea = is_crop.height * is_crop.width
      }

      await page.close()
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'page close done')

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

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'screenshot created')
      if (jobItem.local) {
        const fs = require('node:fs');
        try {
          fs.writeFileSync(htmlFilename, pageHtml);
        } catch (err) {
          logger.error(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'Failed to write file', err);
        }

        if (mhtmlFilename) {
          try {
            fs.writeFileSync(mhtmlFilename, pageMhtml);
          } catch (err) {
            logger.error(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'Failed to write MHTML file', err);
          }
        }

        try {
          fs.writeFileSync(jsConsoleFilename, JSON.stringify(jsConsole));
        } catch (err) {
          logger.error(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'Failed to write file', err);
        }

        return {
          screenshot: filename,
          html: htmlFilename,
          mhtml: mhtmlFilename,
          jsConsole: jsConsoleFilename
        }
      }


      const s3Url = await uploadS3.upload(filename).catch((err) => {
        logger.error(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'Failed to upload file to S3', err);
        throw new Error('Can\'t upload screenshot: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
      })

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'uploadS3 done')

      await thumbnail.generateImageThumbnail(filename, thumbnailFilepath).catch((err) => {
        throw new Error('Can\'t generate thumbnail: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
      })

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'generateImageThumbnail done')

      const s3UrlThumbnail = await uploadS3.upload(thumbnailFilepath).catch((err) => {
        throw new Error('Can\'t upload thumbnail: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
      })

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'uploadS3Thumbnail done')

      const s3HtmlUrl = await uploadS3.uploadFileString(htmlFilename, pageHtml).catch((err) => {
        throw new Error('Can\'t upload html file: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
      })
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'uploadHtmlFileString done')

      let s3MhtmlUrl = ''

      if (mhtmlFilename) {
        s3MhtmlUrl = await uploadS3.uploadFileString(mhtmlFilename, pageMhtml).catch((err) => {
          throw new Error('Can\'t upload mhtml file: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
        })
        logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'uploadMhtmlFileString done', jobItem)
      }

      const s3JsConsoleUrl = await uploadS3.uploadFileString(jsConsoleFilename, JSON.stringify(jsConsole)).catch((err) => {
        throw new Error('Can\'t upload jsConsole file: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
      })
      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'uploadJsConsoleFileString done')

      // Not need to remove "htmlFilename/mhtmlFilename" because we use stream and not creating real file.
      // Async remove files.
      await func.removeFile(filename)
      await func.removeFile(thumbnailFilepath)

      if (webpWasUsed) {
        await func.removeFile(filename.replace('.webp', '.png'))
      }

      logger.info(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'sendResult')

      return sendResult(job, jobItem, {
        'full': s3Url,
        'thumbnail': s3UrlThumbnail,
        'html': s3HtmlUrl,
        'mhtml': s3MhtmlUrl,
        'jsConsole': s3JsConsoleUrl,
        'data': data,
        'log_data': '',
      })
    } catch (err) {
      logger.error(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'perform error:', err)

      if (page !== null) {
        try {
          await page.close()
        } catch (e) {
          logger.error(jobItem.id + ':' + jobItem.breakpoint + ':' + jobItem.url, 'Failed to close page', e)
        }
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

  debugLog: (data, jobItem = {}, additional = null, finishJob = false) => {
    return debugLog(data, jobItem, additional, finishJob)
  }
}
