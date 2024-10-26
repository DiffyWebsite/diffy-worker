
const process = require('process');
const debug = !!process.env.DEBUG;

const { SqsSender, maxAttempts } = require('../lib/sqsSender')
const { Logger } = require('../lib/logger')
const fs = require("fs");

const logger = new Logger(debug)

if (process.argv[2] === undefined) {
  logger.error('Error. Specify file to json encoded job to post to SQS')
  process.exit();
}
let fileContent;
try {
  fileContent = fs.readFileSync(process.argv[2], 'utf8');
} catch (err) {
  logger.error('Failed to read file', err);
  process.exit();
}

(async () => {
  const sqsSender = new SqsSender(true, false);
  const result = await sqsSender.sendSQSJob(JSON.parse(fileContent));
  
  logger.log('Job is sent', result, fileContent);
})()
