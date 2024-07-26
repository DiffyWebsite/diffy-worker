# Makefile for a standard repo with associated image
# Follow instructions https://ddev.readthedocs.io/en/stable/developers/release-management/#pushing-docker-images-manually

##### These variables need to be adjusted in most repositories #####

# Base docker org for tag and push
DOCKER_REPO ?= diffywebsite2/screenshot-worker
SHELL=/bin/bash
DOCKER_ARGS=--no-cache

BUILD_ARCHS=linux/amd64,linux/arm64

push:
	set -eu -o pipefail; \
	docker buildx build --push --platform $(BUILD_ARCHS) -t $(DOCKER_REPO):$(VERSION) --label "build-info=$(DOCKER_REPO):$(VERSION) commit=$(shell git describe --tags --always) built $$(date) by $$(id -un) on $$(hostname)" --label "maintainer=Diffy <info@diffy.website>" $(DOCKER_ARGS) .

version:
	@echo VERSION:$(VERSION)