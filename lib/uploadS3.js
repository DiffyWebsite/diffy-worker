const s3 = require("@aws-sdk/client-s3");
const path = require('path');
const fs = require('fs');

const s3region = process.env.APP_AWS_REGION || 'us-east-1';
const s3bucket = process.env.S3_BUCKET || 'diffy';
const s3baseUrl = 'https://s3.amazonaws.com/';

const s3Client = new s3.S3Client({ region: s3region });

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

        const readStream = fs.createReadStream(filename);
        params.Body = readStream;

        await s3Client.send(new s3.PutObjectCommand(params));

        const s3Url = `${s3baseUrl}${params.Bucket}/${params.Key}`;
        return s3Url;
    },

    uploadFileString: async function (filename, fileData) {

        let date = (new Date());
        const key = `${date.getFullYear()}/${date.getMonth()}/${date.getDate()}/${path.basename(filename)}`;

        const params = {
            Bucket: s3bucket,
            Key: key,
            ACL: 'public-read',
            ContentType: 'application/octet-stream',
            Body: fileData
        };
        await s3Client.send(new s3.PutObjectCommand(params));

        return `${s3baseUrl}${s3bucket}/${key}`;
    },
};
