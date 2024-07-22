// const chromium = require('@sparticuz/chromium')
const proxyChain = require('proxy-chain')
const puppeteer = require('puppeteer-core')

class ChromiumBrowser {
  args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  browser = null
  debug = false
  local = false

  // This is where Chromium got installed in the docker box.
  localExecutivePath = '/usr/bin/chromium-browser'
  anonymizedProxy = null

  constructor (debug = false, local = false) {
    this.debug = debug
    this.local = local
    // this.args = chromium.args
    // https://peter.sh/experiments/chromium-command-line-switches/
    // if (this.debug) {
    //   this.args.push('--full-memory-crash-report')
    // }
    // this.args.push('--ignore-certificate-errors')
    // this.args.push('--force-gpu-mem-available-mb=4096')
    // this.args.push('--disable-gpu')
  }

  /**
   * Get browser.
   * @return {Promise<Browser>}
   */
  async getBrowser (proxy) {
    if (typeof proxy != 'undefined') {
      this.anonymizedProxy = await proxyChain.anonymizeProxy(proxy);
      this.args.push(`--proxy-server=${this.anonymizedProxy}`);
    }

    return puppeteer.launch({
      args: this.args,
      defaultViewport: { width: 800, height: 600},
      executablePath: this.localExecutivePath,
      headless: 'shell',
      dumpio: this.debug,
      ignoreHTTPSErrors: true,
    })
  }

  async closeProxy () {
    if (this.anonymizedProxy) {
      await proxyChain.closeAnonymizedProxy(this.anonymizedProxy, true);
      this.anonymizedProxy = null;
    }
  }
}

module.exports = { ChromiumBrowser }
