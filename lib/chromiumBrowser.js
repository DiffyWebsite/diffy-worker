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
  ];

  browser = null
  debug = false
  local = false

  // This is where Chromium got installed in the docker box.
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

    return puppeteer.launch({
      args: this.args,
      defaultViewport: { width: 800, height: 600 },
      executablePath: this.localExecutivePath,
      headless: 'shell',
      dumpio: false,
      ignoreHTTPSErrors: true,
    });
  }

  async closeProxy () {
    if (this.anonymizedProxy) {
      await proxyChain.closeAnonymizedProxy(this.anonymizedProxy, true);
      this.anonymizedProxy = null;
    }
  }
}

module.exports = { ChromiumBrowser }
