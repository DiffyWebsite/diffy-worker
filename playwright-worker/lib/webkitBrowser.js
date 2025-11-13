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

  // Build a macOS Safari-like user agent.
  // PLAYWRIGHT_SAFARI_VERSION overrides version token if needed.
  // Note: This mimics Safari UA; it does not enable Safari-specific features.
  buildSafariUA () {
    const safariVersion = process.env.PLAYWRIGHT_SAFARI_VERSION || '18.0';
    // macOS Safari UA (Sonoma/Sequoia era)
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${safariVersion} Safari/605.1.15`;
  }

  async getBrowser(proxy) {
    this.launchProfile = createLaunchProfile();

    const launchOptions = {
      headless: true,
      timeout: 120000,
      // Keep launch args minimal and stable for deterministic rendering.
      // WebKit in headless mode uses software rendering; GPU flags are not exposed like Chromium.
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
    const defaultDpr = 2; // mimic Retina on macOS
    const ctx = await this.browser.newContext({
      viewport: this.launchProfile.viewport,
      deviceScaleFactor: options.deviceScaleFactor || defaultDpr,
      ignoreHTTPSErrors: true,
      timezoneId: options.timezoneId || 'Europe/Chisinau',
      locale: options.locale || 'en-US',
      userAgent: options.userAgent || this.buildSafariUA(),
      isMobile: options.isMobile ?? false,
      hasTouch: options.hasTouch ?? false,
      colorScheme: options.colorScheme || 'light',
      reducedMotion: options.reducedMotion || 'no-preference',
      ...options,
    });
    // No font injection to avoid altering site font choices.
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
