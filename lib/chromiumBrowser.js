const proxyChain = require('proxy-chain')
const puppeteer = require('puppeteer-core')

class ChromiumBrowser {
  args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--disable-dev-shm-usage',
    '--ignore-certificate-errors',
    '--disable-features=IsolateOrigins,site-per-process',
    '--force-color-profile=srgb',
  ];

  browser = null
  debug = false
  local = false

  localExecutivePath = '/usr/bin/chromium-browser'
  anonymizedProxy = null

  constructor (debug = false, local = false) {
    this.debug = debug
    this.local = local
  }

  /**
   * Get browser.
   * @return {Promise<Browser>}
   */
  async getBrowser (proxy) {
    if (proxy) {
      this.anonymizedProxy = await proxyChain.anonymizeProxy(proxy);
      this.args.push(`--proxy-server=${this.anonymizedProxy}`);
    }

    try {
      return puppeteer.launch({
        args: this.args,
        defaultViewport: { width: 800, height: 600},
        executablePath: this.localExecutivePath,
        headless: 'new',
        dumpio: false,
        ignoreHTTPSErrors: true,
      })
    } catch (e) {
      console.log('Error launching browser:', e);
    }
  }

  async closeProxy () {
    if (this.anonymizedProxy) {
      await proxyChain.closeAnonymizedProxy(this.anonymizedProxy, true);
      this.anonymizedProxy = null;
    }
  }
}

module.exports = { ChromiumBrowser }