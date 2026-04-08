const { anonymizeProxy, closeAnonymizedProxy } = require('proxy-chain');
const { webkit } = require('playwright');
const logger = require('./logger');

class WebkitBrowser {
  constructor(debug = false, local = false) {
    this.debug = debug;
    this.local = local;
    this.browser = null;
    this.anonymizedProxy = null;
  }

  async getBrowser(proxy) {
    const launchOptions = {
      headless: true,
      timeout: 120000,
    };

    if (proxy) {
      this.anonymizedProxy = await anonymizeProxy(proxy);
      launchOptions.proxy = { server: this.anonymizedProxy };
    }

    if (this.debug) logger.debug('Launching WebKit with options', { launchOptions });

    this.browser = await webkit.launch(launchOptions);
    return this.browser;
  }

  async closeProxy() {
    if (this.anonymizedProxy) {
      try {
        await closeAnonymizedProxy(this.anonymizedProxy, true);
      } catch (e) {
        logger.warn('Failed to close anonymized proxy', { error: e?.message || String(e) });
      } finally {
        this.anonymizedProxy = null;
      }
    }
  }
}

module.exports = { WebkitBrowser }
