const proxyChain = require('proxy-chain');
const { chromium } = require('playwright');
const logger = require('./logger');

const BASE_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-font-subpixel-positioning',
];

// Projects whose server breaks Chromium's HTTP/2 stack and fails with ERR_HTTP2_PROTOCOL_ERROR.
// HTTP/1.1 loses multiplexing and connection reuse, so we opt in per project, not for everyone.
const HTTP2_DISABLED_PROJECTS = [26143];

class ChromiumBrowser {
  constructor(debug = false, local = false) {
    this.debug = debug;
    this.local = local;
    this.browser = null;
    this.anonymizedProxy = null;
    this.staticArgs = BASE_ARGS;
    this.localExecutivePath = '/usr/bin/chromium-browser';
  }

  async getBrowser(proxy, params = {}) {
    const launchArgs = [...this.staticArgs];

    if (HTTP2_DISABLED_PROJECTS.includes(Number(params?.project_id))) {
      launchArgs.push('--disable-http2');
    }

    const launchOptions = {
      args: launchArgs,
      headless: true,
      chromiumSandbox: this.local,
      timeout: 120000,
    };

    if (proxy) {
      this.anonymizedProxy = await proxyChain.anonymizeProxy(proxy);
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
      await proxyChain.closeAnonymizedProxy(this.anonymizedProxy, true);
      this.anonymizedProxy = null;
    }
  }
}

module.exports = { ChromiumBrowser }
