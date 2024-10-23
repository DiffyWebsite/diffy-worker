
const process = require('process');
const debug = !!process.env.DEBUG;

const { Logger } = require('../lib/logger')
const uploadS3 = require("../lib/uploadS3");
const filename = '/app/screenshot-1714780252-73939221.webp';

const logger = new Logger(debug);

(async () => {
  s3Url = await uploadS3.upload(filename).catch((err) => {
    throw new Error('Can\'t upload screenshot: ' + err.name + ': ' + (err && Object.hasOwn(err, 'message')) ? err.message : err)
  })

  logger.info('S3 URL', s3Url);
})()
