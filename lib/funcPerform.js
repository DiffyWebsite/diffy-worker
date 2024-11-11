const axios = require('axios');
const uploadS3 = require('./uploadS3.js');
const thumbnail = require('./thumbnail.js');
const func = require('./func.js');
const { Logger } = require('./logger');
const fs = require("node:fs");

const debug = !!process.env.DEBUG;
const logger = new Logger(debug);

const sendResult = (job, jobItem, data) => {
  job.status = true;
  job.item_result = data;
  if (jobItem && Object.hasOwn(jobItem, 'additionalType')) {
    job.item_result.additionalType = jobItem.additionalType;
  }
  return job;
};

const sendError = (job, error, jobItem) => {
  job.status = false;
  job.err = error;
  job.item_result = [];
  if (jobItem && Object.hasOwn(jobItem, 'additionalType')) {
    job.item_result.additionalType = jobItem.additionalType;
  }
  return job;
};

const checkUrl = async (url, job) => {
  const options = {
    method: 'HEAD',
    url,
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.11; rv:46.0) Gecko/20100101 Firefox/46.0',
    },
    timeout: 30000,
    httpsAgent: new (require('https')).Agent({
      rejectUnauthorized: false,
    }),
  };

  if (func.checkArgs(job, 'headers', true)) {
    job.args.headers.forEach(item => {
      if (item.header.toLowerCase() === 'user-agent' && item.value.length) {
        options.headers['user-agent'] = item.value;
      }
      if (item.header.toLowerCase() === 'x-vercel-protection-bypass') {
        options.headers['x-vercel-protection-bypass'] = item.value;
      }
    });
  }

  if (job.basicAuth?.user && job.basicAuth?.password) {
    options.auth = {
      username: job.basicAuth.user,
      password: job.basicAuth.password,
    };
  }

  try {
    await axios(options);
    return true;
  } catch (e) {
    logger.error(url, 'Failed to checkUrl', e);
    options.method = 'GET';
    try {
      await axios(options);
      return true;
    } catch (e) {
      logger.error(url, 'Failed to checkUrl (GET)', e);
      throw e;
    }
  }
};

