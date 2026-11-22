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

# Chrome for Testing, pinned to the exact build production workers run
# (/usr/bin/chromium-browser on the servers). Bump this together with the playwright
# version in package.json, whose bundled Chromium has the same major version.
ARG CHROME_VERSION=158.0.8127.36
RUN set -euxo pipefail; \
    case "${TARGETARCH}" in \
      amd64) CFT_PLATFORM=linux64 ;; \
      arm64) CFT_PLATFORM=linux-arm64 ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    cd /tmp && \
    curl -fsSLo chrome.zip \
      "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${CFT_PLATFORM}/chrome-${CFT_PLATFORM}.zip" && \
    unzip -q chrome.zip -d /opt && \
    mv "/opt/chrome-${CFT_PLATFORM}" /opt/chrome-for-testing && \
    rm chrome.zip && \
    ln -sf /opt/chrome-for-testing/chrome /usr/bin/chromium-browser && \
    ln -sf /opt/chrome-for-testing/chrome /usr/bin/chromium

# Shared libraries Chromium needs; the browser itself is the Chrome for Testing build above.
RUN npx --yes playwright@1.65.0 install-deps chromium && \
    chromium-browser --version | grep -F "${CHROME_VERSION}"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p "${PLAYWRIGHT_BROWSERS_PATH}" && \
    npx --yes playwright@1.65.0 install-deps webkit && \
    npx --yes playwright@1.65.0 install webkit

# In case non-root user runs "npm install" we need to make sure /.cache directory exists and writable.
RUN mkdir /.cache && chmod ugo+w /.cache

# Install all the fonts.
RUN apt-get install -y --no-install-recommends fontconfig fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst ttf-mscorefonts-installer fonts-ubuntu fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf fonts-liberation fonts-thai-tlwg fonts-indic fonts-lato fonts-open-sans fonts-roboto fonts-dejavu-core
RUN fc-cache -f -v

# Set environment variables
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV CHROME_BIN=${CHROMIUM_EXECUTABLE_PATH}
ENV BROWSER_ENGINE=chrome158

RUN useradd -m -u 1001 -s /bin/bash diffy && \
    chown -R diffy:diffy /ms-playwright

USER diffy
CMD ["tail", "-f", "/dev/null"]
