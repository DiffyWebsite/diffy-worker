# Makefile for a standard repo with associated image
# Follow instructions https://ddev.readthedocs.io/en/stable/developers/release-management/#pushing-docker-images-manually

##### These variables need to be adjusted in most repositories #####

# Base docker org for tag and push
DOCKER_ORG ?= diffywebsite2
SHELL=/bin/bash

DEFAULT_IMAGES = screenshot-worker
BUILD_ARCHS=linux/amd64,linux/arm64

.PHONY: images

# VERSION can be set by
  # Default: git tag
  # make command line: make VERSION=0.9.0
# It can also be explicitly set in the Makefile as commented out below.

# This version-strategy uses git tags to set the version string
# VERSION can be overridden on make commandline: make VERSION=0.9.1 push
VERSION := $(shell git describe --tags --always --dirty)
BUILDINFO = $(shell echo hash=$$(git rev-parse --short HEAD) Built $$(date) by $${USER} on $$(hostname) $(BUILD_IMAGE) )

# In CI environments, use the plain Docker build progress to not overload the CI logs
PROGRESS := $(if $(CI),plain,auto)

#
# This version-strategy uses a manual value to set the version string
#VERSION := 1.2.3

build: images

images: $(DEFAULT_IMAGES)

$(DEFAULT_IMAGES):
	set -eu -o pipefail; \
	 DOCKER_BUILDKIT=1 docker buildx build -o type=docker --label com.diffywebsite2.buildhost=${shell hostname} --target=$@  -t $(DOCKER_ORG)/$@:$(VERSION) $(DOCKER_ARGS) .


push:
	set -eu -o pipefail; \
	for item in $(DEFAULT_IMAGES); do \
		docker buildx build --push --platform $(BUILD_ARCHS) --label com.diffywebsite2.buildhost=${shell hostname} --target=$$item  -t $(DOCKER_ORG)/$$item:$(VERSION) $(DOCKER_ARGS) .; \
		echo "pushed $(DOCKER_ORG)/$$item:$(VERSION)"; \
	done

test: $(DEFAULT_IMAGES)
	DOCKER_BUILDKIT=1 docker buildx build --load --platform="linux/$$(./get_arch.sh)" --label com.diffywebsite2.buildhost=${shell hostname} --label com.diffywebsite2.buildinfo="$(BUILDINFO)" -t $(DOCKER_ORG)/$<:$(VERSION) $(DOCKER_ARGS) .
	for item in $(DEFAULT_IMAGES); do \
		if [ -x tests/$$item/test.sh ]; then tests/$$item/test.sh $(DOCKER_ORG)/$$item:$(VERSION); fi; \
	done

version:
	@echo VERSION:$(VERSION)