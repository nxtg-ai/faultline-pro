"""Tests for model construction, especially from_dict factory methods."""
from __future__ import annotations

from faultline_sdk.models import (
    BatchScanResponse,
    Claim,
    ComplianceReport,
    ScanResult,
    Source,
    VerificationResult,
)

# ── Shared fixtures ───────────────────────────────────────────────────────────

SCAN_DICT = {
    "input": "The sun is a star.",
    "provider": "mock",
    "overallRisk": "low",
    "claims": [
        {"id": "c1", "text": "The sun is a star.", "type": "factual", "importance": 9}
    ],
    "verifications": {
        "c1": {
            "claimId": "c1",
            "status": "supported",
            "explanation": "Astrophysics textbook confirms.",
            "sources": [{"title": "NASA", "url": "https://nasa.gov"}],
        }
    },
    "complianceReport": {"riskTier": "low", "findings": []},
    "ruleFindings": [],
}


class TestScanResultFromDict:
    def test_from_dict_returns_scan_result_instance(self):
        """ScanResult.from_dict must return a ScanResult, not a raw dict."""
        result = ScanResult.from_dict(SCAN_DICT)
        assert isinstance(result, ScanResult)

    def test_from_dict_parses_claims_as_claim_objects(self):
        """Claims list must be populated with Claim dataclass instances."""
        result = ScanResult.from_dict(SCAN_DICT)

        assert len(result.claims) == 1
        claim = result.claims[0]
        assert isinstance(claim, Claim)
        assert claim.id == "c1"
        assert claim.text == "The sun is a star."
        assert claim.importance == 9

    def test_from_dict_parses_verifications_as_verification_result_objects(self):
        """Verifications dict values must be VerificationResult instances."""
        result = ScanResult.from_dict(SCAN_DICT)

        assert "c1" in result.verifications
        v = result.verifications["c1"]
        assert isinstance(v, VerificationResult)
        assert v.status == "supported"
        assert len(v.sources) == 1
        assert isinstance(v.sources[0], Source)
        assert v.sources[0].url == "https://nasa.gov"

    def test_from_dict_parses_compliance_report(self):
        """ComplianceReport must be populated with the correct risk_tier."""
        result = ScanResult.from_dict(SCAN_DICT)

        assert isinstance(result.compliance_report, ComplianceReport)
        assert result.compliance_report.risk_tier == "low"

    def test_from_dict_overall_risk_and_provider_mapped_correctly(self):
        """overall_risk and provider fields must map from camelCase JSON keys."""
        result = ScanResult.from_dict(SCAN_DICT)

        assert result.overall_risk == "low"
        assert result.provider == "mock"
        assert result.input == "The sun is a star."


class TestBatchScanResponseFromDict:
    def test_from_dict_returns_batch_scan_response_instance(self):
        """BatchScanResponse.from_dict must return a BatchScanResponse."""
        batch_dict = {
            "total": 1,
            "succeeded": 1,
            "failed": 0,
            "results": [SCAN_DICT],
            "errors": [],
        }
        result = BatchScanResponse.from_dict(batch_dict)
        assert isinstance(result, BatchScanResponse)

    def test_from_dict_none_result_items_are_preserved(self):
        """None entries in the results list (failed items) must stay None."""
        batch_dict = {
            "total": 2,
            "succeeded": 1,
            "failed": 1,
            "results": [SCAN_DICT, None],
            "errors": [{"index": 1, "error": "provider timeout"}],
        }
        result = BatchScanResponse.from_dict(batch_dict)

        assert result.total == 2
        assert result.failed == 1
        assert isinstance(result.results[0], ScanResult)
        assert result.results[1] is None
        assert len(result.errors) == 1
        assert result.errors[0].index == 1
        assert result.errors[0].error == "provider timeout"
