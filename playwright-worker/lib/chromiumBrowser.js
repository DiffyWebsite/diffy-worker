const fs = require('fs');
const crypto = require('crypto');
const { anonymizeProxy, closeAnonymizedProxy } = require('proxy-chain');
const { chromium } = require('playwright');
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
  const args = [`--window-size=${viewport.width},${viewport.height}`];
  return { viewport, args };
};

class ChromiumBrowser {
  constructor(debug = false, local = false) {
    this.debug = debug;
    this.local = local;
    this.browser = null;
    this.anonymizedProxy = null;
    this.staticArgs = [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-lcd-text',
      '--disable-font-subpixel-positioning',
      '--disable-oop-rasterization',
      '--disable-partial-raster',
      '--disable-threaded-compositing',
      '--disable-skia-runtime-opts',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ];
    this.launchProfile = createLaunchProfile();
    this.localExecutivePath = '/usr/bin/chromium-browser';
  }

  async getBrowser(proxy) {
    this.launchProfile = createLaunchProfile();

    const launchArgs = Array.from(new Set([...this.staticArgs, ...this.launchProfile.args]));

    const launchOptions = {
      args: launchArgs,
      headless: true,
      ignoreDefaultArgs: ['--hide-scrollbars'],
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

  /**
   * Create a fresh context with the chosen viewport and sensible defaults.
   */
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
    // Apply sane default timeouts so actions and navigations are bounded.
    // Keep these internal (no exposure via job args as requested).
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

module.exports = { ChromiumBrowser }
