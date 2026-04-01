"""Faultline Python SDK.

Zero external dependencies — uses only the Python standard library.
Requires Python 3.10+.

Quickstart::

    import os
    from faultline_sdk import FaultlineClient, FaultlineError

    client = FaultlineClient(api_key=os.environ["FAULTLINE_API_KEY"])

    try:
        result = client.scan("The moon is made of green cheese.")
        print(result.overall_risk)         # 'high' | 'critical' | ...
        for claim in result.claims:
            print(claim.text, claim.importance)
    except FaultlineError as exc:
        print(f"API error {exc.status_code}: {exc}")
"""
from .client import FaultlineClient
from .exceptions import FaultlineError
from .models import (
    ApiKey,
    BatchScanError,
    BatchScanResponse,
    CiGateArticleResult,
    CiGateResult,
    Claim,
    ComplianceDeadline,
    ComplianceDiffResult,
    ComplianceExportResponse,
    ComplianceGateResponse,
    ComplianceHistoryEntry,
    ComplianceReport,
    DashboardResponse,
    GdprErasureResult,
    Permission,
    Provider,
    RiskLevel,
    ScanDiffResult,
    ScanResult,
    Source,
    UsageResponse,
    VerificationResult,
    Webhook,
)

__all__ = [
    "FaultlineClient",
    "FaultlineError",
    # models
    "ApiKey",
    "BatchScanError",
    "BatchScanResponse",
    "CiGateArticleResult",
    "CiGateResult",
    "Claim",
    "ComplianceDeadline",
    "ComplianceDiffResult",
    "ComplianceExportResponse",
    "ComplianceGateResponse",
    "ComplianceHistoryEntry",
    "ComplianceReport",
    "DashboardResponse",
    "GdprErasureResult",
    "Permission",
    "Provider",
    "RiskLevel",
    "ScanDiffResult",
    "ScanResult",
    "Source",
    "UsageResponse",
    "VerificationResult",
    "Webhook",
]
