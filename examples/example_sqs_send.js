
const process = require('process');

const { SqsSender, maxAttempts } = require('../lib/sqsSender')
const { Logger } = require('./lib/logger')
const fs = require("fs");

const logger = new Logger()

if (process.argv[2] === undefined) {
  console.log('Error. Specify file to json encoded job to post to SQS')
  process.exit();
}
let fileContent;
try {
  fileContent = fs.readFileSync(process.argv[2], 'utf8');
} catch (err) {
  logger.error(err);
  process.exit();
}

(async () => {
  const sqsSender = new SqsSender(true, false);
  const result = await sqsSender.sendSQSJob(JSON.parse(fileContent));
  console.log(result);
  console.log('Job is sent ' + fileContent);
})()
