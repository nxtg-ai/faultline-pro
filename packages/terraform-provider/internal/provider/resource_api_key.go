// resource_api_key.go implements the faultline_api_key managed resource.
//
// This resource allows Terraform to create and destroy Faultline API keys
// declaratively. Updates to name or permissions trigger a replace (ForceNew)
// because the Faultline API does not support key mutation; a destroy+create
// cycle is the safest approach.
package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// Ensure ApiKeyResource satisfies the resource.Resource interface.
var _ resource.Resource = &ApiKeyResource{}

// NewApiKeyResource is the factory function registered with the provider.
func NewApiKeyResource() resource.Resource {
	return &ApiKeyResource{}
}

// ApiKeyResource manages the lifecycle of a single Faultline API key.
type ApiKeyResource struct {
	client *FaultlineClient
}

// ApiKeyResourceModel maps the Terraform schema to Go values for this resource.
type ApiKeyResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Permissions types.List   `tfsdk:"permissions"`
	Key         types.String `tfsdk:"key"`
	CreatedAt   types.String `tfsdk:"created_at"`
}

// Metadata returns the resource type name as used in Terraform configuration.
func (r *ApiKeyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_api_key"
}

// Schema defines the attributes of the faultline_api_key resource.
func (r *ApiKeyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manages a Faultline API key. Use this resource to provision " +
			"per-environment or per-service keys as part of your IaC workflow.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Description: "UUID of the API key assigned by Faultline.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"name": schema.StringAttribute{
				Description: "Human-readable label for the key (e.g. \"CI Pipeline\").",
				Required:    true,
				PlanModifiers: []planmodifier.String{
					// Name changes require replacement because the API does not
					// support in-place updates.
					stringplanmodifier.RequiresReplace(),
				},
			},
			"permissions": schema.ListAttribute{
				Description: "List of permissions granted to this key. " +
					"Valid values: \"scan\", \"report\", \"admin\". " +
					"Defaults to [\"scan\"].",
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				PlanModifiers: []planmodifier.List{
					listplanmodifier.RequiresReplace(),
				},
			},
			"key": schema.StringAttribute{
				Description: "The raw API key value. Treat this as a secret — " +
					"Terraform state will contain the plaintext value.",
				Computed:  true,
				Sensitive: true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"created_at": schema.StringAttribute{
				Description: "ISO-8601 timestamp of when the key was created.",
				Computed:    true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
		},
	}
}

// Configure extracts the FaultlineClient injected by the provider.
func (r *ApiKeyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}

	client, ok := req.ProviderData.(*FaultlineClient)
	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected Resource Configure Type",
			fmt.Sprintf("Expected *FaultlineClient, got: %T. Please report this issue.", req.ProviderData),
		)
		return
	}

	r.client = client
}

// Create calls POST /keys and writes the result to Terraform state.
func (r *ApiKeyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan ApiKeyResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Resolve permissions: use plan value if set, otherwise default to ["scan"].
	permissions := []string{"scan"}
	if !plan.Permissions.IsNull() && !plan.Permissions.IsUnknown() {
		resp.Diagnostics.Append(plan.Permissions.ElementsAs(ctx, &permissions, false)...)
		if resp.Diagnostics.HasError() {
			return
		}
	}

	createReq := CreateKeyRequest{
		Name:        plan.Name.ValueString(),
		Permissions: permissions,
	}

	created, err := r.client.CreateKey(ctx, createReq)
	if err != nil {
		resp.Diagnostics.AddError("Error Creating API Key", err.Error())
		return
	}

	// Write computed values back into plan before saving state.
	plan.ID = types.StringValue(created.ID)
	plan.Key = types.StringValue(created.Key)
	plan.CreatedAt = types.StringValue(created.CreatedAt)

	permElems := make([]attr.Value, len(created.Permissions))
	for i, p := range created.Permissions {
		permElems[i] = types.StringValue(p)
	}
	permList, diags := types.ListValue(types.StringType, permElems)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	plan.Permissions = permList

	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

// Read calls GET /keys and refreshes state from the API response.
// If the key no longer exists, it removes it from state so Terraform will
// plan a re-create.
func (r *ApiKeyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state ApiKeyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	keys, err := r.client.ListKeys(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Error Reading API Keys", err.Error())
		return
	}

	// Find this key by its stored ID.
	var found *APIKey
	for i := range keys {
		if keys[i].ID == state.ID.ValueString() {
			found = &keys[i]
			break
		}
	}

	if found == nil {
		// Key was deleted outside of Terraform — remove from state.
		resp.State.RemoveResource(ctx)
		return
	}

	state.Name = types.StringValue(found.Name)
	state.CreatedAt = types.StringValue(found.CreatedAt)

	permElems := make([]attr.Value, len(found.Permissions))
	for i, p := range found.Permissions {
		permElems[i] = types.StringValue(p)
	}
	permList, diags := types.ListValue(types.StringType, permElems)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	state.Permissions = permList

	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

// Update is not supported — all changes require a replace.
// The schema marks name and permissions with RequiresReplace, so Terraform
// will never call Update; this method exists only to satisfy the interface.
func (r *ApiKeyResource) Update(_ context.Context, _ resource.UpdateRequest, resp *resource.UpdateResponse) {
	resp.Diagnostics.AddError(
		"API Key Update Not Supported",
		"Faultline API keys are immutable. Changes to name or permissions will "+
			"automatically trigger a destroy-then-create cycle.",
	)
}

// Delete calls DELETE /keys/:id to remove the key from Faultline.
func (r *ApiKeyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state ApiKeyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteKey(ctx, state.ID.ValueString()); err != nil {
		resp.Diagnostics.AddError(
			"Error Deleting API Key",
			fmt.Sprintf("Could not delete key %s: %s", state.ID.ValueString(), err),
		)
		return
	}
}
