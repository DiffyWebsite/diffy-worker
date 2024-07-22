class Logger {

  debug = false

  constructor (debug = false) {
    this.debug = debug
  }

  log (item, additionalItem = '', additionalItem2 = '') {
    if (this.debug) {
      console.log(item, additionalItem, additionalItem2)
    }
  }

  error (item, additionalItem = '', additionalItem2 = '') {
    console.error(item, additionalItem, additionalItem2)
  }

}

module.exports = { Logger }
