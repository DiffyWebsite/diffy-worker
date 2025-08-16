const proxyChain = require('proxy-chain')
const puppeteer = require('puppeteer-core')

class ChromiumBrowser {
  args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-features=TranslateUI',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-dev-shm-usage',
    '--disable-client-side-phishing-detection',
    '--ignore-certificate-errors',
    '--js-flags=--max-old-space-size=2048',
    '--autoplay-policy=user-gesture-required'
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
  async getBrowser (proxy) {
    const launchArgs = [...this.args];

    if (proxy) {
      this.anonymizedProxy = await proxyChain.anonymizeProxy(proxy);
      launchArgs.push(`--proxy-server=${this.anonymizedProxy}`);
    }

    try {
      return puppeteer.launch({
        args: launchArgs,
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