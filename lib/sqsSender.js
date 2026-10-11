const { SQS } = require('@aws-sdk/client-sqs');
const { performance } = require('perf_hooks')
const logger = require('./logger')
const funcPerform = require('./funcPerform.js')

const maxAttempts = process.env.MAX_ATTEMPTS || 3
const PRIMARY_QUEUE_WAIT_TIME_SECONDS = 1
const QUEUE_WAIT_TIME_SECONDS = 20

class SqsSender {

  sqs = null
  debug = false
  local = false
  queueURL = ''
  fallbackQueueURL = ''

  constructor (debug, local, queueURL = '') {
    this.sqs = new SQS({
      region: process.env.APP_AWS_REGION || 'diffy',
    })
    this.maxAttempts = maxAttempts
    this.debug = debug
    this.local = local
    this.logger = logger
    this.queueURL = queueURL || this.buildQueueURL(process.env.JOB_QUEUE_NAME)
    this.fallbackQueueURL = process.env.FALLBACK_JOB_QUEUE_NAME
      ? this.buildQueueURL(process.env.FALLBACK_JOB_QUEUE_NAME)
      : ''
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
    if (Object.hasOwn(result, 'attempts')) {
      result.attempts = Number.parseInt(result.attempts) + 1

      this.logger.debug(`sendSQSAttempts ${result.attempts}`, { result })
    }

    const sqsParams = {
      MessageBody: JSON.stringify(result),
      QueueUrl: this.queueURL
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

    this.logger.debug('Sending job to SQS', { data })

    const sqsParams = {
      MessageBody: JSON.stringify(data),
      QueueUrl: this.queueURL
    }

    return this.sendToSqs(sqsParams, 'Fail Send SQS Message to sendSQSJob')
  };

  /**
   * Fetch a message from the primary queue, falling back when configured.
   *
   * @return {Promise<{message: unknown, queueURL: string}|null>}
   */
  async fetchSQSJob () {
    const primaryWaitTime = this.fallbackQueueURL
      ? PRIMARY_QUEUE_WAIT_TIME_SECONDS
      : QUEUE_WAIT_TIME_SECONDS
    const primaryMessage = await this.fetchMessageFromQueue(this.queueURL, primaryWaitTime)

    if (primaryMessage) {
      this.logSelectedQueue(this.queueURL, false)
      return { message: primaryMessage, queueURL: this.queueURL }
    }

    if (!this.fallbackQueueURL) {
      return null
    }

    const fallbackMessage = await this.fetchMessageFromQueue(
      this.fallbackQueueURL,
      QUEUE_WAIT_TIME_SECONDS
    )

    if (!fallbackMessage) {
      return null
    }

    this.logSelectedQueue(this.fallbackQueueURL, true)
    return { message: fallbackMessage, queueURL: this.fallbackQueueURL }
  };

  /**
   * Fetch one message from a queue.
   *
   * @param queueURL
   * @param waitTimeSeconds
   * @return {Promise<unknown|null>}
   */
  async fetchMessageFromQueue (queueURL, waitTimeSeconds) {
    const params = {
      AttributeNames: ['SentTimestamp'],
      MaxNumberOfMessages: 1,
      MessageAttributeNames: ['All'],
      QueueUrl: queueURL,
      VisibilityTimeout: 120,
      WaitTimeSeconds: waitTimeSeconds
    }

    const resp = await this.sqs.receiveMessage(params)
    return resp.Messages?.[0] || null
  }

  /**
   * Delete a message in SQS.
   *
   * @param message
   * @param queueURL
   * @return {Promise<unknown>}
   */
  async deleteSQSMessage (message, queueURL = this.queueURL) {
    const deleteParams = {
      QueueUrl: queueURL,
      ReceiptHandle: message.ReceiptHandle
    }

    try {
      return await this.sqs.deleteMessage(deleteParams)
    } catch (error) {
      this.logger.error('Delete Error', { error })
    }
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

    logger.info('Sending result to SQS', {
      time_execute: result.params?.timeExecute,
      result: result.item_result
    })

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
    return (Object.hasOwn(data, 'attempts') && Number.parseInt(data.attempts) < this.maxAttempts) ?
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
    const result = await funcPerform.saveError(data, data.params, (error && Object.hasOwn(error, 'message')) ? error.message : error.toString())

    this.logger.debug('prepareAndSendError', { params: data.params, result })

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
        this.logger.debug('SQS Params', { sqsParams });
      } else {
        this.sqs.sendMessage(sqsParams, (err, data) => {
          if (err) {
            this.logger.error(errorMessage, { error: err })
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
    if (Object.hasOwn(result.params, 'timeExecute')) {
      result.params.timeExecute = Number.parseInt(result.params.timeExecute) + timeExecute
    } else {
      result.params.timeExecute = timeExecute
    }
    return result
  }

  /**
   * Build an SQS queue URL from a queue name.
   *
   * @param queueName
   * @return {string}
   */
  buildQueueURL (queueName) {
    return `https://sqs.${process.env.APP_AWS_REGION}.amazonaws.com/${process.env.AWS_ACCOUNT_ID}/${queueName}`
  }

  /**
   * Log which queue supplied the job without exposing the account or full URL.
   *
   * @param queueURL
   * @param fallback
   */
  logSelectedQueue (queueURL, fallback) {
    this.logger.info('Received screenshot job', {
      queue_name: queueURL.split('/').pop(),
      fallback
    })
  }

  shutdown () {
    this.sqs = null
  }

}

module.exports = { SqsSender, maxAttempts }
