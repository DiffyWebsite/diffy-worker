FROM ubuntu:22.04
SHELL ["/bin/bash", "--login", "-c"]
RUN rm /bin/sh && ln -s /bin/bash /bin/sh
RUN rm /bin/dash && ln -s /bin/bash /bin/dash
WORKDIR /diffy-worker
VOLUME /diffy-worker

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_NO_WARNINGS=1
RUN apt-get update
RUN apt-get install -y gconf-service apt-transport-https ca-certificates libssl-dev wget libasound2 libatk1.0-0 libcairo2 libcups2 libfontconfig1 libgdk-pixbuf2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libxss1 fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils curl build-essential tar gzip findutils net-tools dnsutils
RUN apt-get install -y software-properties-common unzip

# Install Chromium from ppa:xtradeb/apps
RUN add-apt-repository ppa:xtradeb/apps -y
RUN apt update
RUN apt-get install -y chromium

RUN set -euxo pipefail; \
  if [ -x /usr/bin/chromium-browser ]; then \
    exit 0; \
  elif [ -x /usr/bin/chromium ]; then \
    ln -sf /usr/bin/chromium /usr/bin/chromium-browser; \
  elif [ -x /usr/lib/chromium-browser/chromium-browser ]; then \
    ln -sf /usr/lib/chromium-browser/chromium-browser /usr/bin/chromium-browser; \
  else \
    echo "Chromium binary not found after installation" >&2; \
    exit 1; \
  fi

# Install Node.js 22.5.1 from official distribution with checksum verification
ARG TARGETARCH
RUN set -euxo pipefail; \
    case "${TARGETARCH}" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    NODE_TARBALL="node-v22.5.1-linux-${NODE_ARCH}.tar.gz"; \
    cd /tmp && \
    curl -fsSLO "https://nodejs.org/dist/v22.5.1/${NODE_TARBALL}" && \
    curl -fsSLO "https://nodejs.org/dist/v22.5.1/SHASUMS256.txt" && \
    grep " ${NODE_TARBALL}$" SHASUMS256.txt | sha256sum -c - && \
    tar -xzf "${NODE_TARBALL}" -C /usr/local --strip-components=1 && \
    rm "${NODE_TARBALL}" SHASUMS256.txt

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN set -euxo pipefail; \
  mkdir -p "${PLAYWRIGHT_BROWSERS_PATH}"; \
  npx --yes playwright@1.56.0 install chromium; \
  CHROME_DIR="$(find "${PLAYWRIGHT_BROWSERS_PATH}" -maxdepth 1 -type d -name 'chromium-*' -print -quit)"; \
  ln -sf "${CHROME_DIR}/chrome-linux/chrome" /usr/bin/playwright-chromium

RUN npx --yes playwright@1.56.0 install-deps webkit && \
    npx --yes playwright@1.56.0 install webkit

# In case non-root user runs "npm install" we need to make sure /.cache directory exists and writable.
RUN mkdir /.cache && chmod ugo+w /.cache

# Install all the fonts.
RUN apt-get install -y --no-install-recommends fontconfig fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst ttf-mscorefonts-installer fonts-ubuntu fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf fonts-liberation fonts-thai-tlwg fonts-indic fonts-lato fonts-open-sans fonts-roboto fonts-dejavu-core
RUN fc-cache -f -v

# Set environment variables
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV CHROME_BIN=${CHROMIUM_EXECUTABLE_PATH}
ENV BROWSER_ENGINE=chromium

RUN useradd -m -u 1001 -s /bin/bash diffy && \
    chown -R diffy:diffy /ms-playwright

USER diffy
CMD ["tail", "-f", "/dev/null"]
