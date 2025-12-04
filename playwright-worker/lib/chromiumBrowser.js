const { anonymizeProxy, closeAnonymizedProxy } = require('proxy-chain');
const { chromium } = require('playwright');
const logger = require('./logger');

const BASE_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-font-subpixel-positioning',
];

class ChromiumBrowser {
  constructor(debug = false, local = false) {
    this.debug = debug;
    this.local = local;
    this.browser = null;
    this.anonymizedProxy = null;
    this.staticArgs = BASE_ARGS;
    this.localExecutivePath = '/usr/bin/chromium-browser';
  }

  async getBrowser(proxy) {
    const launchArgs = [...this.staticArgs];

    const launchOptions = {
      args: launchArgs,
      headless: true,
      chromiumSandbox: this.local,
      timeout: 120000,
    };

    if (proxy) {
      this.anonymizedProxy = await anonymizeProxy(proxy);
      launchArgs.push(`--proxy-server=${this.anonymizedProxy}`);
    }

    let executablePath = this.localExecutivePath;

    if (executablePath) {
      launchOptions.executablePath = executablePath;
    }

    if (this.debug) logger.debug('Launching Chromium with options', { launchOptions });

    this.browser = await chromium.launch(launchOptions);
    return this.browser;
  }

  async closeProxy() {
    if (this.anonymizedProxy) {
      try {
        await closeAnonymizedProxy(this.anonymizedProxy, true);
      } catch (e) {
        logger.warn('Failed to close anonymized proxy', { error: e });
      } finally {
        this.anonymizedProxy = null;
      }
    }
  }
}

module.exports = { ChromiumBrowser }
