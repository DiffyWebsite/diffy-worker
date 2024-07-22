const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: {width: 800, height: 600},
      // executablePath: '/app/chromium/linux-1083080/chrome-linux/chrome',
      headless: 'shell',
      dumpio: false,
      ignoreHTTPSErrors: true
    }
  );
  const page = await browser.newPage();
  await page.goto('https://www.freecodecamp.org/');
  await page.screenshot({path: 'freecodecamp.png'});

  await browser.close();
})();
