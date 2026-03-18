// Package provider — client.go provides a thin HTTP client that wraps the
// Faultline REST API. Resources and data sources share a single instance
// injected via provider Configure.
package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// FaultlineClient is a minimal REST client for the Faultline API.
// It is created once in provider Configure and shared across all resources
// and data sources.
type FaultlineClient struct {
	apiKey  string
	baseURL string
	http    *http.Client
}

// NewFaultlineClient constructs a FaultlineClient with a 30-second timeout.
func NewFaultlineClient(apiKey, baseURL string) *FaultlineClient {
	return &FaultlineClient{
		apiKey:  apiKey,
		baseURL: baseURL,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// doRequest performs an authenticated HTTP request and decodes the JSON
// response body into out (if out is non-nil).
func (c *FaultlineClient) doRequest(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	var bodyReader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshalling request body: %w", err)
		}
		bodyReader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("executing request %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("API error %d for %s %s: %s", resp.StatusCode, method, path, string(respBody))
	}

	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("decoding response from %s %s: %w", method, path, err)
		}
	}

	return nil
}

// --- API response types ---

// APIKey represents a Faultline API key as returned by POST /keys and GET /keys.
type APIKey struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Permissions []string `json:"permissions"`
	Key         string   `json:"key"`
	CreatedAt   string   `json:"createdAt"`
}

// APIKeyListResponse wraps the array returned by GET /keys.
type APIKeyListResponse struct {
	Keys []APIKey `json:"keys"`
}

// CreateKeyRequest is the body sent to POST /keys.
type CreateKeyRequest struct {
	Name        string   `json:"name"`
	Permissions []string `json:"permissions"`
}

// ScanResponse represents the scan result returned by POST /scan.
type ScanResponse struct {
	ID          string `json:"id"`
	OverallRisk string `json:"overallRisk"`
	ClaimsCount int64  `json:"claimsCount"`
}

// ScanRequest is the body sent to POST /scan.
type ScanRequest struct {
	Text     string `json:"text"`
	Provider string `json:"provider,omitempty"`
}

// --- Client methods ---

// CreateKey calls POST /keys and returns the created API key.
func (c *FaultlineClient) CreateKey(ctx context.Context, req CreateKeyRequest) (*APIKey, error) {
	var key APIKey
	if err := c.doRequest(ctx, http.MethodPost, "/keys", req, &key); err != nil {
		return nil, err
	}
	return &key, nil
}

// ListKeys calls GET /keys and returns all keys.
func (c *FaultlineClient) ListKeys(ctx context.Context) ([]APIKey, error) {
	var resp APIKeyListResponse
	if err := c.doRequest(ctx, http.MethodGet, "/keys", nil, &resp); err != nil {
		return nil, err
	}
	return resp.Keys, nil
}

// DeleteKey calls DELETE /keys/:id.
func (c *FaultlineClient) DeleteKey(ctx context.Context, id string) error {
	return c.doRequest(ctx, http.MethodDelete, "/keys/"+id, nil, nil)
}

// Scan calls POST /scan and returns the scan result.
func (c *FaultlineClient) Scan(ctx context.Context, req ScanRequest) (*ScanResponse, error) {
	var resp ScanResponse
	if err := c.doRequest(ctx, http.MethodPost, "/scan", req, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}
