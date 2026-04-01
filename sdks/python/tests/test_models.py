"""Tests for model construction, especially from_dict factory methods."""
from __future__ import annotations

from faultline_sdk.models import (
    BatchScanResponse,
    CiGateResult,
    Claim,
    ComplianceDeadline,
    ComplianceDiffResult,
    ComplianceExportResponse,
    ComplianceGateResponse,
    ComplianceHistoryEntry,
    ComplianceReport,
    GdprErasureResult,
    ScanDiffResult,
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


class TestScanDiffResultFromDict:
    def test_from_dict_returns_instance(self):
        data = {
            "before": {"overallRisk": "high"},
            "after": {"overallRisk": "low"},
            "newClaims": [{"id": "c1"}],
            "removedClaims": [],
            "changedVerdicts": [{"claim": {"id": "c2"}, "before": "refuted", "after": "supported"}],
            "trustScoreDelta": -2,
            "summary": "Risk improved",
            "inlineDiff": [{"type": "added", "claim": "New"}],
        }
        result = ScanDiffResult.from_dict(data)
        assert isinstance(result, ScanDiffResult)
        assert result.trust_score_delta == -2
        assert result.summary == "Risk improved"
        assert len(result.new_claims) == 1
        assert len(result.inline_diff) == 1

    def test_from_dict_defaults_on_empty(self):
        result = ScanDiffResult.from_dict({})
        assert result.trust_score_delta == 0
        assert result.summary == ""
        assert result.new_claims == []


class TestComplianceDeadlineFromDict:
    def test_from_dict_returns_instance(self):
        data = {
            "id": "eu-ai-act-art50",
            "name": "Article 50",
            "regulation": "EU AI Act",
            "description": "Transparency",
            "deadline": "2026-08-02",
            "daysUntil": 124,
            "severity": "critical",
            "url": "https://example.com",
        }
        result = ComplianceDeadline.from_dict(data)
        assert isinstance(result, ComplianceDeadline)
        assert result.days_until == 124
        assert result.severity == "critical"
        assert result.regulation == "EU AI Act"

    def test_from_dict_defaults_on_empty(self):
        result = ComplianceDeadline.from_dict({})
        assert result.id == ""
        assert result.days_until == 0


class TestComplianceDiffResultFromDict:
    def test_from_dict_returns_instance(self):
        data = {
            "articles": [{"article": "Article 9", "trend": "improved"}],
            "summary": {"improved": 1, "regressed": 0},
            "riskTrend": "improved",
        }
        result = ComplianceDiffResult.from_dict(data)
        assert isinstance(result, ComplianceDiffResult)
        assert result.risk_trend == "improved"
        assert len(result.articles) == 1
        assert result.summary["improved"] == 1

    def test_from_dict_defaults_on_empty(self):
        result = ComplianceDiffResult.from_dict({})
        assert result.risk_trend == "unchanged"
        assert result.articles == []


class TestGdprErasureResultFromDict:
    def test_from_dict_returns_instance(self):
        data = {
            "tenantId": "tenant-abc",
            "deleted": {"scanEntries": 15, "auditEntries": 42},
        }
        result = GdprErasureResult.from_dict(data)
        assert isinstance(result, GdprErasureResult)
        assert result.tenant_id == "tenant-abc"
        assert result.deleted["scanEntries"] == 15

    def test_from_dict_defaults_on_empty(self):
        result = GdprErasureResult.from_dict({})
        assert result.tenant_id == ""
        assert result.deleted == {}


class TestCiGateResultFromDict:
    def test_from_dict_returns_instance(self):
        data = {
            "pass": True,
            "overallRisk": "low",
            "articles": [{"article": "Art 9", "status": "compliant", "pass": True}],
            "nonCompliantCount": 0,
            "totalArticles": 1,
            "exitCode": 0,
        }
        result = CiGateResult.from_dict(data)
        assert isinstance(result, CiGateResult)
        assert result.passed is True
        assert result.exit_code == 0
        assert len(result.articles) == 1
        assert result.articles[0].passed is True

    def test_from_dict_defaults_on_empty(self):
        result = CiGateResult.from_dict({})
        assert result.passed is False
        assert result.exit_code == 1
        assert result.articles == []


class TestComplianceGateResponseFromDict:
    def test_from_dict_returns_instance(self):
        data = {
            "gate": {"pass": False, "overallRisk": "high", "articles": [], "nonCompliantCount": 2, "totalArticles": 5, "exitCode": 1},
            "report": {"articleEvidence": []},
            "scanId": "scan-123",
        }
        result = ComplianceGateResponse.from_dict(data)
        assert isinstance(result, ComplianceGateResponse)
        assert result.gate.passed is False
        assert result.scan_id == "scan-123"


class TestScanResultInlineCompliance:
    def test_from_dict_parses_compliance_score(self):
        """ScanResult.from_dict must parse inline complianceScore/compliancePass."""
        data = {**SCAN_DICT, "complianceScore": 85.5, "compliancePass": True}
        result = ScanResult.from_dict(data)
        assert result.compliance_score == 85.5
        assert result.compliance_pass is True

    def test_from_dict_compliance_fields_default_none(self):
        """Inline compliance fields default to None when absent."""
        result = ScanResult.from_dict(SCAN_DICT)
        assert result.compliance_score is None
        assert result.compliance_pass is None


class TestComplianceHistoryEntryFromDict:
    def test_from_dict_returns_instance(self):
        data = {
            "id": "ch-1",
            "projectName": "my-project",
            "scanId": "scan-abc",
            "complianceScore": 92.5,
            "pass": True,
            "overallRisk": "low",
            "nonCompliantCount": 0,
            "totalArticles": 8,
            "threshold": 70,
            "recordedAt": "2026-03-30T12:00:00Z",
        }
        entry = ComplianceHistoryEntry.from_dict(data)
        assert isinstance(entry, ComplianceHistoryEntry)
        assert entry.id == "ch-1"
        assert entry.project_name == "my-project"
        assert entry.compliance_score == 92.5
        assert entry.passed is True
        assert entry.total_articles == 8
        assert entry.threshold == 70

    def test_from_dict_defaults_on_empty(self):
        entry = ComplianceHistoryEntry.from_dict({})
        assert entry.id == ""
        assert entry.passed is False
        assert entry.compliance_score == 0
        assert entry.threshold == 0


class TestComplianceExportResponseFromDict:
    def test_from_dict_returns_instance(self):
        data = {
            "entries": [
                {
                    "id": "ch-1",
                    "projectName": "proj",
                    "scanId": "s1",
                    "complianceScore": 80,
                    "pass": True,
                    "overallRisk": "low",
                    "nonCompliantCount": 0,
                    "totalArticles": 8,
                    "threshold": 70,
                    "recordedAt": "2026-03-30T12:00:00Z",
                },
            ],
            "count": 1,
            "exportedAt": "2026-03-31T00:00:00Z",
        }
        resp = ComplianceExportResponse.from_dict(data)
        assert isinstance(resp, ComplianceExportResponse)
        assert resp.count == 1
        assert len(resp.entries) == 1
        assert isinstance(resp.entries[0], ComplianceHistoryEntry)
        assert resp.entries[0].project_name == "proj"
        assert resp.exported_at == "2026-03-31T00:00:00Z"

    def test_from_dict_defaults_on_empty(self):
        resp = ComplianceExportResponse.from_dict({})
        assert resp.count == 0
        assert resp.entries == []
        assert resp.exported_at == ""
