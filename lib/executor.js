const { performance } = require('perf_hooks')
const funcPerform = require('./funcPerform.js')
const { SqsSender, maxAttempts } = require('./sqsSender')
const { Logger } = require('./logger')

class Executor {

  item = null
  debug = false
  local = false

  constructor (debug = false, local = false) {
    this.sqsSender = new SqsSender(debug,local)
    this.debug = debug
    this.logger = new Logger(this.debug)
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

      if (result && result.hasOwnProperty('status') && result.status) {
        await this.sqsSender.sendSQSResult(result, timeExecuteStart)
      } else {
        funcPerform.debugLog('Run error result', data.params, result)
        await this.sqsSender.resend(data, timeExecuteStart, result.hasOwnProperty('err') ? result.err : result)
      }
      return result
    } catch (e) {
      if (this.local) {
        this.logger.error(e)
        return result
      }

      funcPerform.debugLog('Run error', data.params, e)

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
    this.logger.log('timeout: ', this.item)
    if (this.item && this.item.hasOwnProperty('attempts') && this.item.attempts < maxAttempts) {
      this.logger.log('timeout-resend')
      await this.sqsSender.resend(this.item, handlerTimeExecuteStart)
      throw new Error(`Timeout: resend to sqs. Attempts: ${this.item.attempts}`)
    } else if (this.item && this.item.hasOwnProperty('params')) {
      this.logger.log('timeout-send-result')
      const result = await funcPerform.saveTimeoutError(this.item, this.item.params)
      await this.sqsSender.sendSQSResult(result, handlerTimeExecuteStart)
      return result
    } else {
      let data = this.item
      try {
        data = JSON.stringify(data)
      } catch (e) {
        this.logger.error('timeout-error', e)
      }

      throw new Error(`Timeout: Wrong params format: ${data}`)
    }
  }

  shutdown () {
    this.item = null
  }

}

module.exports = { Executor }
