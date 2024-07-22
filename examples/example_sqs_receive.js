require('dotenv').config();
const process = require('process');

const { SqsSender, maxAttempts } = require('../lib/sqsSender');

(async () => {
  const sqsSender = new SqsSender(true, false);
  let messages = await sqsSender.fetchSQSJob();
  console.log(messages, 'received');

  await sqsSender.deleteSQSMessage(messages[0]);
})()

