const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

class ChromiumBrowser {
  args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--disable-client-side-phishing-detection',
    '--ignore-certificate-errors',
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
      this.args.push(`--proxy-server=138.201.56.149:3128`);
      console.log(`Using Proxy: ${proxy}`);
    }

    try {
      return puppeteer.launch({
        args: this.args,
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
    if (this.args.includes('--proxy-server')) {
      this.args = this.args.filter(arg => !arg.startsWith('--proxy-server'));
    }
  }

  /**
   * Open new page and authenticate proxy (if required).
   * @return {Promise<Page>}
   */
  async newPage(browser, proxy) {
    const page = await browser.newPage();

    if (proxy.includes('@')) {
      const match = proxy.match(/\/\/(.*):(.*)@(.*)/);
      if (match) {
        const [_, username, password] = match;
        await page.authenticate({ username, password });
      }
    }

    return page;
  }
}

module.exports = { ChromiumBrowser }