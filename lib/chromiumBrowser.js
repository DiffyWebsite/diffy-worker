const proxyChain = require('proxy-chain')
const puppeteer = require('puppeteer-core')

class ChromiumBrowser {
  args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--disable-client-side-phishing-detection',
    '--ignore-certificate-errors',
    '--js-flags=--max-old-space-size=2048',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding'
  ];

  browser = null
  debug = false
  local = false

  localExecutivePath = '/usr/bin/chromium-browser';

  constructor(debug = false, local = false) {
    this.debug = debug;
    this.local = local;
  }

  /**
   * Get browser instance.
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
        protocolTimeout: 120000,
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