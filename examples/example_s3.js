require('dotenv').config();
const process = require('process');

const uploadS3 = require("../lib/uploadS3");
const filename = '/app/screenshot-1714780252-73939221.webp';

(async () => {
  s3Url = await uploadS3.upload(filename).catch((err) => {
    throw new Error('Can\'t upload screenshot: ' + err.name + ': ' + (err && err.hasOwnProperty('message')) ? err.message : err)
  })

  console.log(s3Url);

})()
