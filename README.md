This is the code of the screenshot worker that runs on production for Diffy (https://diffy.website).

By open sourcing it we allow local development integrations (i.e. DDEV, Lando).

To start container (default platform is needed if you are on M1 processor)

```shell
docker-compose -f docker-compose.yml up
```

Login to container

```shell
docker-compose -f docker-compose.yml exec node bash
cd /app
```

To start an app with a test job
```shell
node index.js --file=test_jobs/screenshot1.json
```

List of compatible versions of puppeteer and Chrome
https://pptr.dev/supported-browsers

To install specific version of Chromium
https://www.chromium.org/getting-involved/download-chromium/

Chromium 111 was installed from specific source
```shell
add-apt-repository ppa:saiarcot895/chromium-dev
apt update
apt-get install chromium-browser
chromium-browser --version
```

Create a job in SQS. Once created edit it and clear "Access policy" section. 

Additionally installed fonts on production workers:
```shell
apt-get update && apt-get install -y fontconfig fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst      --no-install-recommends
apt-get install ttf-mscorefonts-installer
apt-get install fonts-ubuntu  fonts-noto-color-emoji  fonts-noto-cjk fonts-ipafont-gothic  fonts-wqy-zenhei fonts-kacst fonts-freefont-ttf fonts-liberation fonts-thai-tlwg fonts-indic
apt-get install fonts-lato fonts-open-sans fonts-roboto
apt install fonts-dejavu-core

fc-cache -f -v
```

To check fonts
fc-match system-ui

### Chrome version validation

To validate Chrome run screenshot on https://vrt-test.diffy.website

Project's settings:
```YAML
basic:
    name: 'Chrome validation 1'
    environments:
        production: 'https://vrt-test.diffy.website'
        staging: ''
        development: ''
    breakpoints:
        - 1200
    pages:
        - /
    monitoring:
        days: {  }
        type: ''
        schedule_time: '12:30 AM'
        schedule_time_zone: Europe/London
        compare_with: last
advanced:
    mask: ''
    remove: '#mask'
    isolate: '#remove'
    delay: 10
    scroll: true
    headers:
        - { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.11; rv:46.0) Gecko/20100101 Firefox/46.0', header: User-Agent }
    cookies: CUSTOM=cookie;
    custom_js: "var div = document.getElementById('custom-javascript');\ndiv.innerHTML += ' Extra content added!';"
    custom_css: "#custom-css {\n  background-color: red;\n}"
    mock_content:
        - { type: title, selector: '#timestamp' }
    login:
        type: ''
        click_element: false
        click_element_selector: ''
        login_url: ''
        username: ''
        password: ''
        username_selector: ''
        password_selector: ''
        submit_selector: ''
        after_login_selector: ''
    performance:
        workers_production: 30
        workers_nonproduction: 10
        workers_production_delay: 0
        workers_nonproduction_delay: 0
    stabilize: true
</code>
```

