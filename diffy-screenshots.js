// Example to run
// node diffy-screenshots.js --url=https://diffy.website

const debug = false

require('dotenv').config();

const { Logger } = require('./lib/logger')
const logger = new Logger(debug);

const { Jobs } = require('./lib/jobs')
const jobs = new Jobs(logger)

const { Api } = require('./lib/api.js')
let api

const process = require("process");
const fs = require("fs");

const apiKey = process.env.API_KEY || ''
if (apiKey == '') {
  console.error('Add Diffy API key to .env file. API_KEY=XXX');
  return;
}
const projectId = process.env.PROJECT_ID || ''
if (projectId == '') {
  console.error('Add Diffy API project ID .env file. PROJECT_ID=XXX');
  return;
}

const diffyUrl = 'https://app.diffy.website/api'
const diffyWebsiteUrl = 'https://app.diffy.website/#'

var argv = require('minimist')(process.argv.slice(2));


async function end () {
  try {
    // Remove tmp files.
    // func.cleanTmpDir()
  } catch (e) {
    console.error(e.message)
  }
  process.exit(1)
}

process.once('SIGTERM', end)
process.once('SIGINT', end)

process.on('uncaughtException', async (e) => {
  console.error('Unhandled exception:', e)
  await end()
});

process.on('unhandledRejection', async (reason, p) => {
  console.error('Unhandled Rejection at: Promise', p, 'reason:', reason)
  await end()
});

(async () => {
  if (argv.url === undefined) {
    console.error('Provide --url parameter. Example --url="https://diffy.website"');
  }
  const screenshotName = argv['screenshot-name'] ? argv['screenshot-name'] : argv.url;
  try {
    api = new Api(diffyUrl, apiKey, projectId, logger)
    await api.login()
    const project = await api.getProject()
    const jobsList = jobs.prepareJobs(argv.url, project)

    const execSync = require('node:child_process').execSync;
    const outputFilepath = '/tmp/screenshot-results.json';
    const inputFilepath = '/tmp/screenshot-input.json';
    let uploadItems = [];
    for (let i = 0; i < jobsList.length; i++) {
      let jsonJob = JSON.stringify(jobsList[i]);
      try {
        fs.writeFileSync(inputFilepath, jsonJob);
      } catch (err) {
        console.error(err);
      }
      console.log('Staring screenshot ' + (i + 1) + ' of ' + jobsList.length);
      await execSync('node ./index.js --local=true --output-filepath=\'' + outputFilepath + '\' --file=\'' + inputFilepath + '\'', {stdio: 'inherit'});
      console.log('Completed screenshot ' + (i + 1) + ' of ' + jobsList.length);
      const resultsContent = fs.readFileSync(outputFilepath, 'utf8');
      console.log(resultsContent);
      let result = JSON.parse(resultsContent);
      let uploadItem = {
        status: true,
        breakpoint: jobsList[i].params.breakpoint,
        uri: jobsList[i].params.uri,
        filename: result.screenshot,
        htmlFilename: result.html,
        jsConsoleFilename: result.jsConsole
      };
      uploadItems.push(uploadItem);
    }

    // Send screenshots to Diffy.
    screenshotId = await api.uploadScreenshots(screenshotName, uploadItems)
    console.log('Diffy screenshot url: ', `${diffyWebsiteUrl}/snapshots/${screenshotId}`)

    await end()
  } catch (e) {
    console.error('ERROR:', e.message)
    await end()
  }
})()
