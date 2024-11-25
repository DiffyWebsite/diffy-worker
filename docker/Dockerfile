FROM --platform=linux/amd64 ubuntu:22.04

SHELL ["/bin/bash", "--login", "-i", "-c"]
RUN rm /bin/sh && ln -s /bin/bash /bin/sh
RUN rm /bin/dash && ln -s /bin/bash /bin/dash

WORKDIR /diffy-worker
VOLUME /diffy-worker

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_NO_WARNINGS=1

# Install dependencies
RUN apt-get update && apt-get install -y \
    gconf-service apt-transport-https ca-certificates libssl-dev wget libasound2 libatk1.0-0 libcairo2 \
    libcups2 libfontconfig1 libgdk-pixbuf2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libxss1 fonts-liberation \
    libappindicator1 libnss3 lsb-release xdg-utils curl build-essential tar gzip findutils net-tools dnsutils \
    telnet ngrep tcpdump software-properties-common unzip libgbm-dev fontconfig fonts-ipafont-gothic \
    fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst ttf-mscorefonts-installer fonts-ubuntu fonts-noto-color-emoji \
    fonts-noto-cjk fonts-freefont-ttf fonts-liberation fonts-thai-tlwg fonts-indic fonts-lato fonts-open-sans \
    fonts-roboto fonts-dejavu-core && \
    fc-cache -f -v && \
    apt-get clean

# Install Node.js using n
RUN curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s lts
RUN npm install -g n
RUN n 22.5.1
RUN n rm 20

# Install Chromium using Puppeteer and move it to /usr/bin
RUN npx @puppeteer/browsers install chrome@131.0.6778.85 --base-url=https://storage.googleapis.com/chrome-for-testing-public && \
    mv /diffy-worker/chrome/linux-131.0.6778.85/chrome-linux64/chrome /usr/bin/chromium-browser && \
    chmod +x /usr/bin/chromium-browser && \
    rm -rf /diffy-worker/chrome

# Verify Chromium installation
RUN /usr/bin/chromium-browser --version

# Create writable /.cache directory
RUN mkdir /.cache && chmod ugo+w /.cache

# Set environment variables
ENV CHROME_BIN=/usr/bin/chromium-browser

CMD ["tail", "-f", "/dev/null"]