const requestLoop = async (url, options, attemptsLeft, retryDelay) => {
  while (attemptsLeft > 0) {
    try {
      const response = await axios(url, options);
      return response;
    } catch (error) {
      if (attemptsLeft <= 1 || !['ESOCKETTIMEDOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(error.code)) {
        throw error;
      }
      attemptsLeft--;
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
};

const debugLog = (data, jobItem = {}, additional = null, finishJob = false) => {
  if (debug) {
    const jobId = jobItem?.id || 'noJobId';
    const projectId = jobItem?.project_id || 'noProjectId';
    const breakpoint = jobItem?.breakpoint || 'noBreakpoint';
    const url = jobItem?.url || 'noUrl';
    const key = `j:${jobId}-p:${projectId}-b:${breakpoint}-u:${url}`;

    const log = { data, additional };
    logger.info(breakpoint + ':' + url, key, log);

    if (finishJob) {
      logger.flushLogs(breakpoint + ':' + url);
    }
  }
};

const saveError = async (job, jobItem, errorText) => {
  let filenameKey;
  let filename;

  try {
    if (errorText && (errorText.includes('SOCKETTIMEOUT') || errorText.includes('SOCKETTIMEDOUT'))) {
      errorText = 'Diffy was unable to take the screenshot.\n' +
          'Looks like we have overloaded your server. Please try lowering number of workers for this environment under Project Settings -> Advanced -> Performance';
    }

    errorText = 'Error: ' + errorText;
    const width = jobItem?.breakpoint || 1024;
    filenameKey = Math.floor(Date.now() / 1000) + '-' + (func.random(0, 999999999)).toString();

    const fileExtension = width < 16000 ? '.webp' : '.png';
    filename = '/tmp/screenshot-error-' + filenameKey + fileExtension;
    const thumbnailFilepath = filename.replace(fileExtension, '-thumbnail' + fileExtension);

    await thumbnail.createErrorImage(filename, errorText, width);

    const s3Url = await uploadS3.upload(filename).catch((err) => {
      throw new Error('Can\'t upload screenshot: ' + err.name + ': ' + (err.message || err));
    });

    await thumbnail.generateImageThumbnail(filename, thumbnailFilepath).catch((err) => {
      throw new Error('Can\'t generate thumbnail: ' + err.name + ': ' + (err.message || err));
    });

    const s3UrlThumbnail = await uploadS3.upload(thumbnailFilepath).catch((err) => {
      throw new Error('Can\'t upload thumbnail: ' + err.name + ': ' + (err.message || err));
    });

    await Promise.all([func.removeFile(filename), func.removeFile(thumbnailFilepath)]);

    return sendResult(job, jobItem, {
      'full': s3Url,
      'thumbnail': s3UrlThumbnail,
      'html': '',
      'data': 'Error: ' + JSON.stringify(job),
      'log_data': '',
      'error': {
        'message': errorText
      }
    });
  } catch (err) {
    return sendResult(job, jobItem, {
      'full': '',
      'thumbnail': '',
      'html': '',
      'data': 'Error: Can\'t generate error image. ' + errorText + ' => ' + (err.message || err),
      'log_data': '',
    });
  }
};

async function disableGifAnimation(page) {
  await page.evaluate(() => {
    Array.from(document.images)
        .filter((image) => /^(?!data:).*\.gif/i.test(image.src))
        .forEach((image) => {
          const c = document.createElement('canvas');
          const w = c.width = image.width;
          const h = c.height = image.height;
          const ctx = c.getContext('2d');
          try {
            ctx.drawImage(image, 0, 0, w, h);
            image.src = c.toDataURL('image/gif');
          } catch (e) {
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

    try {
      const maxPageHeight = (job?.attempts > 0) ? (maxPageHeightIfError / job.attempts) : maxPageHeightIfError;
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'browser start new page', jobItem);
      page = await browser.newPage();
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'browser.end newPage', jobItem);

      if (jobItem?.args?.night_mode) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      }

      if (jobItem?.args?.retina_images) {
        await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 1000, deviceScaleFactor: 2 });
      }

      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'browser.newPage', jobItem);

      await page.setBypassCSP(true);
      await page.setDefaultNavigationTimeout(90000);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'setDefaultNavigationTimeout done');
      page.on('console', msg => {
        let consoleMes = {
          type: msg.type(),
          text: msg.text(),
          location: msg.location(),
        };
        jsConsole.push(consoleMes);
      });

      const client = await page.target().createCDPSession();
      await client.send('Network.clearBrowserCookies');
      await page.waitForTimeout(1000);

      await func.setHeaders(page, jobItem);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'setHeaders done');

      if (!jobItem?.url || !jobItem?.breakpoint) {
        throw new Error('Cannot find url or breakpoint options');
      }

      let url = jobItem.url;

      if (jobItem.url && jobItem.base_url) {
        let pageUrl = new URL(jobItem.url);
        let pageUrlParameters = pageUrl.searchParams;

        let baseUrl = new URL(jobItem.base_url);
        let baseUrlParameters = baseUrl.searchParams;

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

      if (jobItem.basicAuth?.user && jobItem.basicAuth?.password) {
        await page.authenticate({ username: jobItem.basicAuth.user, password: jobItem.basicAuth.password });
      }

      let cookies = await func.addCookies(jobItem);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'addCookies done');
      const authCookies = await func.auth(page, jobItem).catch((err) => {
        data.auth_error = err.name + ': ' + (err.message || err);
      });

      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'auth done');
      if (authCookies) {
        cookies = cookies.concat(authCookies);
      }

      if (cookies) {
        await page.setCookie(...cookies);
      }

      if (jobItem.project_id === 21791) {
        logger.info(jobItem.breakpoint + ':' + jobItem.url, 'Apply calltrkNoswap');

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
        await page.goto(url, { timeout: 120000, waitUntil: ['networkidle2'] });
      } catch (err) {
        logger.info(jobItem.breakpoint + ':' + jobItem.url, 'page was not loaded by networkidle2', err);
        await page.goto(url, { timeout: 60000, waitUntil: ['load', 'domcontentloaded'] });
      }
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'page loaded done');

      if (jobItem.args?.disable_css_animation) {
        logger.info(jobItem.breakpoint + ':' + jobItem.url, 'disable css animation');

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
        }).catch((e) => logger.error(jobItem.breakpoint + ':' + jobItem.url, 'Failed to add style tag', e));

        try {
          await disableGifAnimation(page);
        } catch (e) {
          logger.error(jobItem.breakpoint + ':' + jobItem.url, 'Failed to disable GIF animation', e);
        }
      }

      await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 1000 });
      await page.waitForTimeout(1000);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'page.goto done');

      logger.startTimer('waitFontsReady', jobItem.breakpoint + ':' + jobItem.url);
      await page.evaluateHandle('document.fonts.ready');
      logger.endTimer('waitFontsReady', jobItem.breakpoint + ':' + jobItem.url);

      await page.evaluate(() => {
        try {
          window.dispatchEvent(new Event('touchstart'));
          window.document.dispatchEvent(new Event('touchstart'));
        } catch (e) {}
      });

      await func.addCssCode(page, jobItem);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'addCssCode done');

      if (jobItem.project_id === 20882) {
        await func.cutElements(page, jobItem);
      }

      await func.autoScroll(page, jobItem);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'autoScroll done');

      if (jobItem.args?.stabilization) {
        await (async () => {
          await eval(jobItem.args.stabilization_code);
        })();
      }

      let page_height = await func.updatePageViewport(page, jobItem, maxPageHeight);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'updatePageViewport done', { page_height });

      if (jobItem.args?.stabilization) {
        await page.evaluate(async () => {
          const stabilizeHeight = async (elementsHeights, level) => {
            for (const element of elementsHeights) {
              if (document.body.contains(element.node)) {
                if (element.height !== element.node.offsetHeight && element.viewportRatio >= 0.40) {
                  element.node.style.height = element.height + 'px';
                  element.node.style.maxHeight = element.height + 'px';
                  element.node.style.minHeight = element.height + 'px';

                  if (element.node.scrollHeight === element.node.offsetHeight) {
                    continue;
                  }
                }

                if (element.childNodes.length) {
                  await stabilizeHeight(element.childNodes, level + 1);
                }
              }
            }
          };

          await stabilizeHeight(window.diffyElementsHeights ?? [], 1);
        });

        await func.hideBanners(page, { args: { elements: ['iframe[src*="google.com/maps"]'] } });
      }

      await func.delayBeforeScreenshot(page, jobItem);
      await func.addJsCode(page, jobItem);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'addJsCode done');

      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'delayBeforeScreenshot done');
      const is_cut = await func.cutElements(page, jobItem);
      if (is_cut) {
        await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 100 });
        await func.updatePageViewport(page, jobItem, maxPageHeight);
      }
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'cutElements done');
      await func.hideBanners(page, jobItem);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'hideBanners done');

      await func.addFixtures(page, jobItem);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'addFixtures done');

      await page.setViewport({ width: parseInt(jobItem.breakpoint), height: 100 });
      await func.updatePageViewport(page, jobItem, maxPageHeight);

      await func.autoScroll(page, jobItem);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'double autoScroll done');
      const pageHeight = await func.updatePageViewport(page, jobItem, maxPageHeight);

      data.pageArea = pageHeight * jobItem.breakpoint;
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'updatePageViewport done');

      const is_crop = await func.cropElement(page, jobItem);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'cropElement done');

      const filenameKey = Math.floor(Date.now() / 1000) + '-' + (func.random(0, 999999999)).toString();
      let filename = '/tmp/screenshot-' + filenameKey + '.png';
      const htmlFilename = '/tmp/html-' + filenameKey + '.html';
      let mhtmlFilename = '';
      if (jobItem.mhtml) {
        mhtmlFilename = '/tmp/mhtml-' + filenameKey + '.mhtml';
      }
      const jsConsoleFilename = '/tmp/jsConsole-' + filenameKey + '.json';
      let thumbnailFilepath = filename.replace('.png', '-thumbnail.png');

      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'start screenshot');

      await page.screenshot({
        path: filename,
        captureBeyondViewport: false,
      });

      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'screenshot done');
      const pageHtml = await func.getPageHtml(page);
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'pageHtml done');

      let pageMhtml = '';
      if (mhtmlFilename) {
        pageMhtml = await func.getPageMhtml(page);
        logger.info('pageMhtml done', jobItem);
      }

      if (is_crop) {
        await thumbnail.crop(filename, is_crop);
        data.pageArea = is_crop.height * is_crop.width;
      }

      await page.close();
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'page close done');

      const screenshotSize = await func.getImageSize(filename);
      let webpWasUsed = false;

      if (screenshotSize.height < 16000 && screenshotSize.width < 16000) {
        const filenameWebp = filename.replace('.png', '.webp');
        await thumbnail.webp(filename, filenameWebp);
        filename = filenameWebp;
        thumbnailFilepath = thumbnailFilepath.replace('.png', '.webp');
        webpWasUsed = true;
      }

      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'screenshot created');
      if (jobItem.local) {
        try {
          fs.writeFileSync(htmlFilename, pageHtml);
        } catch (err) {
          logger.error(jobItem.breakpoint + ':' + jobItem.url, 'Failed to write file', err);
        }

        if (mhtmlFilename) {
          try {
            fs.writeFileSync(mhtmlFilename, pageMhtml);
          } catch (err) {
            logger.error(jobItem.breakpoint + ':' + jobItem.url, 'Failed to write MHTML file', err);
          }
        }

        try {
          fs.writeFileSync(jsConsoleFilename, JSON.stringify(jsConsole));
        } catch (err) {
          logger.error(jobItem.breakpoint + ':' + jobItem.url, 'Failed to write file', err);
        }

        return {
          screenshot: filename,
          html: htmlFilename,
          mhtml: mhtmlFilename,
          jsConsole: jsConsoleFilename
        };
      }

      const s3Url = await uploadS3.upload(filename).catch((err) => {
        logger.error(jobItem.breakpoint + ':' + jobItem.url, 'Failed to upload file to S3', err);
        throw new Error('Can\'t upload screenshot: ' + err.name + ': ' + (err.message || err));
      });

      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'uploadS3 done');

      await thumbnail.generateImageThumbnail(filename, thumbnailFilepath).catch((err) => {
        throw new Error('Can\'t generate thumbnail: ' + err.name + ': ' + (err.message || err));
      });

      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'generateImageThumbnail done');

      const s3UrlThumbnail = await uploadS3.upload(thumbnailFilepath).catch((err) => {
        throw new Error('Can\'t upload thumbnail: ' + err.name + ': ' + (err.message || err));
      });

      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'uploadS3Thumbnail done');

      const s3HtmlUrl = await uploadS3.uploadFileString(htmlFilename, pageHtml).catch((err) => {
        throw new Error('Can\'t upload html file: ' + err.name + ': ' + (err.message || err));
      });
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'uploadHtmlFileString done');

      let s3MhtmlUrl = '';
      if (mhtmlFilename) {
        s3MhtmlUrl = await uploadS3.uploadFileString(mhtmlFilename, pageMhtml).catch((err) => {
          throw new Error('Can\'t upload mhtml file: ' + err.name + ': ' + (err.message || err));
        });
        logger.info(jobItem.breakpoint + ':' + jobItem.url, 'uploadMhtmlFileString done', jobItem);
      }

      const s3JsConsoleUrl = await uploadS3.uploadFileString(jsConsoleFilename, JSON.stringify(jsConsole)).catch((err) => {
        throw new Error('Can\'t upload jsConsole file: ' + err.name + ': ' + (err.message || err));
      });
      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'uploadJsConsoleFileString done');

      await Promise.all([func.removeFile(filename), func.removeFile(thumbnailFilepath)]);
      if (webpWasUsed) {
        await func.removeFile(filename.replace('.webp', '.png'));
      }

      logger.info(jobItem.breakpoint + ':' + jobItem.url, 'sendResult');

      return sendResult(job, jobItem, {
        'full': s3Url,
        'thumbnail': s3UrlThumbnail,
        'html': s3HtmlUrl,
        'mhtml': s3MhtmlUrl,
        'jsConsole': s3JsConsoleUrl,
        'data': data,
        'log_data': '',
      });
    } catch (err) {
      logger.error(jobItem.breakpoint + ':' + jobItem.url, 'perform error:', err);

      if (page !== null) {
        try {
          await page.close();
        } catch (e) {
          logger.error(jobItem.breakpoint + ':' + jobItem.url, 'Failed to close page', e);
        }
      }

      return sendError(job, (err.message || err.toString()), jobItem);
    }
  },

  saveError: async (job, jobItem, errorText) => {
    return saveError(job, jobItem, errorText);
  },

  saveTimeoutError: async (job, jobItem) => {
    return saveError(job, jobItem, 'Timeout error: too big page, or too big resources on the page.');
  },

  debugLog: (data, jobItem = {}, additional = null, finishJob = false) => {
    return debugLog(data, jobItem, additional, finishJob);
  }
};