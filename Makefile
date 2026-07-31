SHELL := /bin/bash
GO ?= go

VERSION := $(shell cat VERSION)
MODULE := github.com/AosakiReiya/evejs-living-universe
LDFLAGS := -X $(MODULE)/internal/buildinfo.Version=$(VERSION)
BIN := dist/xeve-patch

GOOS := $(shell $(GO) env GOOS)
GOARCH := $(shell $(GO) env GOARCH)

PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

.PHONY: help build build-all test vet fmt lint manifest modules validate check audit release clean version

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

version: ## Print the current version
	@echo $(VERSION)

build: ## Build for the host platform
	$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN) ./cmd/xeve-patch

build-all: ## Cross-compile for all release platforms into dist/
	@set -e; for target in $(PLATFORMS); do \
		os=$${target%/*}; arch=$${target#*/}; \
		out=dist/xeve-patch-$${os}-$${arch}; \
		[ "$$os" = windows ] && out=$$out.exe; \
		echo ">> building $$target -> $$out"; \
		GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $$out ./cmd/xeve-patch; \
	done
	@echo "All platforms built under dist/"

test: ## Run the Go test suite
	$(GO) test ./...

vet: ## Run go vet
	$(GO) vet ./...

fmt: ## Format all Go sources
	$(GO) fmt ./...

lint: vet test ## Vet and test

manifest: modules ## Regenerate patches/manifest.json (v3) from overlay + baseline
	$(GO) run ./cmd/xeve-patch manifest generate --baseline tmp/EveJS-v0.12.3.1

modules: ## Regenerate patches/modules.json (module index) from the manifest
	$(GO) run ./cmd/xeve-patch modules generate

validate: build ## Validate the release package (manifest + overlay integrity)
	./$(BIN) audit

fmt-check:
	@out="$$($(GO) fmt ./...)"; if [ -n "$$out" ]; then echo "Unformatted files:"; echo "$$out"; exit 1; fi

check: fmt-check vet test audit ## Full CI-style validation

audit: build ## Audit the release package and data root
	./$(BIN) audit

release: build-all ## Build all platforms and package release zips (requires zip(1))
	@set -euo pipefail; \
	rm -rf dist/package; \
	for target in $(PLATFORMS); do \
		os=$${target%/*}; arch=$${target#*/}; \
		suffix=$${os}-$${arch}; \
		pkg=dist/X-Eve-Living-Universe-$(VERSION)-$${suffix}; \
		mkdir -p "$$pkg"; \
		cp -r patches "$$pkg/patches"; \
		cp README.md LICENSE CHANGELOG.md "$$pkg/"; \
		bin=xeve-patch; [ "$$os" = windows ] && bin=xeve-patch.exe; \
		cp "dist/xeve-patch-$${suffix}$$([ "$$os" = windows ] && echo .exe)" "$$pkg/$$bin"; \
		( cd dist && zip -qr "$$(basename "$$pkg").zip" "$$(basename "$$pkg")" ); \
		echo ">> packaged dist/$$(basename "$$pkg").zip"; \
	done

clean: ## Remove build output
	rm -rf dist
