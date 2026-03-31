"""Tests for FaultlineClient.

All tests use the _http_fn injection point so no real network I/O occurs.
"""
from __future__ import annotations

import io
import json
import urllib.error
import urllib.request

import pytest

from faultline_sdk import FaultlineClient, FaultlineError
from faultline_sdk.models import (
    ApiKey,
    BatchScanResponse,
    ComplianceGateResponse,
    DashboardResponse,
    ScanResult,
    UsageResponse,
    Webhook,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_mock_http(status: int, body: dict | None):
    """Return a mock _http_fn that simulates an API response.

    For 4xx/5xx status codes the function raises ``urllib.error.HTTPError``,
    matching the behaviour of ``urllib.request.urlopen``.

    Args:
        status: HTTP status code to simulate.
        body: Response body dict (JSON-serialised before returning).

    Returns:
        A callable compatible with the ``HttpFn`` type alias.
    """

    class FakeResp:
        def read(self) -> bytes:
            return json.dumps(body).encode() if body is not None else b""

    def mock_http(req: urllib.request.Request):
        if status >= 400:
            raise urllib.error.HTTPError(
                req.full_url,
                status,
                "error",
                {},  # type: ignore[arg-type]
                io.BytesIO(json.dumps(body or {}).encode()),
            )
        return FakeResp()

    return mock_http


def _captured_request() -> tuple[list[urllib.request.Request], "mock_http"]:
    """Return a (requests_log, mock_http) pair that records every request made.

    The mock always returns an empty 200 body; callers that need a specific
    response body should not use this helper — use ``make_mock_http`` directly.
    """
    captured: list[urllib.request.Request] = []

    class FakeResp:
        def read(self) -> bytes:
            return b"null"

    def mock_http(req: urllib.request.Request):
        captured.append(req)
        return FakeResp()

    return captured, mock_http


# Minimal fixture data ─────────────────────────────────────────────────────────

SCAN_RESPONSE: dict = {
    "input": "The Eiffel Tower is 300 metres tall.",
    "provider": "mock",
    "overallRisk": "low",
    "claims": [
        {"id": "c1", "text": "The Eiffel Tower is 300 metres tall.", "type": "factual", "importance": 8}
    ],
    "verifications": {
        "c1": {
            "claimId": "c1",
            "status": "supported",
            "explanation": "Verified against multiple sources.",
            "sources": [{"title": "Wikipedia", "url": "https://en.wikipedia.org/wiki/Eiffel_Tower"}],
        }
    },
    "complianceReport": {"riskTier": "low", "findings": []},
    "ruleFindings": [],
}

BATCH_RESPONSE: dict = {
    "total": 2,
    "succeeded": 2,
    "failed": 0,
    "results": [SCAN_RESPONSE, SCAN_RESPONSE],
    "errors": [],
}

KEY_CREATE_RESPONSE: dict = {
    "id": "key-abc",
    "name": "test-key",
    "permissions": ["scan"],
    "createdAt": "2026-01-01T00:00:00Z",
    "key": "fl_live_secret123",
}

KEY_LIST_RESPONSE: list[dict] = [
    {"id": "key-abc", "name": "test-key", "permissions": ["scan"], "createdAt": "2026-01-01T00:00:00Z"},
    {"id": "key-def", "name": "admin-key", "permissions": ["admin"], "createdAt": "2026-01-02T00:00:00Z"},
]

WEBHOOK_CREATE_RESPONSE: dict = {
    "id": "wh-1",
    "url": "https://example.com/hook",
    "events": ["scan.complete"],
    "createdAt": "2026-01-01T00:00:00Z",
    "secret": "whsec_abc123",
}

WEBHOOK_LIST_RESPONSE: list[dict] = [
    {"id": "wh-1", "url": "https://example.com/hook", "events": ["scan.complete"], "createdAt": "2026-01-01T00:00:00Z"},
]

USAGE_RESPONSE: dict = {
    "keyId": "key-abc",
    "usage": {"scans": 42, "tokens": 18000},
}

DASHBOARD_RESPONSE: dict = {
    "scans": {"today": 5, "week": 30, "month": 120},
    "riskDistribution": {"low": 80, "medium": 25, "high": 10, "critical": 5},
    "keyUsage": [{"keyId": "key-abc", "scans": 120}],
}


# ── Tests ─────────────────────────────────────────────────────────────────────

class TestScan:
    def test_scan_sends_post_with_text(self):
        """scan() must send POST /scan with the text in the request body."""
        captured, mock_http = _captured_request()
        # Override to return a real scan response
        mock_http_real = make_mock_http(200, SCAN_RESPONSE)

        sent_bodies: list[bytes] = []

        def recording_http(req: urllib.request.Request):
            sent_bodies.append(req.data or b"")
            return mock_http_real(req)

        client = FaultlineClient(api_key="test-key", _http_fn=recording_http)
        client.scan("The Eiffel Tower is 300 metres tall.")

        assert len(sent_bodies) == 1
        parsed = json.loads(sent_bodies[0])
        assert parsed["text"] == "The Eiffel Tower is 300 metres tall."

    def test_scan_returns_scan_result_with_overall_risk(self):
        """scan() must return a ScanResult with an overall_risk field."""
        client = FaultlineClient(api_key="test-key", _http_fn=make_mock_http(200, SCAN_RESPONSE))
        result = client.scan("The Eiffel Tower is 300 metres tall.")

        assert isinstance(result, ScanResult)
        assert result.overall_risk == "low"

    def test_scan_raises_faultline_error_on_401(self):
        """scan() must raise FaultlineError with status_code=401 on unauthorized."""
        body = {"error": "Unauthorized"}
        client = FaultlineClient(api_key="bad-key", _http_fn=make_mock_http(401, body))

        with pytest.raises(FaultlineError) as exc_info:
            client.scan("some text")

        assert exc_info.value.status_code == 401

    def test_scan_raises_faultline_error_on_429(self):
        """scan() must raise FaultlineError with status_code=429 on rate limit."""
        body = {"error": "Rate limit exceeded"}
        client = FaultlineClient(api_key="test-key", _http_fn=make_mock_http(429, body))

        with pytest.raises(FaultlineError) as exc_info:
            client.scan("some text")

        assert exc_info.value.status_code == 429


class TestScanBatch:
    def test_scan_batch_sends_texts_array(self):
        """scan_batch() must include a 'texts' array in the POST body."""
        sent_bodies: list[bytes] = []

        def recording_http(req: urllib.request.Request):
            sent_bodies.append(req.data or b"")
            return make_mock_http(200, BATCH_RESPONSE)(req)

        client = FaultlineClient(api_key="test-key", _http_fn=recording_http)
        result = client.scan_batch(["text one", "text two"])

        assert len(sent_bodies) == 1
        parsed = json.loads(sent_bodies[0])
        assert parsed["texts"] == ["text one", "text two"]
        assert isinstance(result, BatchScanResponse)
        assert result.total == 2
        assert result.succeeded == 2
        assert result.failed == 0

    def test_scan_batch_results_list_has_correct_length(self):
        """scan_batch() results list must match the number of input texts."""
        client = FaultlineClient(api_key="test-key", _http_fn=make_mock_http(200, BATCH_RESPONSE))
        result = client.scan_batch(["a", "b"])

        assert len(result.results) == 2
        for item in result.results:
            assert isinstance(item, ScanResult)


class TestKeys:
    def test_create_key_returns_api_key_with_key_field(self):
        """create_key() must return an ApiKey that includes the secret key field."""
        client = FaultlineClient(api_key="test-key", _http_fn=make_mock_http(200, KEY_CREATE_RESPONSE))
        key = client.create_key("test-key", permissions=["scan"])

        assert isinstance(key, ApiKey)
        assert key.id == "key-abc"
        assert key.key == "fl_live_secret123"

    def test_list_keys_returns_list_of_api_keys(self):
        """list_keys() must return a list of ApiKey objects."""
        client = FaultlineClient(api_key="test-key", _http_fn=make_mock_http(200, KEY_LIST_RESPONSE))
        keys = client.list_keys()

        assert isinstance(keys, list)
        assert len(keys) == 2
        assert all(isinstance(k, ApiKey) for k in keys)

    def test_delete_key_calls_delete_endpoint(self):
        """delete_key() must send DELETE to /keys/:id."""
        captured_methods: list[str] = []
        captured_urls: list[str] = []

        def recording_http(req: urllib.request.Request):
            captured_methods.append(req.get_method())
            captured_urls.append(req.full_url)

            class Resp:
                def read(self):
                    return b"null"

            return Resp()

        client = FaultlineClient(api_key="test-key", base_url="http://localhost:3000", _http_fn=recording_http)
        client.delete_key("key-abc")

        assert captured_methods == ["DELETE"]
        assert captured_urls[0].endswith("/keys/key-abc")


class TestWebhooks:
    def test_create_webhook_returns_webhook_with_id_and_secret(self):
        """create_webhook() must return a Webhook with both id and secret populated."""
        client = FaultlineClient(api_key="test-key", _http_fn=make_mock_http(200, WEBHOOK_CREATE_RESPONSE))
        webhook = client.create_webhook("https://example.com/hook", ["scan.complete"], secret="mysecret")

        assert isinstance(webhook, Webhook)
        assert webhook.id == "wh-1"
        assert webhook.secret == "whsec_abc123"

    def test_list_webhooks_returns_list_without_secret(self):
        """list_webhooks() must return a list of Webhook objects with secret=None."""
        client = FaultlineClient(api_key="test-key", _http_fn=make_mock_http(200, WEBHOOK_LIST_RESPONSE))
        webhooks = client.list_webhooks()

        assert isinstance(webhooks, list)
        assert len(webhooks) == 1
        assert webhooks[0].secret is None

    def test_delete_webhook_calls_delete_endpoint(self):
        """delete_webhook() must send DELETE to /webhooks/:id."""
        captured_methods: list[str] = []
        captured_urls: list[str] = []

        def recording_http(req: urllib.request.Request):
            captured_methods.append(req.get_method())
            captured_urls.append(req.full_url)

            class Resp:
                def read(self):
                    return b"null"

            return Resp()

        client = FaultlineClient(api_key="test-key", base_url="http://localhost:3000", _http_fn=recording_http)
        client.delete_webhook("wh-1")

        assert captured_methods == ["DELETE"]
        assert captured_urls[0].endswith("/webhooks/wh-1")


class TestUsageAndDashboard:
    def test_get_usage_returns_usage_response(self):
        """get_usage() must return a UsageResponse with key_id and usage dict."""
        client = FaultlineClient(api_key="test-key", _http_fn=make_mock_http(200, USAGE_RESPONSE))
        usage = client.get_usage()

        assert isinstance(usage, UsageResponse)
        assert usage.key_id == "key-abc"
        assert isinstance(usage.usage, dict)
        assert usage.usage["scans"] == 42

    def test_get_dashboard_returns_dashboard_response(self):
        """get_dashboard() must return a DashboardResponse with the three required fields."""
        client = FaultlineClient(api_key="test-key", _http_fn=make_mock_http(200, DASHBOARD_RESPONSE))
        dash = client.get_dashboard()

        assert isinstance(dash, DashboardResponse)
        assert "today" in dash.scans
        assert "low" in dash.risk_distribution
        assert isinstance(dash.key_usage, list)


COMPLIANCE_GATE_RESPONSE: dict = {
    "gate": {
        "pass": True,
        "overallRisk": "low",
        "articles": [
            {"article": "Article 9 – Risk Management System", "status": "compliant", "pass": True},
            {"article": "Article 13 – Transparency", "status": "compliant", "pass": True},
        ],
        "nonCompliantCount": 0,
        "totalArticles": 2,
        "exitCode": 0,
    },
    "report": {
        "articleEvidence": [{"article": "Article 9", "status": "compliant", "findings": []}],
        "summary": {"compliantArticles": 2, "nonCompliantArticles": 0},
    },
    "scanId": "scan-abc-123",
}

COMPLIANCE_GATE_FAIL_RESPONSE: dict = {
    "gate": {
        "pass": False,
        "overallRisk": "critical",
        "articles": [
            {"article": "Article 9 – Risk Management System", "status": "non-compliant", "pass": False},
        ],
        "nonCompliantCount": 1,
        "totalArticles": 1,
        "exitCode": 1,
    },
    "report": {"articleEvidence": [], "summary": {"nonCompliantArticles": 1}},
    "scanId": "scan-fail-456",
}


class TestComplianceGate:
    def test_compliance_gate_pass(self):
        """compliance_gate() returns ComplianceGateResponse with pass=True on 200."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, COMPLIANCE_GATE_RESPONSE))
        resp = client.compliance_gate("Safe text.", provider="mock")
        assert isinstance(resp, ComplianceGateResponse)
        assert resp.gate.passed is True
        assert resp.gate.exit_code == 0
        assert resp.gate.non_compliant_count == 0
        assert resp.scan_id == "scan-abc-123"

    def test_compliance_gate_fail_422(self):
        """compliance_gate() handles 422 (gate failed) without raising."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(422, COMPLIANCE_GATE_FAIL_RESPONSE))
        resp = client.compliance_gate("Bad text.", provider="mock")
        assert isinstance(resp, ComplianceGateResponse)
        assert resp.gate.passed is False
        assert resp.gate.exit_code == 1
        assert resp.gate.non_compliant_count == 1

    def test_compliance_gate_articles_parsed(self):
        """compliance_gate() response contains per-article results."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, COMPLIANCE_GATE_RESPONSE))
        resp = client.compliance_gate("Text.")
        assert len(resp.gate.articles) == 2
        assert resp.gate.articles[0].article == "Article 9 – Risk Management System"
        assert resp.gate.articles[0].passed is True

    def test_compliance_gate_project_name(self):
        """compliance_gate() sends projectName in request body."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_gate("Text.", project_name="MyProject")
        except Exception:
            pass
        assert len(captured) == 1
        body = json.loads(captured[0].data)
        assert body["projectName"] == "MyProject"

    def test_compliance_gate_sends_provider(self):
        """compliance_gate() sends provider in request body."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_gate("Text.", provider="mock")
        except Exception:
            pass
        body = json.loads(captured[0].data)
        assert body["provider"] == "mock"

    def test_get_scan_compliance_pass(self):
        """get_scan_compliance() returns ComplianceGateResponse for existing scan."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, COMPLIANCE_GATE_RESPONSE))
        resp = client.get_scan_compliance("scan-abc-123")
        assert isinstance(resp, ComplianceGateResponse)
        assert resp.gate.passed is True

    def test_get_scan_compliance_404(self):
        """get_scan_compliance() raises FaultlineError on 404."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(404, {"error": "Scan not found."}))
        with pytest.raises(FaultlineError) as exc_info:
            client.get_scan_compliance("nonexistent")
        assert exc_info.value.status_code == 404

    def test_get_scan_compliance_project_name_in_url(self):
        """get_scan_compliance() includes projectName in query string."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.get_scan_compliance("scan-123", project_name="TestProj")
        except Exception:
            pass
        assert "projectName=TestProj" in captured[0].full_url


class TestComplianceEnhancements:
    """Tests for N-171: compliance threshold, badge, history, and trend."""

    def test_compliance_gate_with_threshold(self):
        """compliance_gate() sends threshold in request body."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_gate("Test.", provider="mock", threshold=80)
        except Exception:
            pass
        body = json.loads(captured[0].data.decode()) if captured[0].data else {}
        assert body.get("threshold") == 80

    def test_compliance_gate_with_strict(self):
        """compliance_gate() sends strict in request body."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_gate("Test.", provider="mock", strict=True)
        except Exception:
            pass
        body = json.loads(captured[0].data.decode()) if captured[0].data else {}
        assert body.get("strict") is True

    def test_compliance_badge_url(self):
        """compliance_badge() hits the correct endpoint."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        client.compliance_badge("scan-123")
        assert "/scan/scan-123/compliance/badge" in captured[0].full_url

    def test_compliance_badge_custom_label(self):
        """compliance_badge() includes label in query string."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        client.compliance_badge("scan-123", label="MyProject")
        assert "label=MyProject" in captured[0].full_url

    def test_compliance_history_url(self):
        """compliance_history() hits the correct endpoint."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_history(project_name="Alpha")
        except Exception:
            pass
        assert "/compliance/history" in captured[0].full_url
        assert "projectName=Alpha" in captured[0].full_url

    def test_compliance_history_with_limit(self):
        """compliance_history() passes limit parameter."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_history(limit=10)
        except Exception:
            pass
        assert "limit=10" in captured[0].full_url

    def test_compliance_trend_url(self):
        """compliance_trend() hits the correct endpoint."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_trend("TestProject")
        except Exception:
            pass
        assert "/compliance/trend" in captured[0].full_url
        assert "projectName=TestProject" in captured[0].full_url

    def test_compliance_gate_without_optional_params(self):
        """compliance_gate() omits threshold/strict when not provided."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_gate("Test.", provider="mock")
        except Exception:
            pass
        body = json.loads(captured[0].data.decode()) if captured[0].data else {}
        assert "threshold" not in body
        assert "strict" not in body


class TestFaultlineError:
    def test_faultline_error_has_correct_status_code_and_body(self):
        """FaultlineError must expose status_code and body from the API response."""
        error_body = {"error": "Forbidden", "code": "PERMISSION_DENIED"}
        client = FaultlineClient(api_key="test-key", _http_fn=make_mock_http(403, error_body))

        with pytest.raises(FaultlineError) as exc_info:
            client.scan("some text")

        err = exc_info.value
        assert err.status_code == 403
        assert err.body == error_body
        assert "Forbidden" in str(err)
