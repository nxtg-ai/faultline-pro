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
    DashboardResponse,
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

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        """Execute an authenticated API request and return the parsed JSON body.

        Args:
            method: HTTP verb (e.g. 'GET', 'POST', 'DELETE').
            path: API path starting with '/' (e.g. '/scan').
            body: Optional JSON-serialisable request body.

        Returns:
            Parsed JSON response, or ``None`` for empty responses (e.g. DELETE).

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
            raw = resp.read()
            return json.loads(raw) if raw else None
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
