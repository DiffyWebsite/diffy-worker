Scripts used to test various subsystems in isolation i.e. puppeteer, s3 uploads, sqs

To run test scripts make sure to copy .env file to the "examples" folder.

SQS tests
```shell
node example_sqs_send.js ../test_jobs/screenshot1.json
node example_sqs_receive.js
```
