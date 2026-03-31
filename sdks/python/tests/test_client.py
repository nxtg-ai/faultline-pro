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
    ComplianceDeadline,
    ComplianceDiffResult,
    ComplianceGateResponse,
    DashboardResponse,
    GdprErasureResult,
    ScanDiffResult,
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


class TestComplianceN176:
    """Tests for N-176: compliance diff + enhanced get_scan_compliance."""

    def test_get_scan_compliance_with_threshold(self):
        """get_scan_compliance() sends threshold query param."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.get_scan_compliance("scan-1", threshold=80)
        except Exception:
            pass
        assert "threshold=80" in captured[0].full_url

    def test_get_scan_compliance_with_strict(self):
        """get_scan_compliance() sends strict query param."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.get_scan_compliance("scan-1", strict=True)
        except Exception:
            pass
        assert "strict=true" in captured[0].full_url

    def test_get_scan_compliance_combined_params(self):
        """get_scan_compliance() combines all query params."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.get_scan_compliance("scan-1", project_name="Proj", threshold=90, strict=True)
        except Exception:
            pass
        url = captured[0].full_url
        assert "projectName=Proj" in url
        assert "threshold=90" in url
        assert "strict=true" in url

    def test_compliance_diff_url(self):
        """compliance_diff() hits POST /scan/compliance-diff."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_diff("before-1", "after-2")
        except Exception:
            pass
        assert "/scan/compliance-diff" in captured[0].full_url
        assert captured[0].method == "POST"

    def test_compliance_diff_body(self):
        """compliance_diff() sends beforeId and afterId."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_diff("b1", "a2", project_name="Proj")
        except Exception:
            pass
        body = json.loads(captured[0].data.decode())
        assert body["beforeId"] == "b1"
        assert body["afterId"] == "a2"
        assert body["projectName"] == "Proj"

    def test_compliance_diff_result_parsing(self):
        """compliance_diff() returns a ComplianceDiffResult."""
        diff_body = {
            "articles": [{"article": "Article 9", "trend": "improved"}],
            "summary": {"improved": 1, "regressed": 0, "unchanged": 3},
            "riskTrend": "improved",
        }
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, diff_body))
        result = client.compliance_diff("b1", "a2")
        assert isinstance(result, ComplianceDiffResult)
        assert result.risk_trend == "improved"
        assert len(result.articles) == 1
        assert result.summary["improved"] == 1

    def test_compliance_diff_without_project_name(self):
        """compliance_diff() omits projectName when not provided."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_diff("b1", "a2")
        except Exception:
            pass
        body = json.loads(captured[0].data.decode())
        assert "projectName" not in body


DEEP_SCAN_RESPONSE: dict = {
    **SCAN_RESPONSE,
    "evidenceLinks": [
        {"claimId": "c1", "url": "https://en.wikipedia.org/wiki/Eiffel_Tower", "status": "valid", "score": 0.95},
    ],
}


