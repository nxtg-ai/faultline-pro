// data_source_scan.go implements the faultline_scan data source.
//
// This data source runs a Faultline claim verification scan during
// `terraform plan` or `terraform apply`. The primary use case is
// scan-gated deployments: if content risk exceeds an acceptable threshold,
// the Terraform check block will fail, halting the deployment.
package provider

import (
	"context"
	"crypto/sha256"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// Ensure ScanDataSource satisfies the datasource.DataSource interface.
var _ datasource.DataSource = &ScanDataSource{}

// NewScanDataSource is the factory function registered with the provider.
func NewScanDataSource() datasource.DataSource {
	return &ScanDataSource{}
}

// ScanDataSource executes a Faultline scan and exposes the result for use
// in Terraform expressions and check blocks.
type ScanDataSource struct {
	client *FaultlineClient
}

// ScanDataSourceModel maps the Terraform schema to Go values.
type ScanDataSourceModel struct {
	// Inputs
	Text     types.String `tfsdk:"text"`
	Provider types.String `tfsdk:"provider"`

	// Computed outputs
	ID          types.String `tfsdk:"id"`
	OverallRisk types.String `tfsdk:"overall_risk"`
	ClaimsCount types.Int64  `tfsdk:"claims_count"`
}

// Metadata returns the data source type name as used in Terraform configuration.
func (d *ScanDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_scan"
}

// Schema defines the attributes of the faultline_scan data source.
func (d *ScanDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Runs a Faultline claim verification scan against arbitrary text. " +
			"The computed overall_risk can be used in Terraform check blocks to " +
			"gate deployments on content safety. " +
			"Note: this data source makes a live API call on every plan/apply.",
		Attributes: map[string]schema.Attribute{
			"text": schema.StringAttribute{
				Description: "The text to scan for AI-generated claims. " +
					"Use file() to scan release notes, changelogs, or any document.",
				Required: true,
			},
			"provider": schema.StringAttribute{
				Description: "AI provider to use for claim extraction and verification. " +
					"Valid values: \"gemini\", \"openai\", \"claude\", \"perplexity\", \"mock\". " +
					"Defaults to \"mock\" for safe use in CI without live API keys.",
				Optional: true,
				Computed: true,
			},
			"id": schema.StringAttribute{
				Description: "SHA-256 hash of the scanned text, used as a stable identifier.",
				Computed:    true,
			},
			"overall_risk": schema.StringAttribute{
				Description: "Risk classification of the scanned content. " +
					"One of: \"low\", \"medium\", \"high\", \"critical\".",
				Computed: true,
			},
			"claims_count": schema.Int64Attribute{
				Description: "Number of distinct claims extracted from the text.",
				Computed:    true,
			},
		},
	}
}

// Configure extracts the FaultlineClient injected by the provider.
func (d *ScanDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}

	client, ok := req.ProviderData.(*FaultlineClient)
	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected Data Source Configure Type",
			fmt.Sprintf("Expected *FaultlineClient, got: %T. Please report this issue.", req.ProviderData),
		)
		return
	}

	d.client = client
}

// Read calls POST /scan and populates all computed attributes.
func (d *ScanDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var config ScanDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Default provider to "mock" so the data source is safe in local plans
	// where no live AI provider key is configured.
	aiProvider := "mock"
	if !config.Provider.IsNull() && !config.Provider.IsUnknown() && config.Provider.ValueString() != "" {
		aiProvider = config.Provider.ValueString()
	}

	scanReq := ScanRequest{
		Text:     config.Text.ValueString(),
		Provider: aiProvider,
	}

	result, err := d.client.Scan(ctx, scanReq)
	if err != nil {
		resp.Diagnostics.AddError("Error Running Faultline Scan", err.Error())
		return
	}

	// Derive a stable ID from the input text so Terraform can track changes.
	hash := sha256.Sum256([]byte(config.Text.ValueString()))
	config.ID = types.StringValue(fmt.Sprintf("%x", hash))

	config.Provider = types.StringValue(aiProvider)
	config.OverallRisk = types.StringValue(result.OverallRisk)
	config.ClaimsCount = types.Int64Value(result.ClaimsCount)

	resp.Diagnostics.Append(resp.State.Set(ctx, config)...)
}
