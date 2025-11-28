const proxyChain = require('proxy-chain')
const puppeteer = require('puppeteer-core')
const { resolveTimeoutWithNeedIncrease } = require('./timeoutHelper')

class ChromiumBrowser {
  args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-webgl',
    '--disable-dev-shm-usage'
  ];

  browser = null
  debug = false
  local = false
  anonymizedProxy = null

  localExecutivePath = '/usr/bin/chromium-browser';

  constructor(debug = false, local = false) {
    this.debug = debug;
    this.local = local;
  }

  /**
   * Get browser instance.
   * @return {Promise<Browser>}
   */
  async getBrowser (proxy, options = {}) {
    const launchArgs = [...this.args];
    const needIncrease = options?.needIncrease;

    const protocolTimeout = resolveTimeoutWithNeedIncrease(needIncrease, 180000);

    if (proxy) {
      this.anonymizedProxy = await proxyChain.anonymizeProxy(proxy);
      launchArgs.push(`--proxy-server=${this.anonymizedProxy}`);
    }

    try {
      return puppeteer.launch({
        args: launchArgs,
        protocolTimeout,
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