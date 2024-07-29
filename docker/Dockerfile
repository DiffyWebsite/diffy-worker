FROM ubuntu:22.04

SHELL ["/bin/bash", "--login", "-i", "-c"]
RUN rm /bin/sh && ln -s /bin/bash /bin/sh
RUN rm /bin/dash && ln -s /bin/bash /bin/dash

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update
RUN apt-get install -y gconf-service apt-transport-https ca-certificates libssl-dev wget libasound2 libatk1.0-0 libcairo2 libcups2 libfontconfig1 libgdk-pixbuf2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libxss1 fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils curl build-essential tar gzip findutils net-tools dnsutils telnet ngrep tcpdump
RUN apt-get install -y software-properties-common unzip
RUN add-apt-repository ppa:saiarcot895/chromium-dev

RUN apt update
RUN apt-get install -y chromium-browser

# Install node with nvm
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
RUN source /root/.bashrc && nvm install 22.5.1

RUN ln -s /root/.nvm/versions/node/v22.5.1/bin/node /usr/bin/node
RUN ln -s /root/.nvm/versions/node/v22.5.1/bin/npm /usr/bin/npm

RUN apt install -y imagemagick

# Install all the fonts.
RUN apt-get install -y --no-install-recommends fontconfig fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst ttf-mscorefonts-installer fonts-ubuntu  fonts-noto-color-emoji  fonts-noto-cjk fonts-ipafont-gothic fonts-wqy-zenhei fonts-kacst fonts-freefont-ttf fonts-liberation fonts-thai-tlwg fonts-indic fonts-lato fonts-open-sans fonts-roboto fonts-dejavu-core
RUN fc-cache -f -v

#ENTRYPOINT ["/bin/sh", "-c", "bash"]
