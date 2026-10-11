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
  'JOB_QUEUE_NAME',
  'FALLBACK_JOB_QUEUE_NAME'
]
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))

const { SqsSender } = require('../lib/sqsSender')

describe('SqsSender queue selection', () => {
  beforeEach(() => {
    process.env.APP_AWS_REGION = 'us-east-1'
    process.env.AWS_ACCOUNT_ID = '123456789012'
    process.env.JOB_QUEUE_NAME = 'BigQueue'
    delete process.env.FALLBACK_JOB_QUEUE_NAME
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

  it('keeps the existing long poll behavior without a fallback queue', async () => {
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

  it('uses the primary queue without polling fallback when primary has work', async () => {
    process.env.FALLBACK_JOB_QUEUE_NAME = 'DefaultQueue'
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
    assert.equal(calls[0].WaitTimeSeconds, 1)
  })

  it('polls fallback when the primary queue is empty', async () => {
    process.env.FALLBACK_JOB_QUEUE_NAME = 'DefaultQueue'
    const sender = new SqsSender(false, false)
    const calls = []
    sender.sqs = {
      receiveMessage: async params => {
        calls.push(params)
        return calls.length === 1
          ? {}
          : { Messages: [{ Body: 'fallback' }] }
      }
    }

    const job = await sender.fetchSQSJob()

    assert.equal(job.message.Body, 'fallback')
    assert.equal(job.queueURL, sender.fallbackQueueURL)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].QueueUrl, sender.queueURL)
    assert.equal(calls[0].WaitTimeSeconds, 1)
    assert.equal(calls[1].QueueUrl, sender.fallbackQueueURL)
    assert.equal(calls[1].WaitTimeSeconds, 20)
  })

  it('returns no job when both queues are empty', async () => {
    process.env.FALLBACK_JOB_QUEUE_NAME = 'DefaultQueue'
    const sender = new SqsSender(false, false)
    sender.sqs = { receiveMessage: async () => ({}) }

    assert.equal(await sender.fetchSQSJob(), null)
  })

  it('deletes a fallback message from its source queue', async () => {
    const sender = new SqsSender(false, false)
    let deleteParams
    sender.sqs = {
      deleteMessage: async params => {
        deleteParams = params
        return { ok: true }
      }
    }
    const fallbackQueueURL = sender.buildQueueURL('DefaultQueue')

    await sender.deleteSQSMessage({ ReceiptHandle: 'receipt' }, fallbackQueueURL)

    assert.deepEqual(deleteParams, {
      QueueUrl: fallbackQueueURL,
      ReceiptHandle: 'receipt'
    })
  })

  it('retries a failed job on the queue that supplied it', async () => {
    const fallbackQueueURL = 'https://sqs.us-east-1.amazonaws.com/123456789012/DefaultQueue'
    const sender = new SqsSender(false, false, fallbackQueueURL)
    let sendParams
    sender.sqs = {
      sendMessage: (params, callback) => {
        sendParams = params
        callback(null, { ok: true })
      }
    }
    const data = { attempts: 1, params: {} }

    await sender.resend(data, 0)

    assert.equal(sendParams.QueueUrl, fallbackQueueURL)
    assert.equal(JSON.parse(sendParams.MessageBody).attempts, 2)
  })

  it('retries a primary job on the primary queue', async () => {
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