class TestScanDeep:
    """Tests for scan_deep() method."""

    def test_scan_deep_url_and_method(self):
        """scan_deep() hits POST /scan/deep."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.scan_deep("test text")
        except Exception:
            pass
        assert "/scan/deep" in captured[0].full_url
        assert captured[0].method == "POST"

    def test_scan_deep_sends_provider(self):
        """scan_deep() includes provider in body."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.scan_deep("test", provider="mock")
        except Exception:
            pass
        body = json.loads(captured[0].data.decode())
        assert body["provider"] == "mock"

    def test_scan_deep_result_has_evidence_links(self):
        """scan_deep() returns dict with evidenceLinks."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, DEEP_SCAN_RESPONSE))
        result = client.scan_deep("text")
        assert "evidenceLinks" in result
        assert len(result["evidenceLinks"]) == 1
        assert result["evidenceLinks"][0]["score"] == 0.95


SCAN_DIFF_RESPONSE: dict = {
    "before": {"input": "old text", "overallRisk": "high"},
    "after": {"input": "new text", "overallRisk": "low"},
    "newClaims": [{"id": "c2", "text": "New claim", "type": "factual", "importance": 5}],
    "removedClaims": [{"id": "c1", "text": "Old claim", "type": "factual", "importance": 3}],
    "changedVerdicts": [{"claim": {"id": "c3", "text": "Changed"}, "before": "refuted", "after": "supported"}],
    "trustScoreDelta": -2,
    "summary": "Risk improved",
    "inlineDiff": [
        {"type": "added", "claim": "New claim"},
        {"type": "removed", "claim": "Old claim"},
        {"type": "changed", "claim": "Changed", "before": "refuted", "after": "supported"},
    ],
}

DEADLINES_RESPONSE: dict = {
    "deadlines": [
        {
            "id": "eu-ai-act-art50",
            "name": "EU AI Act Article 50",
            "regulation": "EU AI Act",
            "description": "Transparency obligations for AI systems",
            "deadline": "2026-08-02",
            "daysUntil": 124,
            "severity": "critical",
            "url": "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689",
        }
    ]
}

TRENDING_RESPONSE: dict = {
    "trending": [{"text": "AI is transformative", "frequency": 42, "lastVerdict": "supported"}],
    "emerging": [{"text": "New claim", "frequency": 1, "firstSeen": "2026-03-30T00:00:00Z"}],
    "verdictChanged": [{"text": "Flipped", "before": "supported", "after": "refuted"}],
}

GDPR_ERASURE_RESPONSE: dict = {
    "tenantId": "tenant-abc",
    "deleted": {
        "scanEntries": 15,
        "auditEntries": 42,
        "notifications": 3,
        "notificationPrefs": 1,
        "webhooks": 2,
        "costs": 8,
        "schedules": 1,
        "usageKeys": 2,
    },
}


class TestScanDiff:
    """Tests for N-178: scan_diff() method."""

    def test_scan_diff_url_and_method(self):
        """scan_diff() hits POST /scan/diff."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.scan_diff("old text", "new text")
        except Exception:
            pass
        assert "/scan/diff" in captured[0].full_url
        assert captured[0].method == "POST"

    def test_scan_diff_body(self):
        """scan_diff() sends before, after, and optional provider."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.scan_diff("old", "new", provider="mock")
        except Exception:
            pass
        body = json.loads(captured[0].data.decode())
        assert body["before"] == "old"
        assert body["after"] == "new"
        assert body["provider"] == "mock"

    def test_scan_diff_omits_provider_when_none(self):
        """scan_diff() omits provider when not specified."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.scan_diff("a", "b")
        except Exception:
            pass
        body = json.loads(captured[0].data.decode())
        assert "provider" not in body

    def test_scan_diff_result_parsing(self):
        """scan_diff() returns a ScanDiffResult with all fields."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, SCAN_DIFF_RESPONSE))
        result = client.scan_diff("old text", "new text")
        assert isinstance(result, ScanDiffResult)
        assert result.summary == "Risk improved"
        assert result.trust_score_delta == -2
        assert len(result.new_claims) == 1
        assert len(result.removed_claims) == 1
        assert len(result.changed_verdicts) == 1
        assert len(result.inline_diff) == 3


class TestComplianceDeadlines:
    """Tests for N-178: compliance_deadlines() method."""

    def test_compliance_deadlines_url(self):
        """compliance_deadlines() hits GET /compliance/deadlines."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_deadlines()
        except Exception:
            pass
        assert "/compliance/deadlines" in captured[0].full_url
        assert captured[0].method == "GET"

    def test_compliance_deadlines_with_days(self):
        """compliance_deadlines() passes days query param."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_deadlines(days=90)
        except Exception:
            pass
        assert "days=90" in captured[0].full_url

    def test_compliance_deadlines_result_parsing(self):
        """compliance_deadlines() returns list of ComplianceDeadline."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, DEADLINES_RESPONSE))
        result = client.compliance_deadlines()
        assert isinstance(result, list)
        assert len(result) == 1
        assert isinstance(result[0], ComplianceDeadline)
        assert result[0].regulation == "EU AI Act"
        assert result[0].days_until == 124
        assert result[0].severity == "critical"

    def test_compliance_deadlines_without_days(self):
        """compliance_deadlines() omits days param when not specified."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.compliance_deadlines()
        except Exception:
            pass
        assert "?" not in captured[0].full_url


class TestClaimsTrending:
    """Tests for N-178: claims_trending() method."""

    def test_claims_trending_url(self):
        """claims_trending() hits GET /claims/trending."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.claims_trending()
        except Exception:
            pass
        assert "/claims/trending" in captured[0].full_url
        assert captured[0].method == "GET"

    def test_claims_trending_result(self):
        """claims_trending() returns dict with trending/emerging/verdictChanged."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, TRENDING_RESPONSE))
        result = client.claims_trending()
        assert "trending" in result
        assert "emerging" in result
        assert "verdictChanged" in result
        assert len(result["trending"]) == 1
        assert result["trending"][0]["frequency"] == 42


class TestGdpr:
    """Tests for N-178: GDPR export and erasure methods."""

    def test_gdpr_export_url(self):
        """gdpr_export() hits GET /tenants/:id/export."""
        captured: list[urllib.request.Request] = []

        class FakeResp:
            def read(self) -> bytes:
                return b"PK\x03\x04fake-zip-data"

        def mock_http(req: urllib.request.Request):
            captured.append(req)
            return FakeResp()

        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        result = client.gdpr_export("tenant-abc")
        assert "/tenants/tenant-abc/export" in captured[0].full_url
        assert captured[0].method == "GET"
        assert result == b"PK\x03\x04fake-zip-data"

    def test_gdpr_export_returns_bytes(self):
        """gdpr_export() returns raw bytes (ZIP content)."""
        zip_bytes = b"PK\x03\x04\x00\x00zipdata"

        class FakeResp:
            def read(self) -> bytes:
                return zip_bytes

        client = FaultlineClient(api_key="k", _http_fn=lambda _: FakeResp())
        result = client.gdpr_export("t1")
        assert isinstance(result, bytes)
        assert result == zip_bytes

    def test_gdpr_export_404(self):
        """gdpr_export() raises FaultlineError on 404."""
        def error_http(req: urllib.request.Request):
            raise urllib.error.HTTPError(
                req.full_url, 404, "Not Found", {},
                io.BytesIO(json.dumps({"error": "Tenant not found"}).encode()),
            )

        client = FaultlineClient(api_key="k", _http_fn=error_http)
        with pytest.raises(FaultlineError) as exc_info:
            client.gdpr_export("nonexistent")
        assert exc_info.value.status_code == 404

    def test_gdpr_erase_url_and_method(self):
        """gdpr_erase() hits DELETE /tenants/:id/data."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.gdpr_erase("tenant-abc")
        except Exception:
            pass
        assert "/tenants/tenant-abc/data" in captured[0].full_url
        assert captured[0].method == "DELETE"

    def test_gdpr_erase_result_parsing(self):
        """gdpr_erase() returns GdprErasureResult with deletion counts."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, GDPR_ERASURE_RESPONSE))
        result = client.gdpr_erase("tenant-abc")
        assert isinstance(result, GdprErasureResult)
        assert result.tenant_id == "tenant-abc"
        assert result.deleted["scanEntries"] == 15
        assert result.deleted["webhooks"] == 2

    def test_gdpr_erase_404(self):
        """gdpr_erase() raises FaultlineError on 404."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(404, {"error": "Tenant not found"}))
        with pytest.raises(FaultlineError) as exc_info:
            client.gdpr_erase("nonexistent")
        assert exc_info.value.status_code == 404


