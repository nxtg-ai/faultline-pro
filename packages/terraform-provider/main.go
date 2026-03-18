// Package main is the entry point for the Faultline Terraform provider.
//
// The provider is served using the Terraform Plugin Framework's plugin.Serve,
// which handles all protocol negotiation with Terraform core.
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/nxtg-ai/terraform-provider-faultline/internal/provider"
)

// version is set at build time via -ldflags.
var version string = "dev"

func main() {
	var debug bool

	flag.BoolVar(&debug, "debug", false, "set to true to run the provider with support for debuggers like delve")
	flag.Parse()

	opts := providerserver.ServeOpts{
		Address: "registry.terraform.io/nxtg-ai/faultline",
		Debug:   debug,
	}

	err := providerserver.Serve(context.Background(), provider.New(version), opts)
	if err != nil {
		log.Fatal(err)
	}
}
