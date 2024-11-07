// Example to run
// node diffy-screenshots.js --url=https://diffy.website
const process = require("process");
const debug = !!process.env.DEBUG;

const { Logger } = require('./lib/logger')
const logger = new Logger(debug);

const { Jobs } = require('./lib/jobs')
const jobs = new Jobs(logger)

const { Api } = require('./lib/api.js')
const fs = require("fs/promises");

const apiKey = process.env.DIFFY_API_KEY || ''
if (apiKey == '') {
  console.log('Add Diffy API key to .env file. DIFFY_API_KEY=XXX')
  return;
}
const projectId = process.env.DIFFY_PROJECT_ID || ''
if (projectId == '') {
  console.log('Add Diffy API project ID .env file. DIFFY_PROJECT_ID=XXX')
  return;
}

const diffyUrl = 'https://app.diffy.website/api'
const diffyWebsiteUrl = 'https://app.diffy.website/#'

// Staging URLs
// const diffyUrl = 'https://stage.diffy.website/api'
// const diffyWebsiteUrl = 'https://stage.diffy.website/#'

const argv = require('minimist')(process.argv.slice(2));


async function end (code = 1) {
  try {
    // Remove tmp files.
    // func.cleanTmpDir()
  } catch (e) {
    console.log('Failed to remove tmp files', e)
  }
  process.exit(code)
}

process.once('SIGTERM', end)
process.once('SIGINT', end)

process.on('uncaughtException', async (e) => {
  console.log('UncaughtException', e)
  await end()
});

process.on('unhandledRejection', async (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, reason)
  await end()
});

(async () => {
  if (argv.url === undefined) {
    console.log('Provide --url parameter. Example --url="https://diffy.website"');
  }
  const screenshotName = argv['screenshot-name'] ? argv['screenshot-name'] : argv.url;
  try {
    const api = new Api(diffyUrl, apiKey, projectId, logger)
    await api.login()
    const project = await api.getProject()
    const jobsList = jobs.prepareJobs(argv.url, project)

    const util = require('node:util');
    const exec = util.promisify(require('node:child_process').exec);

    const outputFilepath = '/tmp/screenshot-results.json';
    const inputFilepath = '/tmp/screenshot-input.json';
    let uploadItems = [];

    for (let index = 0; index < jobsList.length; index++) {
      const job = jobsList[index];
      let jsonJob = JSON.stringify(job);
      try {
        await fs.writeFile(inputFilepath, jsonJob);
      } catch (err) {
        console.log('Failed to write file', err);
      }
      console.log(`Starting screenshot ${(index + 1)} of ${jobsList.length}`);
      await exec('node ./index.js --env-file=.env --local=true --output-filepath=\'' + outputFilepath + '\' --file=\'' + inputFilepath + '\'', {stdio: 'inherit'});
      console.log(`Completed screenshot ${(index + 1)} of ${jobsList.length}`);
      const resultsContent = await fs.readFile(outputFilepath, 'utf8');
      console.log('Output file content', resultsContent);
      let result = JSON.parse(resultsContent);
      let uploadItem = {
        status: true,
        breakpoint: job.params.breakpoint,
        uri: job.params.uri,
        filename: result.screenshot,
        htmlFilename: result.html,
        jsConsoleFilename: result.jsConsole
      };
      uploadItems.push(uploadItem);
    }

    // Send screenshots to Diffy.
    screenshotId = await api.uploadScreenshots(screenshotName, uploadItems)
    console.log(`Diffy screenshot url: ${diffyWebsiteUrl}/snapshots/${screenshotId}`)

    await end(0)
  } catch (e) {
    console.log('Failed to run executor', e)
    await end()
  }
})()