class TestClientSecurity:
    """Security-related client tests."""

    def test_rejects_file_protocol_base_url(self):
        """FaultlineClient must reject file:// URLs to prevent SSRF."""
        with pytest.raises(ValueError, match="http or https"):
            FaultlineClient(api_key="k", base_url="file:///etc/passwd")

    def test_rejects_ftp_protocol_base_url(self):
        """FaultlineClient must reject ftp:// URLs."""
        with pytest.raises(ValueError, match="http or https"):
            FaultlineClient(api_key="k", base_url="ftp://evil.com")

    def test_accepts_https_base_url(self):
        """FaultlineClient must accept https:// URLs."""
        client = FaultlineClient(api_key="k", base_url="https://api.faultline.io")
        assert client._base_url == "https://api.faultline.io"

    def test_strips_trailing_slash(self):
        """FaultlineClient must strip trailing slash from base_url."""
        client = FaultlineClient(api_key="k", base_url="http://localhost:3000/")
        assert client._base_url == "http://localhost:3000"

    def test_api_key_sent_in_header(self):
        """Every request must include x-api-key header."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="secret-key-123", _http_fn=mock_http)
        try:
            client.claims_trending()
        except Exception:
            pass
        assert captured[0].get_header("X-api-key") == "secret-key-123"


NPM_DOWNLOADS_RESPONSE = {
    "packages": [
        {"package": "@nxtg/faultline", "downloads": [{"day": "2026-03-30", "downloads": 42}], "totalDownloads": 42, "lastFetched": "2026-03-30T12:00:00Z"},
    ],
    "grandTotal": 42,
    "period": {"start": "2026-03-30", "end": "2026-03-30"},
    "fetchedAt": "2026-03-30T12:00:00Z",
}

NPM_PACKAGE_RESPONSE = {
    "package": "@nxtg/faultline",
    "downloads": [{"day": "2026-03-30", "downloads": 42}],
    "totalDownloads": 42,
    "lastFetched": "2026-03-30T12:00:00Z",
}

NPM_TREND_RESPONSE = {
    "package": "@nxtg/faultline",
    "weeks": 12,
    "trend": [{"week": "2026-03-23", "downloads": 100}, {"week": "2026-03-30", "downloads": 120}],
}


class TestNpmMetrics:
    """Tests for N-189: npm download metrics SDK methods."""

    def test_npm_downloads_url(self):
        """npm_downloads() hits GET /npm/downloads."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.npm_downloads()
        except Exception:
            pass
        assert "/npm/downloads" in captured[0].full_url
        assert captured[0].method == "GET"

    def test_npm_downloads_returns_dict(self):
        """npm_downloads() returns parsed overview dict."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, NPM_DOWNLOADS_RESPONSE))
        result = client.npm_downloads()
        assert result["grandTotal"] == 42
        assert len(result["packages"]) == 1

    def test_npm_package_downloads_url_encodes_scoped_name(self):
        """npm_package_downloads() URL-encodes scoped package names."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.npm_package_downloads("@nxtg/faultline")
        except Exception:
            pass
        assert "%40nxtg%2Ffaultline" in captured[0].full_url

    def test_npm_package_downloads_returns_data(self):
        """npm_package_downloads() returns parsed package data."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, NPM_PACKAGE_RESPONSE))
        result = client.npm_package_downloads("@nxtg/faultline")
        assert result["totalDownloads"] == 42

    def test_npm_trend_url_with_weeks(self):
        """npm_trend() passes weeks as query parameter."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.npm_trend("@nxtg/faultline", weeks=4)
        except Exception:
            pass
        assert "weeks=4" in captured[0].full_url

    def test_npm_trend_returns_data(self):
        """npm_trend() returns parsed trend data."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, NPM_TREND_RESPONSE))
        result = client.npm_trend("@nxtg/faultline")
        assert result["weeks"] == 12
        assert len(result["trend"]) == 2

    def test_npm_poll_url_and_method(self):
        """npm_poll() hits POST /npm/poll."""
        captured, mock_http = _captured_request()
        client = FaultlineClient(api_key="k", _http_fn=mock_http)
        try:
            client.npm_poll()
        except Exception:
            pass
        assert "/npm/poll" in captured[0].full_url
        assert captured[0].method == "POST"

    def test_npm_poll_returns_result(self):
        """npm_poll() returns parsed result dict."""
        client = FaultlineClient(api_key="k", _http_fn=make_mock_http(200, {"status": "polled", "fetchedAt": "2026-03-30T12:00:00Z"}))
        result = client.npm_poll()
        assert result["status"] == "polled"


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
