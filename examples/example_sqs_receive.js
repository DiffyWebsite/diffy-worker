
const process = require('process');
const debug = !!process.env.DEBUG;

const { Logger } = require('../lib/logger')
const { SqsSender, maxAttempts } = require('../lib/sqsSender');

const logger = new Logger(debug);

(async () => {
  const sqsSender = new SqsSender(true, false);
  let messages = await sqsSender.fetchSQSJob();
  logger.log('Received', messages);

  await sqsSender.deleteSQSMessage(messages[0]);
})()

