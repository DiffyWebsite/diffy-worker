const request = require('request') // @TODO use node http module
const uploadS3 = require('./uploadS3.js')
const thumbnail = require('./thumbnail.js')
const func = require('./func.js')
const { Logger } = require('./logger')

const debug = !!process.env.DEBUG;

const logger = new Logger()

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
    console.log('Failed to checkUrl', e);
    lastException = e;
  }

  try {
    options.method = 'GET'
    await checkURLRequest(url, options, job)
    return true
  } catch (e) {
    console.log('Failed to checkUrl (GET)', e);
    lastException = e;
  }

  if (job.args.url) {
    try {
      await checkURLRequest(job.args.url, options, job)
      return true
    } catch (e) {
      console.log('Failed to checkUrl (get, auth)', e);
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

const debugLog = (data, jobItem = {}, additional = false) => {
  if (debug) {
    const jobId = (jobItem && Object.hasOwn(jobItem, 'id')) ? jobItem.id : 'noJobId'
    const projectId = (jobItem && Object.hasOwn(jobItem, 'project_id')) ? jobItem.project_id : 'noProjectId'
    const breakpoint = (jobItem && Object.hasOwn(jobItem, 'breakpoint')) ? jobItem.breakpoint : 'noBreakpoint'
    const url = (jobItem && Object.hasOwn(jobItem, 'url')) ? jobItem.url : 'noUrl'
    const key = `j:${jobId}-p:${projectId}-b:${breakpoint}-u:${url}`

    if (additional) {
      console.log(key, data, additional)
    } else {
      console.log(key, data)
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

    // Not need to remove "htmlFilename" because we use stream and not creating real file.
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

async function disableGifAnimation (page) {
  await page.evaluate(() => {
    Array.from(document.images)
      .filter((image) => /^(?!data:).*\.gif/i.test(image.src))
      .map((image) => {
        const c = document.createElement('canvas');
        const w = c.width = image.width;
        const h = c.height = image.height;

        c.getContext('2d').drawImage(image, 0, 0, w, h);

        try {
          image.src = c.toDataURL('image/gif'); // if possible, retain all css aspects
        } catch(e) {
          // cross-domain -- mimic original with all its tag attributes
          for (const attribute of Object.entries(image.attributes)) {
            c.setAttribute(attribute[1].name, attribute[1].value);
          }

          image.parentNode.replaceChild(c, image);
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

    debugLog('Start process:', jobItem, job)
    // try {
    //   debugLog('Start screenshot', jobItem)
    //   await checkUrl(jobItem.url, jobItem)
    //   debugLog('checkUrl done: ' + jobItem.url, jobItem)
    // } catch (e) {
    //   debugLog('checkUrl error:', jobItem)
    //   debugLog(e, jobItem)
    //   return await saveError(job, jobItem, 'CheckURL ' + ((e && e, 'message')) ? e.message : e.toString()))
    // }

    try {
      const maxPageHeight = (Object.hasOwn(job, 'attempts') && job.attempts > 0) ? (maxPageHeightIfError / job.attempts) : maxPageHeightIfError
      page = await browser.newPage()

      if (Object.hasOwn(jobItem.args, 'night_mode') && jobItem.args.night_mode) {
        // Emulate dark mode
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      }

      if (Object.hasOwn(jobItem.args, 'retina_images') && jobItem.args.retina_images) {
        await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 1000, deviceScaleFactor: 2 })
      }

      debugLog('browser.newPage', jobItem)

      // set global timeout and disable CSP
      await page.setBypassCSP(true)
      await page.setDefaultNavigationTimeout(90 * 1000)
      debugLog('setDefaultNavigationTimeout done', jobItem)
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
      await page.waitForTimeout(1000) // wait 1 second.

      await func.setHeaders(page, jobItem)
      debugLog('setHeaders done', jobItem)

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
      debugLog('addCookies done', jobItem)
      const authCookies = await func.auth(page, jobItem).catch((err) => {
        data.auth_error = err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err
      })

      debugLog('auth done', jobItem)
      if (authCookies) {
        debugLog(authCookies, jobItem)
        cookies = cookies.concat(authCookies)
      }

      if (cookies) {
        await page.setCookie(...cookies)
      }

      if (Object.hasOwn(jobItem, 'project_id') && jobItem.project_id === 21791) {
        // @see https://support.callrail.com/hc/en-us/articles/5711492051085-Preventing-a-number-from-swapping-on-a-website
        console.log('Apply calltrkNoswap')

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
        await page.goto(url, { timeout: 60000, waitUntil: ['networkidle2'] })
      } catch (err) {
        debugLog('page was not loaded by networkidle2', jobItem)
        await page.goto(url, { timeout: 60000, waitUntil: ['domcontentloaded'] })
      }
      debugLog('page loaded done', jobItem)

      // Disable animation / transition (exclude diff from animation)
      if (Object.hasOwn(jobItem.args, 'disable_css_animation') && jobItem.args.disable_css_animation) {
        debugLog('disable css animation', jobItem)

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
        }).catch((e) => logger.error(e))

        try {
          await disableGifAnimation(page)
        } catch (e) {
          logger.error(e)
        }
      }

      await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 1000 })
      await page.waitForTimeout(1000)
      debugLog('page.goto done', jobItem)

      console.time('waitFontsReady');
      await page.evaluateHandle('document.fonts.ready');
      console.timeEnd('waitFontsReady');

      // @see https://github.com/ygerasimov/diffy-pm/issues/250 (wp-rocket fix)
      await page.evaluate(() => {
        try {
          window.dispatchEvent(new Event('touchstart'));
          window.document.dispatchEvent(new Event('touchstart'));
        } catch (e) {}
      });

      await func.addCssCode(page, jobItem)
      debugLog('addCssCode done', jobItem)

      // #see https://github.com/ygerasimov/diffy-pm/issues/339
      if (Object.hasOwn(jobItem, 'project_id') && jobItem.project_id === 20882) {
        await func.cutElements(page, jobItem)
      }

      await func.autoScroll(page, jobItem)
      debugLog('autoScroll done', jobItem)

      if (Object.hasOwn(jobItem.args, 'stabilization') && jobItem.args.stabilization) {
          await (async () => {
              await eval(jobItem.args.stabilization_code);
          })();
      }

      let page_height = await func.updatePageViewport(page, jobItem, maxPageHeight)
      debugLog('updatePageViewport done', jobItem, { page_height })

      if (Object.hasOwn(jobItem.args, 'stabilization') && jobItem.args.stabilization) {
        await page.evaluate(async () => {

          const stabilizeHeight = async (elementsHeights, level) => {
            for (const element of elementsHeights) {
              if (document.body.contains(element.node)) {
                if (
                  element.height !== element.node.offsetHeight &&
                  element.viewportRatio >= 0.40
                ) {
                  console.log('[HeightStabilization] #' + level + ' Fixing: ', element.height, element.node.offsetHeight)

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
        }, )

        // hide google maps
        await func.hideBanners(page, { args: { elements: ['iframe[src*="google.com/maps"]'] } })
      }

      await func.delayBeforeScreenshot(page, jobItem)

      await func.addJsCode(page, jobItem)
      debugLog('addJsCode done', jobItem)

      debugLog('delayBeforeScreenshot done', jobItem)
      const is_cut = await func.cutElements(page, jobItem)
      if (is_cut) {
        // We need decrease height after cut.
        await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 100 })
        await func.updatePageViewport(page, jobItem, maxPageHeight)
      }
      debugLog('cutElements done', jobItem)
      await func.hideBanners(page, jobItem)
      debugLog('hideBanners done', jobItem)

      await func.addFixtures(page, jobItem)
      debugLog('addFixtures done', jobItem)

      // Recalculate page height after modifications.
      await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 100 })
      await func.updatePageViewport(page, jobItem, maxPageHeight)

      await func.autoScroll(page, jobItem)
      debugLog('double autoScroll done', jobItem)
      const pageHeight = await func.updatePageViewport(page, jobItem, maxPageHeight)

      data.pageArea = pageHeight * jobItem.breakpoint

      debugLog('updatePageViewport done', jobItem)

      const is_crop = await func.cropElement(page, jobItem)

      debugLog('cropElement done', jobItem)

      const filenameKey = Math.floor(Date.now() / 1000) + '-' + (func.random(0, 999999999)).toString()
      let filename = '/tmp/screenshot-' + filenameKey + '.png'
      const htmlFilename = '/tmp/html-' + filenameKey + '.html'
      const jsConsoleFilename = '/tmp/jsConsole-' + filenameKey + '.json'
      let thumbnailFilepath = filename.replace('.png', '-thumbnail.png')

      debugLog('start screenshot', jobItem)

      await page.screenshot({
        path: filename,
        captureBeyondViewport: false,
      })

      debugLog('screenshot done', jobItem)
      const pageHtml = await func.getPageHtml(page)
      debugLog('pageHtml done', jobItem)
      if (is_crop) {
        await thumbnail.crop(filename, is_crop)
        data.pageArea = is_crop.height * is_crop.width
      }

      await page.close()
      debugLog('page close done', jobItem)

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

      debugLog('screenshot created', jobItem)
      if (jobItem.local) {
        const fs = require('node:fs');
        try {
          fs.writeFileSync(htmlFilename, pageHtml);
        } catch (err) {
          logger.error(err);
        }
        try {
          fs.writeFileSync(jsConsoleFilename, JSON.stringify(jsConsole));
        } catch (err) {
          logger.error(err);
        }
        return {
          screenshot: filename,
          html: htmlFilename,
          jsConsole: jsConsoleFilename
        }
      }


      const s3Url = await uploadS3.upload(filename).catch((err) => {
        console.log('upload error');
        throw new Error('Can\'t upload screenshot: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
      })

      debugLog('uploadS3 done', jobItem)

      await thumbnail.generateImageThumbnail(filename, thumbnailFilepath).catch((err) => {
        throw new Error('Can\'t generate thumbnail: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
      })

      debugLog('generateImageThumbnail done', jobItem)

      const s3UrlThumbnail = await uploadS3.upload(thumbnailFilepath).catch((err) => {
        throw new Error('Can\'t upload thumbnail: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
      })

      debugLog('uploadS3Thumbnail done', jobItem)

      const s3HtmlUrl = await uploadS3.uploadFileString(htmlFilename, pageHtml).catch((err) => {
        throw new Error('Can\'t upload html file: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
      })
      debugLog('uploadHtmlFileString done', jobItem)

      const s3JsConsoleUrl = await uploadS3.uploadFileString(jsConsoleFilename, JSON.stringify(jsConsole)).catch((err) => {
        throw new Error('Can\'t upload jsConsole file: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
      })
      debugLog('uploadJsConsoleFileString done', jobItem)

      // Not need to remove "htmlFilename" because we use stream and not creating real file.
      // Async remove files.
      await func.removeFile(filename)
      await func.removeFile(thumbnailFilepath)

      if (webpWasUsed) {
        await func.removeFile(filename.replace('.webp', '.png'))
      }

      debugLog('sendResult', jobItem)

      return sendResult(job, jobItem, {
        'full': s3Url,
        'thumbnail': s3UrlThumbnail,
        'html': s3HtmlUrl,
        'jsConsole': s3JsConsoleUrl,
        'data': data,
        'log_data': '',
      })
    } catch (err) {
      debugLog('perform error:', jobItem)
      debugLog(err, jobItem)

      if (page !== null) {
        try {
          await page.close()
        } catch (e) {
          logger.error(e)
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

  debugLog: (data, jobItem = {}, additional = false) => {
    return debugLog(data, jobItem, additional)
  }
}
