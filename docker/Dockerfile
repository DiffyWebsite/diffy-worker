FROM ubuntu:24.04

SHELL ["/bin/bash", "--login", "-i", "-c"]
RUN rm /bin/sh && ln -s /bin/bash /bin/sh
RUN rm /bin/dash && ln -s /bin/bash /bin/dash

WORKDIR /diffy-worker
VOLUME /diffy-worker

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_NO_WARNINGS=1
RUN apt-get update
RUN apt-get install -y apt-transport-https ca-certificates libssl-dev wget libasound2t64 libatk1.0-0 libcairo2 libcups2 libfontconfig1 libgdk-pixbuf2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libxss1 fonts-liberation libnss3 lsb-release xdg-utils curl build-essential tar gzip findutils net-tools dnsutils telnet ngrep tcpdump
RUN apt-get install -y software-properties-common unzip

# Install Chromium from ppa:xtradeb/apps
RUN add-apt-repository ppa:xtradeb/apps -y
RUN apt update
RUN apt-get install -y chromium

# Install node with n
RUN curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s lts
RUN npm install -g n
RUN n 22.5.1

RUN n rm 20

# In case non-root user runs "npm install" we need to make sure /.cache directory exists and writable.
RUN mkdir /.cache && chmod ugo+w /.cache

# Install all the fonts.
RUN apt-get install -y --no-install-recommends fontconfig fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst ttf-mscorefonts-installer fonts-ubuntu fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf fonts-liberation fonts-thai-tlwg fonts-indic fonts-lato fonts-open-sans fonts-roboto fonts-dejavu-core
RUN fc-cache -f -v

# Set environment variables
ENV CHROME_BIN=/usr/bin/chromium
CMD ["tail", "-f", "/dev/null"]
