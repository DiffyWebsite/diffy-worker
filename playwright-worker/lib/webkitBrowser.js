const crypto = require('crypto');
const { anonymizeProxy, closeAnonymizedProxy } = require('proxy-chain');
const { webkit } = require('playwright');
const logger = require('./logger');

const randomBetween = (min, max) => crypto.randomInt(min, max + 1);

const realisticViewports = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

const createLaunchProfile = () => {
  const viewport = realisticViewports[randomBetween(0, realisticViewports.length - 1)];
  return { viewport };
};

class WebkitBrowser {
  constructor(debug = false, local = false) {
    this.debug = debug;
    this.local = local;
    this.browser = null;
    this.anonymizedProxy = null;
    this.launchProfile = createLaunchProfile();
  }

  async getBrowser(proxy) {
    this.launchProfile = createLaunchProfile();

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

  async newContext(options = {}) {
    if (!this.browser) throw new Error('Browser not launched. Call getBrowser() first.');
    const ctx = await this.browser.newContext({
      viewport: this.launchProfile.viewport,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      timezoneId: 'Europe/Chisinau',
      locale: 'en-US',
      ...options,
    });
    ctx.setDefaultTimeout(30000);
    ctx.setDefaultNavigationTimeout(45000);
    return ctx;
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

module.exports = { WebkitBrowser }

