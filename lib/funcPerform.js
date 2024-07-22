const request = require('request') // @TODO use node http module
const uploadS3 = require('./uploadS3.js')
const thumbnail = require('./thumbnail.js')
const func = require('./func.js')

let debug = !!process.env.DEBUG || false
if (debug === 'false') {
  debug = false
}

const sendResult = (job, jobItem, data) => {
  job.status = true
  job.item_result = data
  if (jobItem && jobItem.hasOwnProperty('additionalType')) {
    job.item_result['additionalType'] = jobItem.additionalType
  }
  return job
}

const sendError = (job, error, jobItem) => {
  job.status = false
  job.err = error
  job.item_result = []
  if (jobItem && jobItem.hasOwnProperty('additionalType')) {
    job.item_result['additionalType'] = jobItem.additionalType
  }
  return job
}

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
    callback((lastError != null ? lastError : new Error('checkUrlError')))
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
    const jobId = (jobItem && jobItem.hasOwnProperty('id')) ? jobItem.id : 'noJobId'
    const projectId = (jobItem && jobItem.hasOwnProperty('project_id')) ? jobItem.project_id : 'noProjectId'
    const breakpoint = (jobItem && jobItem.hasOwnProperty('breakpoint')) ? jobItem.breakpoint : 'noBreakpoint'
    const url = (jobItem && jobItem.hasOwnProperty('url')) ? jobItem.url : 'noUrl'
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
  let thumbnailFilepath
  let s3UrlThumbnail
  let s3Url
  let width

  try {
    if (errorText && (errorText.includes('SOCKETTIMEOUT') || errorText.includes('SOCKETTIMEDOUT'))) {
      errorText = 'Diffy was unable to take the screenshot.\n' +
        'Looks like we have overloaded your server. Please try lowering number of workers for this environment under Project Settings -> Advanced -> Performance'
    }

    errorText = 'Error: ' + errorText
    width = (jobItem && jobItem.hasOwnProperty('breakpoint')) ? jobItem.breakpoint : 1024
    filenameKey = Math.floor(Date.now() / 1000) + '-' + (func.random(0, 999999999)).toString()

    if (width < 16000) {
      filename = '/tmp/screenshot-error-' + filenameKey + '.webp'
      thumbnailFilepath = filename.replace('.webp', '-thumbnail.webp')
    } else {
      filename = '/tmp/screenshot-error-' + filenameKey + '.png'
      thumbnailFilepath = filename.replace('.png', '-thumbnail.png')
    }

    await thumbnail.createErrorImage(filename, errorText, width)

    s3Url = await uploadS3.upload(filename).catch((err) => {
      throw new Error('Can\'t upload screenshot: ' + err.name + ': ' + (err && err.hasOwnProperty('message')) ? err.message : err)
    })

    await thumbnail.generateImageThumbnail(filename, thumbnailFilepath).catch((err) => {
      throw new Error('Can\'t generate thumbnail: ' + err.name + ': ' + (err && err.hasOwnProperty('message')) ? err.message : err)
    })

    s3UrlThumbnail = await uploadS3.upload(thumbnailFilepath).catch((err) => {
      throw new Error('Can\'t upload thumbnail: ' + err.name + ': ' + (err && err.hasOwnProperty('message')) ? err.message : err)
    })

    // Not need to remove "htmlFilename" because we use stream and not creating real file.
    // Async remove files.
    func.removeFile(filename)
    func.removeFile(thumbnailFilepath)

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
      'data': 'Error: Can\'t generate error image. ' + errorText + ' => ' + (err && err.hasOwnProperty('message')) ? err.message : err,
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
    let is_cut
    let is_crop
    let filename
    let s3Url
    let s3HtmlUrl
    let thumbnailFilepath
    let s3UrlThumbnail
    let data = {}
    let cookies
    let authCookies
    let page
    let pageHtml
    let htmlFilename
    let url
    let filenameKey
    let jsConsole = []
    let s3JsConsoleUrl
    let jsConsoleFilename
    let consoleMes
    let pageHeight
    const maxPageHeightIfError = 30000

    debugLog('Start process:', jobItem, job)
    // try {
    //   debugLog('Start screenshot', jobItem)
    //   await checkUrl(jobItem.url, jobItem)
    //   debugLog('checkUrl done: ' + jobItem.url, jobItem)
    // } catch (e) {
    //   debugLog('checkUrl error:', jobItem)
    //   debugLog(e, jobItem)
    //   return await saveError(job, jobItem, 'CheckURL ' + ((e && e.hasOwnProperty('message')) ? e.message : e.toString()))
    // }

    try {
      const maxPageHeight = (job.hasOwnProperty('attempts') && job.attempts > 0) ? (maxPageHeightIfError / job.attempts) : maxPageHeightIfError
      page = await browser.newPage()

      if (jobItem.args.hasOwnProperty('night_mode') && jobItem.args.night_mode) {
        // Emulate dark mode
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      }

      if (jobItem.args.hasOwnProperty('retina_images') && jobItem.args.retina_images) {
        await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 1000, deviceScaleFactor: 2 })
      }

      debugLog('browser.newPage', jobItem)

      // set global timeout and disable CSP
      await page.setBypassCSP(true)
      await page.setDefaultNavigationTimeout(90 * 1000)
      debugLog('setDefaultNavigationTimeout done', jobItem)
      page.on('console', msg => {
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

      if (!jobItem.hasOwnProperty('url') || !jobItem.hasOwnProperty('breakpoint')) {
        throw new Error('Cannot find url or breakpoint options')
      }

      url = jobItem.url

      if (
        jobItem.hasOwnProperty('basicAuth') && jobItem.basicAuth &&
        jobItem.basicAuth.hasOwnProperty('user') && jobItem.basicAuth.user &&
        jobItem.basicAuth.hasOwnProperty('password') && jobItem.basicAuth.password
      ) {
        await page.authenticate({ username: jobItem.basicAuth.user, password: jobItem.basicAuth.password })
      }

      // Add new cookies.
      cookies = await func.addCookies(jobItem)
      debugLog('addCookies done', jobItem)
      authCookies = await func.auth(page, jobItem).catch((err) => {
        data.auth_error = err.name + ': ' + (err && err.hasOwnProperty('message')) ? err.message : err
      })

      debugLog('auth done', jobItem)
      if (authCookies) {
        debugLog(authCookies, jobItem)
        cookies = cookies.concat(authCookies)
      }

      if (cookies) {
        await page.setCookie(...cookies)
      }

      if (jobItem.hasOwnProperty('project_id') && jobItem.project_id === 21791) {
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
      if (jobItem.args.hasOwnProperty('disable_css_animation') && jobItem.args.disable_css_animation) {
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
        }).catch((e) => console.error('Failed to addStyleTag: ', e))

        try {
          await disableGifAnimation(page)
        } catch (e) {
          console.error('Failed to disableGifAnimation: ', e)
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
      if (jobItem.hasOwnProperty('project_id') && jobItem.project_id === 20882) {
        await func.cutElements(page, jobItem)
      }

      await func.autoScroll(page, jobItem)
      debugLog('autoScroll done', jobItem)

      if (jobItem.args.hasOwnProperty('stabilization') && jobItem.args.stabilization) {
        console.log('[HeightStabilization] Starting');

        await page.evaluate(async () => {
          // pause and reset time for all <video> tags
          document.querySelectorAll('video')
            .forEach(video => {
              try {
                video.pause();
                video.currentTime = 0;
              } catch (e) {}
            });

          // destroy jarallax plugin
          if (typeof window.jarallax !== 'undefined') {
            try {
              window.jarallax(document.querySelectorAll('.jarallax'), 'destroy');
            } catch (e) {}
          }

          // swiper
          document.querySelectorAll('.swiper,.swiper-container')
            .forEach((element) => {
              if (typeof element.swiper !== 'undefined') {
                try {
                  element.swiper.autoplay.stop();
                  element.swiper.slideTo(1, 0);
                } catch (e) {}

                try {
                  element.swiper.setProgress(0, 0);
                } catch (e) {}
              }
            });

          // stop vimeo videos
          if (typeof Vimeo !== 'undefined') {
            document.querySelectorAll('iframe[src*="vimeo"]')
              .forEach((iframe) => {
                try {
                  (new Vimeo.Player(iframe)).destroy();
                } catch (e) {}
              });
          }

          // Stop YouTube videos
          document.querySelectorAll('iframe[src*="youtube"]')
            .forEach((iframe) => {
              iframe.contentWindow.postMessage('{"event":"command","func":"stopVideo","args":""}', '*');
            });

          // Stop Intercom
          if (typeof Intercom !== 'undefined') {
            try {
              Intercom('shutdown');
            } catch (e) {}
          }

          // Remove cookies modals / chats / captcha
          document.querySelectorAll('#CybotCookiebotDialog,#velaro-container,iframe[title="reCAPTCHA"],#hs-eu-cookie-confirmation,#onetrust-consent-sdk,.cookie-notice-overlay')
            .forEach((element) => {
              element.remove();
            });

          // Stop presto video player (https://github.com/ygerasimov/diffy-pm/issues/358)
          document.querySelectorAll('presto-player').forEach((el) => {
            try {
              el.stop()
            } catch (e) {}
          });

          // https://wppopupmaker.com/
          const pmStyle = document.createElement('style');
          pmStyle.textContent = `
            html.pum-open { overflow: auto!important; }
            .pum-overlay { display: none!important; }
          `;
          document.head.appendChild(pmStyle);
        })

        // hide youtube videos
        await func.hideBanners(page, { args: { elements: ['iframe[src*="youtube.com"]'] } })

        await page.evaluate(async () => {
          window.diffyElementsHeights = []

          await (async function(node, elementsHeights) {
            const viewportHeight = window.innerHeight;

            if (viewportHeight && node.childNodes.length) {
              for (const child of node.childNodes) {
                if (child.nodeType === Node.ELEMENT_NODE) {
                  // @TODO skip hidden elements (modals, mobile swipe menus, etc.)
                  if (
                    !child.offsetHeight ||
                    window.getComputedStyle(child).getPropertyValue('opacity') <= 0 ||
                    ['script', 'noscript', 'input', 'br', 'hr'].includes(child.tagName.toLowerCase())
                  ) {
                    continue;
                  }

                  const element = {
                    node: child,
                    height: child.offsetHeight,
                    viewportRatio: (child.offsetHeight / viewportHeight).toFixed(2),
                    childNodes: [],
                  }

                  elementsHeights.push(element)

                  if (child.childNodes && child.childNodes.length) {
                    await arguments.callee(child, element.childNodes)
                  }
                }
              }
            }
          })(document.body, window.diffyElementsHeights);

          console.log('[HeightStabilization] Found: ' + window.diffyElementsHeights.length)
        });
      }

      let page_height = await func.updatePageViewport(page, jobItem, maxPageHeight)
      debugLog('updatePageViewport done', jobItem, { page_height })

      if (jobItem.args.hasOwnProperty('stabilization') && jobItem.args.stabilization) {
        await page.evaluate(async () => {
          await (async function(elementsHeights, level) {
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
                  arguments.callee(element.childNodes, level + 1)
                }
              }
            }
          })(window.diffyElementsHeights ?? [], 1)
        }, )

        // hide google maps
        await func.hideBanners(page, { args: { elements: ['iframe[src*="google.com/maps"]'] } })
      }

      await func.delayBeforeScreenshot(page, jobItem)

      await func.addJsCode(page, jobItem)
      debugLog('addJsCode done', jobItem)

      debugLog('delayBeforeScreenshot done', jobItem)
      is_cut = await func.cutElements(page, jobItem)
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
      pageHeight = await func.updatePageViewport(page, jobItem, maxPageHeight)

      data.pageArea = pageHeight * jobItem.breakpoint

      debugLog('updatePageViewport done', jobItem)

      is_crop = await func.cropElement(page, jobItem)

      debugLog('cropElement done', jobItem)

      filenameKey = Math.floor(Date.now() / 1000) + '-' + (func.random(0, 999999999)).toString()
      filename = '/tmp/screenshot-' + filenameKey + '.png'
      htmlFilename = '/tmp/html-' + filenameKey + '.html'
      jsConsoleFilename = '/tmp/jsConsole-' + filenameKey + '.json'
      thumbnailFilepath = filename.replace('.png', '-thumbnail.png')

      debugLog('start screenshot', jobItem)

      await page.screenshot({
        path: filename,
        captureBeyondViewport: false,
      })

      debugLog('screenshot done', jobItem)
      pageHtml = await func.getPageHtml(page)
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
          console.error(err);
        }
        try {
          fs.writeFileSync(jsConsoleFilename, JSON.stringify(jsConsole));
        } catch (err) {
          console.error(err);
        }
        return {
          screenshot: filename,
          html: htmlFilename,
          jsConsole: jsConsoleFilename
        }
      }


      s3Url = await uploadS3.upload(filename).catch((err) => {
        console.log('upload error');
        throw new Error('Can\'t upload screenshot: ' + err.name + ': ' + (err && err.hasOwnProperty('message')) ? err.message : err)
      })

      debugLog('uploadS3 done', jobItem)

      await thumbnail.generateImageThumbnail(filename, thumbnailFilepath).catch((err) => {
        throw new Error('Can\'t generate thumbnail: ' + err.name + ': ' + (err && err.hasOwnProperty('message')) ? err.message : err)
      })

      debugLog('generateImageThumbnail done', jobItem)

      s3UrlThumbnail = await uploadS3.upload(thumbnailFilepath).catch((err) => {
        throw new Error('Can\'t upload thumbnail: ' + err.name + ': ' + (err && err.hasOwnProperty('message')) ? err.message : err)
      })

      debugLog('uploadS3Thumbnail done', jobItem)

      s3HtmlUrl = await uploadS3.uploadFileString(htmlFilename, pageHtml).catch((err) => {
        throw new Error('Can\'t upload html file: ' + err.name + ': ' + (err && err.hasOwnProperty('message')) ? err.message : err)
      })
      debugLog('uploadHtmlFileString done', jobItem)

      s3JsConsoleUrl = await uploadS3.uploadFileString(jsConsoleFilename, JSON.stringify(jsConsole)).catch((err) => {
        throw new Error('Can\'t upload jsConsole file: ' + err.name + ': ' + (err && err.hasOwnProperty('message')) ? err.message : err)
      })
      debugLog('uploadJsConsoleFileString done', jobItem)

      // Not need to remove "htmlFilename" because we use stream and not creating real file.
      // Async remove files.
      func.removeFile(filename)
      func.removeFile(thumbnailFilepath)

      if (webpWasUsed) {
        func.removeFile(filename.replace('.webp', '.png'))
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
          console.error('Can\'t close page', e)
        }
      }

      return sendError(job, (err && err.hasOwnProperty('message')) ? err.message : err.toString(), jobItem)
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
