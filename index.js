// Script has following optional parameters:
// file -- path to local json file with arguments for creating screenshots
// local -- whether to store resulting image locally or upload it to AWS (Diffy's production default mode)
// file-content -- if we pass job file as json as parameter
// output-filepath -- path to a file to save the results in json format. Used by wrapper.

const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes timeout

const process = require('process');
const debug = !!process.env.DEBUG;

const { performance } = require('perf_hooks')
const { Executor } = require('./lib/executor')
const logger = require('./lib/logger')
const { SqsSender, maxAttempts } = require('./lib/sqsSender')


const KNOWN_ENGINES = ['playwrightChrome131', 'webkit']

function getBrowserClass(engine) {
  const normalized = (engine || '').toLowerCase()
  if (!KNOWN_ENGINES.map(e => e.toLowerCase()).includes(normalized)) {
    logger.warn(`Unknown engine "${engine}", defaulting to chromium`)
    return require('./lib/chromiumBrowser').ChromiumBrowser
  }
  return normalized === 'webkit' ? require('./lib/webkitBrowser').WebkitBrowser : require('./lib/chromiumBrowser').ChromiumBrowser
}

const argv = require('minimist')(process.argv.slice(2));
const local = argv.local !== undefined ? argv.local.toLowerCase() === 'true' : false;
const jobFile = argv.file !== undefined;
const jobFileContent = argv['file-content'] !== undefined ? argv['file-content'] : false;
const outputFilepath = argv['output-filepath'] !== undefined ? argv['output-filepath'] : false;
const isSqs = !jobFile && !jobFileContent;

const sqsSender = new SqsSender(debug, local);

let message;

const fs = require('fs');
// When manually passed json file to the script. Used for testing.
if (jobFile) {
  try {
    const fileContent = fs.readFileSync(argv.file, 'utf8');
    // Example of SQS message https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html
    message = {
      "Body": fileContent,
      // Flag to save file locally and exit instead of creating thumbnails and uploading to S3.
      'local': local
    };
  } catch (err) {
    logger.error('Failed to read file', err);
  }
}

// We also accept job message as JSON encoded string. Used in local worker wrapper.
if (jobFileContent) {
  try {
    // Example of SQS message https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html
    message = {
      "Body": jobFileContent,
      // Flag to save file locally and exit instead of creating thumbnails and uploading to S3.
      'local': local
    };
  } catch (err) {
    logger.error('Failed to accept job message', err);
  }
}

function end () {
  try {
    // Remove tmp files.
    // func.cleanTmpDir()
  } catch (e) {
    logger.error('Failed to clean tmp directory', e)
  }
  process.exit(0)
}

process.once('SIGTERM', end)
process.once('SIGINT', end)
process.on('uncaughtException', (e) => {
  logger.error('UncaughtException', e)
  process.exit(6)
})
process.on('unhandledRejection', (reason, p) => {
  const normalizedReason = reason instanceof Error
    ? { message: reason.message, stack: reason.stack }
    : reason;

  logger.error('Unhandled Rejection at: Promise', {
    promiseType: p?.constructor?.name || 'UnknownPromise',
    reason: normalizedReason,
  })
});

