const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('node:test')

const loggerPath = require.resolve('../lib/logger')
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {}
  }
}

const envKeys = [
  'APP_AWS_REGION',
  'AWS_ACCOUNT_ID',
  'JOB_QUEUE_NAME'
]
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))

const { SqsSender } = require('../lib/sqsSender')

describe('SqsSender job queue', () => {
  beforeEach(() => {
    process.env.APP_AWS_REGION = 'us-east-1'
    process.env.AWS_ACCOUNT_ID = '123456789012'
    process.env.JOB_QUEUE_NAME = 'ScreenshotJobsChrome158'
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }
  })

  it('long polls the job queue', async () => {
    const sender = new SqsSender(false, false)
    const calls = []
    sender.sqs = {
      receiveMessage: async params => {
        calls.push(params)
        return { Messages: [{ Body: 'primary' }] }
      }
    }

    const job = await sender.fetchSQSJob()

    assert.equal(job.message.Body, 'primary')
    assert.equal(job.queueURL, sender.queueURL)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].WaitTimeSeconds, 20)
  })

  it('returns no job when the queue is empty', async () => {
    const sender = new SqsSender(false, false)
    sender.sqs = { receiveMessage: async () => ({}) }

    assert.equal(await sender.fetchSQSJob(), null)
  })

  it('deletes a message from the job queue', async () => {
    const sender = new SqsSender(false, false)
    let deleteParams
    sender.sqs = {
      deleteMessage: async params => {
        deleteParams = params
        return { ok: true }
      }
    }

    await sender.deleteSQSMessage({ ReceiptHandle: 'receipt' })

    assert.deepEqual(deleteParams, {
      QueueUrl: sender.buildQueueURL('ScreenshotJobsChrome158'),
      ReceiptHandle: 'receipt'
    })
  })

  it('retries a failed job on the job queue', async () => {
    const sender = new SqsSender(false, false)
    let sendParams
    sender.sqs = {
      sendMessage: (params, callback) => {
        sendParams = params
        callback(null, { ok: true })
      }
    }

    await sender.resend({ attempts: 1, params: {} }, 0)

    assert.equal(sendParams.QueueUrl, sender.queueURL)
  })
})
