// Script has following optional parameters:
// file -- path to local json file with arguments for creating screenshots
// local -- whether to store resulting image locally or upload it to AWS (Diffy's production default mode)
// file-content -- if we pass job file as json as parameter
// output-filepath -- path to a file to save the results in json format. Used by wrapper.

const timeout = 10 * 60 * 1000; // 10 minutes timeout

const process = require('process');
const debug = !!process.env.DEBUG;

const { performance } = require('perf_hooks')
const { Executor } = require('./lib/executor')
const { Logger } = require('./lib/logger')
const { ChromiumBrowser } = require('./lib/chromiumBrowser')
const { SqsSender, maxAttempts } = require('./lib/sqsSender')

const argv = require('minimist')(process.argv.slice(2));
const local = argv.local ? argv.local : false;
const jobFile = argv.file !== undefined;
const jobFileContent = argv['file-content'] !== undefined ? argv['file-content'] : false;
const outputFilepath = argv['output-filepath'] !== undefined ? argv['output-filepath'] : false;
const isSqs = !jobFile && !jobFileContent;

const sqsSender = new SqsSender(debug, local);

const logger = new Logger();

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
    logger.error(err);
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
    logger.error(err);
  }
}

function end () {
  try {
    // Remove tmp files.
    // func.cleanTmpDir()
  } catch (e) {
    logger.error(e)
  }
  process.exit(1)
}

process.once('SIGTERM', end)
process.once('SIGINT', end)
process.on('uncaughtException', (e) => {
  logger.error(e)
  process.exit(6)
})
process.on('unhandledRejection', (reason, p) => {
  logger.error(`Unhandled Rejection at: Promise ${p}`, reason)
});

(async () => {
  if (isSqs) {
    let messages = await sqsSender.fetchSQSJob();
    message = messages[0];
  }

  let browser = null
  let results = []
  let handlerTimeExecuteStart = performance.now();
  const executor = new Executor(debug, local);
  const chromiumBrowser = new ChromiumBrowser(debug, local)

  // Stop process after a timeout.
  const shutdownTimeout = setTimeout(async () => {
    try {
      const result = await executor.timeout(handlerTimeExecuteStart)
      executor.shutdown()
      console.log(result);
      process.exit(1); // Failure code returned.
    } catch (e) {
      console.log(e);
      process.exit(1); // Failure code returned.
    }
  }, timeout);

  try {
    const proxy = process.env.PROXY;
    browser = await chromiumBrowser.getBrowser(proxy)
    results = await run(message, browser, executor);
    // If we use local json file we are debugging.
    if (debug || jobFile || jobFileContent) {
      console.log(results);
    }
    if (outputFilepath) {
      fs.writeFile(outputFilepath, JSON.stringify(results[0]), err => {
        if (err) {
          logger.error(err);
        }
      });
    }
  } catch (err) {
    await closeBrowser(browser)
    await chromiumBrowser.closeProxy()
    return console.log(err)
  }

  clearTimeout(shutdownTimeout)
  await closeBrowser(browser)
  await chromiumBrowser.closeProxy();

  if (isSqs) {
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
  if (browser !== null) {
    try {
      await browser.close()
    } catch (e) {
      logger.error(e)
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
