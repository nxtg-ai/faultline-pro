PKG = github.com/nxtg-ai/terraform-provider-faultline

# Default OS/arch for local install. Override with GOOS= GOARCH=.
GOOS   ?= linux
GOARCH ?= amd64

PLUGIN_DIR = ~/.terraform.d/plugins/registry.terraform.io/nxtg-ai/faultline/0.1.0/$(GOOS)_$(GOARCH)

.PHONY: build install test fmt lint

build:
	go build -o terraform-provider-faultline .

install: build
	mkdir -p $(PLUGIN_DIR)
	cp terraform-provider-faultline $(PLUGIN_DIR)/

test:
	go test ./...

fmt:
	go fmt ./...

lint:
	golangci-lint run ./...
