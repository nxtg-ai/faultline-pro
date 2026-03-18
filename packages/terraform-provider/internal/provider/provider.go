// Package provider implements the Faultline Terraform provider using the
// Terraform Plugin Framework. It exposes API key lifecycle management and
// scan-gated deployment capabilities as first-class Terraform constructs.
package provider

import (
	"context"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// Ensure FaultlineProvider satisfies the provider.Provider interface.
var _ provider.Provider = &FaultlineProvider{}

// FaultlineProvider is the root provider struct.
type FaultlineProvider struct {
	// version is set by the binary build; used in user-agent headers.
	version string
}

// FaultlineProviderModel holds the provider-level configuration decoded from
// the Terraform configuration block.
type FaultlineProviderModel struct {
	ApiKey  types.String `tfsdk:"api_key"`
	BaseUrl types.String `tfsdk:"base_url"`
}

// New returns a factory function that creates a new FaultlineProvider instance.
// version is injected at build time via main.go.
func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &FaultlineProvider{
			version: version,
		}
	}
}

// Metadata returns the provider type name and version.
func (p *FaultlineProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "faultline"
	resp.Version = p.version
}

// Schema defines the provider-level configuration schema.
//
// Both attributes can be sourced from environment variables:
//   - api_key  → FAULTLINE_API_KEY
//   - base_url → FAULTLINE_BASE_URL
func (p *FaultlineProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "The Faultline provider manages API keys and exposes scan-gated " +
			"deployment checks for the Faultline AI claim verification platform.",
		Attributes: map[string]schema.Attribute{
			"api_key": schema.StringAttribute{
				Description: "Faultline API key. May also be set via the FAULTLINE_API_KEY " +
					"environment variable.",
				Required:  true,
				Sensitive: true,
			},
			"base_url": schema.StringAttribute{
				Description: "Base URL of the Faultline API. Defaults to " +
					"http://localhost:3000. Override for production: " +
					"https://api.faultline.nxtg.ai. May also be set via FAULTLINE_BASE_URL.",
				Optional: true,
			},
		},
	}
}

// Configure reads provider configuration and stores a shared client in the
// provider data passed to resources and data sources.
func (p *FaultlineProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var config FaultlineProviderModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Resolve api_key — prefer explicit config, fall back to env var.
	apiKey := os.Getenv("FAULTLINE_API_KEY")
	if !config.ApiKey.IsNull() && !config.ApiKey.IsUnknown() {
		apiKey = config.ApiKey.ValueString()
	}
	if apiKey == "" {
		resp.Diagnostics.AddError(
			"Missing API Key",
			"The Faultline provider requires an api_key. Set it in the provider block "+
				"or via the FAULTLINE_API_KEY environment variable.",
		)
		return
	}

	// Resolve base_url — prefer explicit config, then env var, then default.
	baseURL := os.Getenv("FAULTLINE_BASE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:3000"
	}
	if !config.BaseUrl.IsNull() && !config.BaseUrl.IsUnknown() {
		baseURL = config.BaseUrl.ValueString()
	}

	client := NewFaultlineClient(apiKey, baseURL)

	// Expose the client to resources and data sources via provider data.
	resp.DataSourceData = client
	resp.ResourceData = client
}

// Resources returns the set of resources implemented by this provider.
func (p *FaultlineProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewApiKeyResource,
	}
}

// DataSources returns the set of data sources implemented by this provider.
func (p *FaultlineProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		NewScanDataSource,
	}
}
