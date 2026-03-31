"""Faultline API client.

Uses only the Python standard library — no external HTTP dependencies.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable

from .exceptions import FaultlineError
from .models import (
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

# Callable type for the injected HTTP transport (enables testing without network I/O).
HttpFn = Callable[[urllib.request.Request], Any]


class FaultlineClient:
    """HTTP client for the Faultline Pro REST API.

    All methods raise :class:`~faultline_sdk.exceptions.FaultlineError` on
    non-2xx responses.  The ``_http_fn`` constructor parameter lets tests inject
    a fake transport so no real network calls are required.

    Args:
        api_key: API key used in the ``x-api-key`` request header.
        base_url: Root URL of the Faultline API (default: ``http://localhost:3000``).
        _http_fn: Optional transport override for testing.

    Example::

        import os
        from faultline_sdk import FaultlineClient

        client = FaultlineClient(api_key=os.environ["FAULTLINE_API_KEY"])
        result = client.scan("The Eiffel Tower is 300 metres tall.")
        print(result.overall_risk)
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = "http://localhost:3000",
        _http_fn: HttpFn | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        # Validate URL scheme to prevent SSRF via file:// or other protocols
        from urllib.parse import urlparse
        parsed = urlparse(self._base_url)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(f"base_url must use http or https scheme, got: {parsed.scheme!r}")
        self._http_fn = _http_fn or self._default_http

    # ── Transport ─────────────────────────────────────────────────────────────

    def _default_http(self, req: urllib.request.Request) -> Any:
        """Default transport: delegates to ``urllib.request.urlopen``."""
        return urllib.request.urlopen(req, timeout=30)

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None, *, raw: bool = False) -> Any:
        """Execute an authenticated API request and return the parsed JSON body.

        Args:
            method: HTTP verb (e.g. 'GET', 'POST', 'DELETE').
            path: API path starting with '/' (e.g. '/scan').
            body: Optional JSON-serialisable request body.
            raw: If True, return the raw response text instead of parsed JSON.

        Returns:
            Parsed JSON response, raw text if ``raw=True``, or ``None`` for empty responses.

        Raises:
            FaultlineError: If the server returns a 4xx or 5xx status code.
        """
        url = f"{self._base_url}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "x-api-key": self._api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            resp = self._http_fn(req)
            resp_bytes = resp.read()
            if raw:
                return resp_bytes.decode() if resp_bytes else ""
            return json.loads(resp_bytes) if resp_bytes else None
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                body_dict: dict[str, Any] = json.loads(raw)
            except Exception:
                body_dict = {"raw": raw.decode(errors="replace")}
            msg = body_dict.get("error", f"HTTP {exc.code}")
            raise FaultlineError(msg, status_code=exc.code, body=body_dict) from exc

    # ── Keys ──────────────────────────────────────────────────────────────────

    def create_key(self, name: str, permissions: list[str] | None = None) -> ApiKey:
        """Create a new API key.

        Args:
            name: Human-readable label for the key.
            permissions: List of permission strings.  Defaults to ``['scan']``.

        Returns:
            The created :class:`~faultline_sdk.models.ApiKey`, with ``key`` field populated.
        """
        data = self._request("POST", "/keys", {"name": name, "permissions": permissions or ["scan"]})
        return ApiKey(
            id=data["id"],
            name=data["name"],
            permissions=data["permissions"],
            created_at=data["createdAt"],
            key=data.get("key"),
        )

    def list_keys(self) -> list[ApiKey]:
        """List all API keys visible to the authenticated user.

        Returns:
            List of :class:`~faultline_sdk.models.ApiKey` objects (``key`` field omitted).
        """
        data = self._request("GET", "/keys")
        return [
            ApiKey(
                id=d["id"],
                name=d["name"],
                permissions=d["permissions"],
                created_at=d["createdAt"],
            )
            for d in data
        ]

    def delete_key(self, key_id: str) -> None:
        """Delete an API key by ID.

        Args:
            key_id: ID of the key to delete.
        """
        self._request("DELETE", f"/keys/{key_id}")

    # ── Scan ──────────────────────────────────────────────────────────────────

    def scan(self, text: str, provider: str | None = None) -> ScanResult:
        """Submit text for claim extraction and risk scoring.

        Args:
            text: The AI-generated text to analyse.
            provider: Optional AI provider override (e.g. ``'gemini'``, ``'mock'``).

        Returns:
            A :class:`~faultline_sdk.models.ScanResult` with claims, verifications,
            and the overall risk level.
        """
        body: dict[str, Any] = {"text": text}
        if provider is not None:
            body["provider"] = provider
        return ScanResult.from_dict(self._request("POST", "/scan", body))

    def scan_batch(self, texts: list[str], provider: str | None = None) -> BatchScanResponse:
        """Submit multiple texts for parallel claim verification.

        Args:
            texts: List of texts to analyse.
            provider: Optional AI provider override applied to all items.

        Returns:
            A :class:`~faultline_sdk.models.BatchScanResponse` with per-item results.
        """
        body: dict[str, Any] = {"texts": texts}
        if provider is not None:
            body["provider"] = provider
        return BatchScanResponse.from_dict(self._request("POST", "/scan/batch", body))

    def scan_diff(
        self,
        before: str,
        after: str,
        provider: str | None = None,
    ) -> ScanDiffResult:
        """Compare two texts by scanning both and diffing at the claim level.

        Args:
            before: The baseline text.
            after: The comparison text.
            provider: Optional AI provider override.

        Returns:
            A :class:`~faultline_sdk.models.ScanDiffResult` with new/removed/changed claims.
        """
        body: dict[str, Any] = {"before": before, "after": after}
        if provider is not None:
            body["provider"] = provider
        return ScanDiffResult.from_dict(self._request("POST", "/scan/diff", body))

    # ── Compliance Gate ───────────────────────────────────────────────────────

    def compliance_gate(
        self,
        text: str,
        provider: str | None = None,
        project_name: str | None = None,
        threshold: int | None = None,
        strict: bool | None = None,
    ) -> ComplianceGateResponse:
        """Scan text and evaluate EU AI Act compliance in a single call.

        Returns a :class:`~faultline_sdk.models.ComplianceGateResponse` containing
        the pass/fail gate result, full compliance report, and the stored scan ID.

        The API returns HTTP 200 on pass and HTTP 422 on fail.  This method
        normalises both into a ``ComplianceGateResponse`` — check ``response.gate.passed``
        to determine the outcome.

        Args:
            text: The AI-generated text to analyse.
            provider: Optional AI provider override (e.g. ``'mock'``).
            project_name: Optional project name for the compliance report.

        Returns:
            A :class:`~faultline_sdk.models.ComplianceGateResponse`.

        Raises:
            FaultlineError: On non-2xx/422 responses.

        Example::

            response = client.compliance_gate("AI will cure cancer by 2025.", provider="mock")
            if not response.gate.passed:
                print(f"FAIL: {response.gate.non_compliant_count} non-compliant articles")
        """
        body: dict[str, Any] = {"text": text}
        if provider is not None:
            body["provider"] = provider
        if project_name is not None:
            body["projectName"] = project_name
        if threshold is not None:
            body["threshold"] = threshold
        if strict is not None:
            body["strict"] = strict
        try:
            data = self._request("POST", "/scan/compliance-gate", body)
        except FaultlineError as exc:
            # 422 is the expected "gate failed" response — parse it normally
            if exc.status_code == 422 and exc.body:
                return ComplianceGateResponse.from_dict(exc.body)
            raise
        return ComplianceGateResponse.from_dict(data)

    def get_scan_compliance(
        self,
        scan_id: str,
        project_name: str | None = None,
        threshold: int | None = None,
        strict: bool | None = None,
    ) -> ComplianceGateResponse:
        """Evaluate EU AI Act compliance for an existing scan result.

        Args:
            scan_id: ID of a previously stored scan.
            project_name: Optional project name for the compliance report.
            threshold: Minimum compliance score (0-100) to pass.
            strict: When True, all articles must be compliant or N/A.

        Returns:
            A :class:`~faultline_sdk.models.ComplianceGateResponse`.

        Raises:
            FaultlineError: On non-2xx/422 responses (including 404 for unknown scan IDs).
        """
        params: list[str] = []
        if project_name is not None:
            params.append(f"projectName={urllib.request.quote(project_name)}")
        if threshold is not None:
            params.append(f"threshold={threshold}")
        if strict is not None:
            params.append(f"strict={'true' if strict else 'false'}")
        path = f"/scan/{scan_id}/compliance"
        if params:
            path += "?" + "&".join(params)
        try:
            data = self._request("GET", path)
        except FaultlineError as exc:
            if exc.status_code == 422 and exc.body:
                return ComplianceGateResponse.from_dict(exc.body)
            raise
        return ComplianceGateResponse.from_dict(data)

    def compliance_diff(
        self,
        before_id: str,
        after_id: str,
        project_name: str | None = None,
    ) -> ComplianceDiffResult:
        """Compare EU AI Act compliance between two scans.

        Args:
            before_id: ID of the baseline scan.
            after_id: ID of the comparison scan.
            project_name: Optional project name for the reports.

        Returns:
            A :class:`~faultline_sdk.models.ComplianceDiffResult` with per-article trends.

        Raises:
            FaultlineError: On non-2xx responses (including 404 for unknown scan IDs).
        """
        body: dict[str, Any] = {"beforeId": before_id, "afterId": after_id}
        if project_name is not None:
            body["projectName"] = project_name
        return ComplianceDiffResult.from_dict(self._request("POST", "/scan/compliance-diff", body))

    def compliance_badge(self, scan_id: str, label: str | None = None) -> str:
        """Fetch SVG compliance badge for a scan result.

        Args:
            scan_id: ID of a previously stored scan.
            label: Optional custom label for the badge (default: 'EU AI Act').

        Returns:
            SVG string.
        """
        path = f"/scan/{scan_id}/compliance/badge"
        params: list[str] = []
        if label is not None:
            params.append(f"label={urllib.request.quote(label)}")
        if params:
            path += "?" + "&".join(params)
        return self._request("GET", path, raw=True)

    def compliance_history(
        self,
        project_name: str | None = None,
        limit: int | None = None,
        since: str | None = None,
    ) -> dict[str, Any]:
        """Query compliance gate evaluation history.

        Args:
            project_name: Filter by project name.
            limit: Maximum number of entries to return.
            since: ISO 8601 datetime to filter entries after.

        Returns:
            Dict with 'entries' list and 'count'.
        """
        params: list[str] = []
        if project_name is not None:
            params.append(f"projectName={urllib.request.quote(project_name)}")
        if limit is not None:
            params.append(f"limit={limit}")
        if since is not None:
            params.append(f"since={urllib.request.quote(since)}")
        path = "/compliance/history"
        if params:
            path += "?" + "&".join(params)
        return self._request("GET", path)

    def compliance_trend(self, project_name: str) -> dict[str, Any]:
        """Get compliance score trend for a project.

        Args:
            project_name: The project name to get trend for.

        Returns:
            Dict with 'current', 'previous', and 'direction' ('up'/'down'/'stable'/'none').
        """
        path = f"/compliance/trend?projectName={urllib.request.quote(project_name)}"
        return self._request("GET", path)

    def compliance_deadlines(self, days: int | None = None) -> list[ComplianceDeadline]:
        """List upcoming regulatory compliance deadlines.

        Args:
            days: Look-ahead window in days (default: 365).

        Returns:
            List of :class:`~faultline_sdk.models.ComplianceDeadline` objects.
        """
        path = "/compliance/deadlines"
        if days is not None:
            path += f"?days={days}"
        data = self._request("GET", path)
        return [ComplianceDeadline.from_dict(d) for d in data.get("deadlines", [])]

    # ── Claims ───────────────────────────────────────────────────────────────

    def claims_trending(self) -> dict[str, Any]:
        """Fetch trending claims, emerging patterns, and verdict changes.

        Returns:
            Dict with 'trending', 'emerging', and 'verdictChanged' lists.
        """
        return self._request("GET", "/claims/trending")

    # ── GDPR ─────────────────────────────────────────────────────────────────

    def gdpr_export(self, tenant_id: str) -> bytes:
        """Download a GDPR Article 15 data export ZIP for a tenant.

        Args:
            tenant_id: ID of the tenant to export.

        Returns:
            Raw ZIP bytes. Write to a file with mode ``'wb'``.

        Raises:
            FaultlineError: On non-2xx responses (including 404 for unknown tenants).
        """
        url = f"{self._base_url}/tenants/{tenant_id}/export"
        req = urllib.request.Request(
            url,
            method="GET",
            headers={
                "x-api-key": self._api_key,
                "Accept": "application/zip",
            },
        )
        try:
            resp = self._http_fn(req)
            return resp.read()
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                body_dict: dict[str, Any] = json.loads(raw)
            except Exception:
                body_dict = {"raw": raw.decode(errors="replace")}
            msg = body_dict.get("error", f"HTTP {exc.code}")
            raise FaultlineError(msg, status_code=exc.code, body=body_dict) from exc

    def gdpr_erase(self, tenant_id: str) -> GdprErasureResult:
        """Delete all data held for a tenant (GDPR Article 17 — Right to Erasure).

        Args:
            tenant_id: ID of the tenant whose data should be erased.

        Returns:
            A :class:`~faultline_sdk.models.GdprErasureResult` with per-category deletion counts.

        Raises:
            FaultlineError: On non-2xx responses (including 404 for unknown tenants).
        """
        data = self._request("DELETE", f"/tenants/{tenant_id}/data")
        return GdprErasureResult.from_dict(data)

    # ── Usage / Dashboard ─────────────────────────────────────────────────────

    def get_usage(self) -> UsageResponse:
        """Fetch usage statistics for the authenticated API key.

        Returns:
            A :class:`~faultline_sdk.models.UsageResponse` with scan and token counts.
        """
        data = self._request("GET", "/usage")
        return UsageResponse(key_id=data["keyId"], usage=data["usage"])

    def get_dashboard(self) -> DashboardResponse:
        """Fetch aggregate dashboard statistics.

        Returns:
            A :class:`~faultline_sdk.models.DashboardResponse` with scan volumes,
            risk distribution, and per-key usage breakdowns.
        """
        data = self._request("GET", "/dashboard")
        return DashboardResponse(
            scans=data["scans"],
            risk_distribution=data["riskDistribution"],
            key_usage=data["keyUsage"],
        )

    # ── Webhooks ──────────────────────────────────────────────────────────────

    def create_webhook(
        self,
        url: str,
        events: list[str],
        secret: str | None = None,
    ) -> Webhook:
        """Register a new webhook endpoint.

        Args:
            url: HTTPS URL that will receive POST payloads.
            events: List of event names to subscribe to (e.g. ``['scan.complete']``).
            secret: Optional HMAC secret for payload signature verification.

        Returns:
            The created :class:`~faultline_sdk.models.Webhook`, with ``secret`` field populated
            if one was provided or auto-generated.
        """
        body: dict[str, Any] = {"url": url, "events": events}
        if secret is not None:
            body["secret"] = secret
        data = self._request("POST", "/webhooks", body)
        return Webhook(
            id=data["id"],
            url=data["url"],
            events=data["events"],
            created_at=data["createdAt"],
            secret=data.get("secret"),
        )

    def list_webhooks(self) -> list[Webhook]:
        """List all registered webhooks.

        Returns:
            List of :class:`~faultline_sdk.models.Webhook` objects (``secret`` field omitted).
        """
        data = self._request("GET", "/webhooks")
        return [
            Webhook(
                id=d["id"],
                url=d["url"],
                events=d["events"],
                created_at=d["createdAt"],
            )
            for d in data
        ]

    def delete_webhook(self, webhook_id: str) -> None:
        """Delete a webhook by ID.

        Args:
            webhook_id: ID of the webhook to delete.
        """
        self._request("DELETE", f"/webhooks/{webhook_id}")
