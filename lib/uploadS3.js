global.Promise = require('bluebird');
const aws = require('aws-sdk');
const path = require('path');
const fs = require('fs');

const s3apiVersion = '2013-04-01';
const s3accessKeyId = process.env.S3_ACCESS_KEY_ID || false;
const s3accessKeySecret = process.env.SE_ACCESS_KEY_SECRET || false;
const s3region = process.env.APP_AWS_REGION || false;
const s3bucket = process.env.S3_BUCKET || false;
const s3baseUrl = 'https://s3.amazonaws.com/';

aws.config.credentials = new aws.Credentials(
  s3accessKeyId, // Your access key ID
  s3accessKeySecret, // Your secret access key
);

// Define your service region.
aws.config.region = s3region;

const s3 = new aws.S3({
  apiVersion: s3apiVersion
});

module.exports = {
    upload: async function (filename) {

        let date = (new Date());
        const key = date.getFullYear() + '/' + date.getMonth() + '/' + date.getDate() + '/' + path.basename(filename);

        const params = {
            Bucket: s3bucket,
            Key: key,
            Body: 'Plain text',
            ACL: 'public-read',
            ContentType: 'binary',
            //CacheControl: 'max-age=172800'
        };
        return Promise
            .promisify(fs.readFile, {
                context: fs
            })(filename)
            .then((fileData) => {
                params.Body = fileData;
                return Promise
                    .promisify(s3.putObject, {
                        context: s3
                    })(params)
                    .then(() => {
                        return s3baseUrl + s3bucket + "/" + key;
                    });

            });
    },

    uploadFileString: async function (filename, fileData) {

        let date = (new Date());
        const key = date.getFullYear() + '/' + date.getMonth() + '/' + date.getDate() + '/' + path.basename(filename);

        const params = {
            Bucket: s3bucket,
            Key: key,
            ACL: 'public-read',
            ContentType: 'application/octet-stream',
            Body: fileData
        };
        return Promise
            .promisify(s3.putObject, {
                context: s3
            })(params)
            .then(() => {
                return s3baseUrl + s3bucket + "/" + key;
            });
    },
};
