const proxyChain = require('proxy-chain')
const puppeteer = require('puppeteer-core')
const fs = require('fs');

class ChromiumBrowser {
  args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  browser = null
  debug = false
  local = false

  localExecutivePath = '/usr/bin/chromium-browser'
  anonymizedProxy = null

  userDataDir = '/root/puppeteer_cache';

  constructor (debug = false, local = false) {
    this.debug = debug
    this.local = local

    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }
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
      userDataDir: this.userDataDir, // Use this directory for local browser caching
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
