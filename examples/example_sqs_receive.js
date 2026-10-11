
const process = require('process');
const debug = !!process.env.DEBUG;

const logger = require('../lib/logger')
const { SqsSender } = require('../lib/sqsSender');

(async () => {
  const sqsSender = new SqsSender(debug, false);
  const job = await sqsSender.fetchSQSJob();
  logger.info('Received', job);

  if (job) {
    await sqsSender.deleteSQSMessage(job.message, job.queueURL);
  }
})()
