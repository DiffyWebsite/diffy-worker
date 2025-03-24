const { performance } = require('perf_hooks')
const funcPerform = require('./funcPerform.js')
const { SqsSender, maxAttempts } = require('./sqsSender')
const logger = require('./logger')

class Executor {

  item = null
  debug = false
  local = false

  constructor (debug = false, local = false) {
    this.sqsSender = new SqsSender(debug,local)
    this.debug = debug
    this.logger = logger
    this.local = local
  }

  /**
   * Execute screenshot job.
   *
   * @param browser
   * @param data
   * @return {Promise<*|null>}
   */
  async run (browser, data) {
    let result = null
    let timeExecuteStart

    timeExecuteStart = performance.now()
    this.item = data
    try {
      result = await funcPerform.perform(browser, data, data.params)

      if (this.local) {
        return result
      }

      if (result?.status) {
        await this.sqsSender.sendSQSResult(result, timeExecuteStart)
      } else {
        this.logger.warn('Run error result', { params: data.params, result })

        await this.sqsSender.resend(data, timeExecuteStart, Object.hasOwn(result, 'err') ? result.err : result)
      }
      return result
    } catch (e) {
      if (this.local) {
        // this.logger.error(
        //     data.params.breakpoint + ':' + data.params.url,
        //     'Failed to run executor',
        //     {
        //       errorMessage: e?.message || 'Unknown error',
        //       errorStack: e?.stack || 'No stack trace available',
        //     }
        // );

        return result
      }

      this.logger.debug('Run error result', { params: data.params, error: e })

      await this.sqsSender.resend(data, timeExecuteStart, e)
      return result
    }
  }

  /**
   * Timeout handler.
   *
   * @param handlerTimeExecuteStart
   * @return {Promise<*>}
   */
  async timeout (handlerTimeExecuteStart) {
    if (this.item?.attempts && this.item.attempts < maxAttempts) {
      this.logger.info('timeout-resend')
      await this.sqsSender.resend(this.item, handlerTimeExecuteStart)
      throw new Error(`Timeout: resend to sqs. Attempts: ${this.item.attempts}`)
    } else if (this.item?.params) {
      this.logger.info('timeout-send-result')
      const result = await funcPerform.saveTimeoutError(this.item, this.item.params)
      await this.sqsSender.sendSQSResult(result, handlerTimeExecuteStart)
      return result
    } else {
      let data = this.item
      try {
        data = JSON.stringify(data)
      } catch (e) {
        this.logger.error('Failed to stringify data', { error: e })
      }

      throw new Error(`Timeout: Wrong params format: ${data}`)
    }
  }

  shutdown () {
    this.item = null
  }

}

module.exports = { Executor }
