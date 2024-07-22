const aws = require('aws-sdk')
const { performance } = require('perf_hooks')
const { Logger } = require('./logger')
const funcPerform = require('./funcPerform.js')

const maxAttempts = process.env.MAX_ATTEMPTS || 3

class SqsSender {

  sqs = null
  debug = false
  local = false

  constructor (debug, local) {
    this.sqs = new aws.SQS({
      region: 'us-east-1'
    })
    this.maxAttempts = maxAttempts
    this.debug = debug
    this.local = local
    this.logger = new Logger(this.debug)
  }

  /**
   * Send to SQS attempts.
   *
   * @param result
   * @param timeExecuteStart
   * @return {Promise<unknown>}
   */
  async sendSQSAttempts (result, timeExecuteStart = 0) {
    result = this.attachTimeExecute(result, timeExecuteStart)
    if (result.hasOwnProperty('attempts')) {
      result.attempts = parseInt(result.attempts) + 1
      this.logger.log('sendSQSAttempts', result.attempts)
    }

    const sqsParams = {
      MessageBody: JSON.stringify(result),
      QueueUrl: 'https://sqs.' + process.env.APP_AWS_REGION + '.amazonaws.com/' + process.env.AWS_ACCOUNT_ID + '/' + process.env.JOB_QUEUE_NAME
    }

    return this.sendToSqs(sqsParams, 'Fail Send SQS Message to sendSQSAttempts')
  };

  /**
   * Send job to SQS.
   *
   * @param result
   * @param timeExecuteStart
   * @return {Promise<unknown>}
   */
  async sendSQSJob (data, timeExecuteStart = 0) {
    data = this.attachTimeExecute(data, timeExecuteStart)

    console.log('Sending job to SQS: ', data)

    const sqsParams = {
      MessageBody: JSON.stringify(data),
      QueueUrl: 'https://sqs.' + process.env.APP_AWS_REGION + '.amazonaws.com/' + process.env.AWS_ACCOUNT_ID + '/' + process.env.JOB_QUEUE_NAME
    }

    return this.sendToSqs(sqsParams, 'Fail Send SQS Message to sendSQSJob')
  };

  /**
   * Fetch message from SQS.
   *
   * @param result
   * @param timeExecuteStart
   * @return {Promise<unknown>}
   */
  async fetchSQSJob () {
    const queueURL = 'https://sqs.' + process.env.APP_AWS_REGION + '.amazonaws.com/' + process.env.AWS_ACCOUNT_ID + '/' + process.env.JOB_QUEUE_NAME;
    var params = {
      AttributeNames: ["SentTimestamp"],
      MaxNumberOfMessages: 1,
      MessageAttributeNames: ["All"],
      QueueUrl: queueURL,
      VisibilityTimeout: 120,
      WaitTimeSeconds: 20
    };

    const resp = await this.sqs.receiveMessage(params).promise();
    return resp.Messages;
  };

  /**
   * Delete a message in SQS.
   *
   * @param result
   * @param timeExecuteStart
   * @return {Promise<unknown>}
   */
  async deleteSQSMessage (message) {
    const queueURL = 'https://sqs.' + process.env.APP_AWS_REGION + '.amazonaws.com/' + process.env.AWS_ACCOUNT_ID + '/' + process.env.JOB_QUEUE_NAME;
    var deleteParams = {
      QueueUrl: queueURL,
      ReceiptHandle: message.ReceiptHandle,
    };
    this.sqs.deleteMessage(deleteParams, function (err, data) {
      if (err) {
        console.log("Delete Error", err);
      } else {
        console.log("Message Deleted", data);
      }
    });
  };

  /**
   * Send results to SQS.
   *
   * @param result
   * @param timeExecuteStart
   * @return {Promise<unknown>}
   */
  async sendSQSResult (result, timeExecuteStart = 0) {
    result = this.attachTimeExecute(result, timeExecuteStart)

    console.log('Sending result to SQS: ', result)

    const sqsParams = {
      MessageBody: JSON.stringify(result),
      QueueUrl: 'https://sqs.' + process.env.APP_AWS_REGION + '.amazonaws.com/' + process.env.AWS_ACCOUNT_ID + '/' + process.env.RESULTS_QUEUE_NAME
    }

    return this.sendToSqs(sqsParams, 'Fail Send SQS Message to sendSQSResult')
  };

  /**
   * Resend to SQS.
   *
   * @param data
   * @param timeExecuteStart
   * @param error
   * @return {Promise<unknown>}
   */
  async resend (data, timeExecuteStart, error = '') {
    return (data.hasOwnProperty('attempts') && parseInt(data.attempts) < this.maxAttempts) ?
      this.sendSQSAttempts(data, timeExecuteStart) :
      this.prepareAndSendError(data, timeExecuteStart, error)
  };

  /**
   * Prepare and send error after 3 attempts.
   *
   * @param data
   * @param timeExecuteStart
   * @param error
   * @return {Promise<unknown>}
   */
  async prepareAndSendError(data, timeExecuteStart, error) {
    const result = await funcPerform.saveError(data, data.params, (error && error.hasOwnProperty('message')) ? error.message : error.toString())
    funcPerform.debugLog('prepareAndSendError', data.params, result)
    return this.sendSQSResult(result, timeExecuteStart)
  }

  /**
   * Send data to sqs.
   *
   * @param sqsParams
   * @param errorMessage
   * @return {Promise<unknown>}
   */
  async sendToSqs (sqsParams, errorMessage) {
    return new Promise((resolve, reject) => {
      if (this.local) {
        this.logger.log(sqsParams);
      } else {
        this.sqs.sendMessage(sqsParams, (err, data) => {
          if (err) {
            this.logger.error('error:', errorMessage, err)
            reject(err.message)
          } else {
            resolve(data)
          }
        })
      }
    })
  }

  /**
   * Attach timeExecution to result.
   *
   * @param result
   * @param timeExecuteStart
   * @return {*}
   */
  attachTimeExecute (result, timeExecuteStart) {
    const timeExecuteEnd = performance.now()
    const timeExecute = Math.round((timeExecuteEnd - timeExecuteStart) / 1000)
    if (result.params.hasOwnProperty('timeExecute')) {
      result.params.timeExecute = parseInt(result.params.timeExecute) + timeExecute
    } else {
      result.params.timeExecute = timeExecute
    }
    return result
  }

  shutdown () {
    this.sqs = null
  }

}

module.exports = { SqsSender, maxAttempts }