(async () => {
  if (isSqs) {
    let messages = await sqsSender.fetchSQSJob();
    if (messages) {
      message = messages[0];
    }
  }

  if (!message) {
    logger.debug('No messages');
    return;
  }

  let browser = null
  let browserInstance = null
  let results = []
  let handlerTimeExecuteStart = performance.now();
  const executor = new Executor(debug, local);

  let shutdownTimeout = null;
  let shutdownDeadlineTs = handlerTimeExecuteStart + DEFAULT_TIMEOUT_MS;

  const triggerTimeout = async () => {
    try {
      const result = await executor.timeout(handlerTimeExecuteStart)
      executor.shutdown()
      logger.warn('Timeout', result);
      process.exit(1);
    } catch (e) {
      process.exit(1);
    }
  };

  const scheduleShutdown = (requestedTimeoutMs) => {
    if (shutdownTimeout) {
      clearTimeout(shutdownTimeout);
    }

    const numericCandidate = Number.isFinite(requestedTimeoutMs)
      ? requestedTimeoutMs
      : Number.parseInt(requestedTimeoutMs, 10);

    const requestedDuration = (Number.isFinite(numericCandidate) && numericCandidate > 0)
      ? numericCandidate
      : DEFAULT_TIMEOUT_MS;

    const effectiveDuration = Math.max(requestedDuration, DEFAULT_TIMEOUT_MS);
    const proposedDeadline = handlerTimeExecuteStart + effectiveDuration;

    if (proposedDeadline > shutdownDeadlineTs) {
      shutdownDeadlineTs = proposedDeadline;
    }

    const remainingMs = Math.max(Math.round(shutdownDeadlineTs - performance.now()), 0);

    if (debug) {
      logger.debug('scheduleShutdown', {
        requestedTimeoutMs,
        effectiveTimeoutMs: shutdownDeadlineTs - handlerTimeExecuteStart,
        remainingMs,
      });
    }

    if (remainingMs <= 0) {
      triggerTimeout().catch(() => process.exit(1));
      return;
    }

    shutdownTimeout = setTimeout(triggerTimeout, remainingMs);
  };

  scheduleShutdown(DEFAULT_TIMEOUT_MS);

  try {
    let proxy = null
    const data = JSON.parse(message.Body);

    const engineParam = data?.params?.engine || process.env.BROWSER_ENGINE || 'playwrightChrome131'
    browserInstance = new (getBrowserClass(engineParam))(debug, local)

    logger.defaultMeta.project_id = data?.project_id
    logger.defaultMeta.snapshot_id = data?.job_id
    logger.defaultMeta.job_id = data?.id
    logger.defaultMeta.breakpoint = data?.params?.breakpoint
    logger.defaultMeta.url = data?.params?.url

    logger.info('Start process', { message_body: data })

    if (data.params.proxyUrl) {
      proxy = data.params.proxyUrl;
    } else if (data.params.proxy === true || (data.params.proxy && data.params.proxy.type === 'default')) {
      proxy = process.env.PROXY;
    }

    const delaySec = Number(data?.params?.delay_before_screenshot || 0);
    const extraBufferMs = Math.min(Math.max(delaySec, 0) * 3000 + 120000, 20 * 60 * 1000);
    const baseHandler = Math.max(DEFAULT_TIMEOUT_MS, 5 * 60 * 1000 + extraBufferMs);

    scheduleShutdown(baseHandler);
    browser = await browserInstance.getBrowser(proxy)
    results = await run(message, browser, executor);
    // If we use local json file we are debugging.
    if (debug || jobFile || jobFileContent) {
      // logger.info('Executor result', results);
    }
    if (outputFilepath) {
      if (outputFilepath.includes('..')) {
        logger.error('Invalid output filepath: path traversal not allowed', { outputFilepath });
      } else {
        fs.writeFile(outputFilepath, JSON.stringify(results[0]), err => {
          if (err) {
            logger.error('Failed to output file', err);
          }
        });
      }
    }
  } catch (err) {
    if (shutdownTimeout) {
      clearTimeout(shutdownTimeout)
    }
    await closeBrowser(browser)
    await browserInstance?.closeProxy()

    logger.error('Failed to run executor', {
      errorMessage: err?.message || 'Unknown error',
      errorStack: err?.stack || 'No stack trace available',
    })

    return;
  }

  clearTimeout(shutdownTimeout)
  await closeBrowser(browser)
  await browserInstance?.closeProxy();

  if (isSqs && message) {
    await sqsSender.deleteSQSMessage(message);
  }
})()


/**
 * Close the browser.
 *
 * @param browser
 * @return {Promise<void>}
 */
const closeBrowser = async (browser) => {
  if (browser && typeof browser.close === 'function') {
    try {
      await browser.close()
    } catch (e) {
      logger.error('Failed to close browser', { error: e })
    }
  }
}

/**
 * Parse events and run executor.
 *
 * @param message
 * @param browser
 * @param executor
 * @return {Promise<[]>}
 */
const run = async (message, browser, executor) => {
  const results = []
  if (Object.hasOwn(message,'Body')) {
    const data = JSON.parse(message.Body);
    data.params.local = message.local;

    const result = await executor.run(browser, data)
    results.push(result)
  }
  return results
}
