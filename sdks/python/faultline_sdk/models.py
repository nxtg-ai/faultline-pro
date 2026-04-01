"""Faultline SDK data models.

All models are plain dataclasses with no external dependencies.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Semantic type aliases — kept as str for simplicity; narrowed by the API contract.
Permission = str  # 'scan' | 'report' | 'upload' | 'admin' | 'pro'
Provider = str    # 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock'
RiskLevel = str   # 'low' | 'medium' | 'high' | 'critical'


@dataclass
class ApiKey:
    """An API key returned by the /keys endpoint.

    Attributes:
        id: Unique key identifier.
        name: Human-readable name for the key.
        permissions: List of permission strings granted to this key.
        created_at: ISO-8601 creation timestamp.
        key: Raw key secret — only present in creation responses.
    """

    id: str
    name: str
    permissions: list[str]
    created_at: str
    key: str | None = None


@dataclass
class Source:
    """A web source cited during claim verification.

    Attributes:
        title: Page title or descriptor.
        url: Source URL.
    """

    title: str
    url: str


@dataclass
class VerificationResult:
    """Result of verifying a single claim against live web data.

    Attributes:
        claim_id: ID of the claim this result belongs to.
        status: Verdict — one of 'supported', 'contradicted', 'unverified', 'mixed', 'skipped'.
        explanation: Human-readable explanation of the verdict.
        sources: Web sources consulted during verification.
    """

    claim_id: str
    status: str
    explanation: str
    sources: list[Source] = field(default_factory=list)


@dataclass
class Claim:
    """An atomic claim extracted from input text.

    Attributes:
        id: Unique claim identifier.
        text: The extracted claim text.
        type: Claim category (e.g. 'factual', 'statistical', 'causal').
        importance: Priority score (1–10) indicating verification priority.
    """

    id: str
    text: str
    type: str
    importance: int


@dataclass
class ComplianceReport:
    """Compliance tier and findings for a scan.

    Attributes:
        risk_tier: Overall risk tier — one of 'low', 'medium', 'high', 'critical'.
        findings: List of structured finding dicts (rule violations, flags, etc.).
    """

    risk_tier: str
    findings: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ScanResult:
    """Full result of a single /scan request.

    Attributes:
        input: Original text that was scanned.
        provider: AI provider used for extraction and verification.
        overall_risk: Aggregate risk level — 'low', 'medium', 'high', or 'critical'.
        claims: Atomic claims extracted from the input.
        verifications: Map of claim ID -> VerificationResult.
        compliance_report: Compliance tier and detailed findings.
        rule_findings: Additional rule-engine findings (defaults to empty list).
    """

    input: str
    provider: str
    overall_risk: str
    claims: list[Claim]
    verifications: dict[str, VerificationResult]
    compliance_report: ComplianceReport
    rule_findings: list[dict[str, Any]] = field(default_factory=list)
    compliance_score: float | None = None
    compliance_pass: bool | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScanResult:
        """Construct a ScanResult from a raw API response dictionary.

        Args:
            data: Parsed JSON response from the /scan endpoint.

        Returns:
            A fully-populated ScanResult instance.
        """
        claims = [
            Claim(
                id=c["id"],
                text=c["text"],
                type=c["type"],
                importance=c["importance"],
            )
            for c in data.get("claims", [])
        ]

        raw_verifications: dict[str, Any] = data.get("verifications", {})
        verifications: dict[str, VerificationResult] = {}
        for claim_id, v in raw_verifications.items():
            sources = [
                Source(title=s.get("title", ""), url=s.get("url", ""))
                for s in v.get("sources", [])
            ]
            verifications[claim_id] = VerificationResult(
                claim_id=v.get("claimId", claim_id),
                status=v.get("status", "unverified"),
                explanation=v.get("explanation", ""),
                sources=sources,
            )

        raw_compliance: dict[str, Any] = data.get("complianceReport", {})
        compliance_report = ComplianceReport(
            risk_tier=raw_compliance.get("riskTier", "low"),
            findings=raw_compliance.get("findings", []),
        )

        return cls(
            input=data.get("input", ""),
            provider=data.get("provider", ""),
            overall_risk=data.get("overallRisk", "low"),
            claims=claims,
            verifications=verifications,
            compliance_report=compliance_report,
            rule_findings=data.get("ruleFindings", []),
            compliance_score=data.get("complianceScore"),
            compliance_pass=data.get("compliancePass"),
        )


@dataclass
class BatchScanError:
    """Represents a failure for one item in a batch scan request.

    Attributes:
        index: Zero-based index of the item that failed.
        error: Human-readable error message.
    """

    index: int
    error: str


@dataclass
class BatchScanResponse:
    """Result of a /scan/batch request.

    Attributes:
        total: Total number of texts submitted.
        succeeded: Number of texts successfully scanned.
        failed: Number of texts that failed.
        results: Per-item ScanResult (None where the item failed).
        errors: Per-failure BatchScanError records.
    """

    total: int
    succeeded: int
    failed: int
    results: list[ScanResult | None]
    errors: list[BatchScanError]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BatchScanResponse:
        """Construct a BatchScanResponse from a raw API response dictionary.

        Args:
            data: Parsed JSON response from the /scan/batch endpoint.

        Returns:
            A fully-populated BatchScanResponse instance.
        """
        raw_results: list[Any] = data.get("results", [])
        results: list[ScanResult | None] = [
            ScanResult.from_dict(r) if r is not None else None
            for r in raw_results
        ]

        errors = [
            BatchScanError(index=e["index"], error=e["error"])
            for e in data.get("errors", [])
        ]

        return cls(
            total=data.get("total", len(raw_results)),
            succeeded=data.get("succeeded", 0),
            failed=data.get("failed", 0),
            results=results,
            errors=errors,
        )


@dataclass
class CiGateArticleResult:
    """Per-article pass/fail result from the compliance gate.

    Attributes:
        article: EU AI Act article name.
        status: Compliance status (compliant, non-compliant, partial, gap, not-applicable).
        passed: Whether this article passed the gate.
    """

    article: str
    status: str
    passed: bool


@dataclass
class CiGateResult:
    """Result of evaluating the EU AI Act compliance gate.

    Attributes:
        passed: Whether the gate passed overall.
        overall_risk: Risk level of the scan.
        articles: Per-article pass/fail results.
        non_compliant_count: Number of non-compliant articles.
        total_articles: Total number of articles evaluated.
        exit_code: 0 for pass, 1 for fail.
    """

    passed: bool
    overall_risk: str
    articles: list[CiGateArticleResult]
    non_compliant_count: int
    total_articles: int
    exit_code: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CiGateResult:
        articles = [
            CiGateArticleResult(
                article=a["article"],
                status=a["status"],
                passed=a["pass"],
            )
            for a in data.get("articles", [])
        ]
        return cls(
            passed=data.get("pass", False),
            overall_risk=data.get("overallRisk", ""),
            articles=articles,
            non_compliant_count=data.get("nonCompliantCount", 0),
            total_articles=data.get("totalArticles", 0),
            exit_code=data.get("exitCode", 1),
        )


@dataclass
class ComplianceGateResponse:
    """Response from POST /scan/compliance-gate.

    Attributes:
        gate: The pass/fail gate result.
        report: Raw compliance report dict (full EU AI Act evidence).
        scan_id: ID of the stored scan.
    """

    gate: CiGateResult
    report: dict[str, Any]
    scan_id: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ComplianceGateResponse:
        return cls(
            gate=CiGateResult.from_dict(data.get("gate", {})),
            report=data.get("report", {}),
            scan_id=data.get("scanId", ""),
        )


@dataclass
class ComplianceDiffResult:
    """Result from POST /scan/compliance-diff.

    Attributes:
        articles: Per-article diff entries.
        summary: Summary counts of improved/regressed/unchanged.
        risk_trend: Overall risk trend direction.
    """

    articles: list[dict[str, Any]]
    summary: dict[str, int]
    risk_trend: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ComplianceDiffResult:
        return cls(
            articles=data.get("articles", []),
            summary=data.get("summary", {}),
            risk_trend=data.get("riskTrend", "unchanged"),
        )


@dataclass
class ScanDiffResult:
    """Result from POST /scan/diff — compares two texts at the claim level.

    Attributes:
        before: Full scan result for the 'before' text.
        after: Full scan result for the 'after' text.
        new_claims: Claims present in 'after' but not 'before'.
        removed_claims: Claims present in 'before' but not 'after'.
        changed_verdicts: Claims whose verification verdict changed.
        trust_score_delta: Numeric risk-score change (negative = improved).
        summary: Human-readable summary ('Risk improved' / 'Risk worsened' / 'No change').
        inline_diff: Per-claim inline diff entries with type (added/removed/changed/unchanged).
    """

    before: dict[str, Any]
    after: dict[str, Any]
    new_claims: list[dict[str, Any]]
    removed_claims: list[dict[str, Any]]
    changed_verdicts: list[dict[str, Any]]
    trust_score_delta: int
    summary: str
    inline_diff: list[dict[str, Any]]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScanDiffResult:
        return cls(
            before=data.get("before", {}),
            after=data.get("after", {}),
            new_claims=data.get("newClaims", []),
            removed_claims=data.get("removedClaims", []),
            changed_verdicts=data.get("changedVerdicts", []),
            trust_score_delta=data.get("trustScoreDelta", 0),
            summary=data.get("summary", ""),
            inline_diff=data.get("inlineDiff", []),
        )


@dataclass
class ComplianceDeadline:
    """A regulatory deadline from GET /compliance/deadlines.

    Attributes:
        id: Unique deadline identifier.
        name: Deadline name.
        regulation: Regulation name (e.g. 'EU AI Act', 'GDPR').
        description: Human-readable description.
        deadline: ISO-8601 date string.
        days_until: Days remaining until the deadline.
        severity: Severity level ('critical', 'high', 'medium', 'low').
        url: Reference URL for the regulation.
    """

    id: str
    name: str
    regulation: str
    description: str
    deadline: str
    days_until: int
    severity: str
    url: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ComplianceDeadline:
        return cls(
            id=data.get("id", ""),
            name=data.get("name", ""),
            regulation=data.get("regulation", ""),
            description=data.get("description", ""),
            deadline=data.get("deadline", ""),
            days_until=data.get("daysUntil", 0),
            severity=data.get("severity", ""),
            url=data.get("url", ""),
        )


@dataclass
class ComplianceHistoryEntry:
    """A compliance history entry from GET /compliance/export.

    Attributes:
        id: Unique entry identifier.
        project_name: Project name at evaluation time.
        scan_id: Scan ID that was evaluated.
        compliance_score: Compliance score (0–100).
        passed: Whether the gate passed.
        overall_risk: Risk level at evaluation time.
        non_compliant_count: Number of non-compliant articles.
        total_articles: Total articles evaluated.
        threshold: Threshold used for the gate.
        recorded_at: ISO-8601 timestamp of the evaluation.
    """

    id: str
    project_name: str
    scan_id: str
    compliance_score: float
    passed: bool
    overall_risk: str
    non_compliant_count: int
    total_articles: int
    threshold: float
    recorded_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ComplianceHistoryEntry:
        return cls(
            id=data.get("id", ""),
            project_name=data.get("projectName", ""),
            scan_id=data.get("scanId", ""),
            compliance_score=data.get("complianceScore", 0),
            passed=data.get("pass", False),
            overall_risk=data.get("overallRisk", ""),
            non_compliant_count=data.get("nonCompliantCount", 0),
            total_articles=data.get("totalArticles", 0),
            threshold=data.get("threshold", 0),
            recorded_at=data.get("recordedAt", ""),
        )


@dataclass
class ComplianceExportResponse:
    """Response from GET /compliance/export (JSON format).

    Attributes:
        entries: List of compliance history entries.
        count: Number of entries in this export.
        exported_at: ISO-8601 timestamp of the export.
    """

    entries: list[ComplianceHistoryEntry]
    count: int
    exported_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ComplianceExportResponse:
        entries = [ComplianceHistoryEntry.from_dict(e) for e in data.get("entries", [])]
        return cls(
            entries=entries,
            count=data.get("count", 0),
            exported_at=data.get("exportedAt", ""),
        )


@dataclass
class GdprErasureResult:
    """Result from DELETE /tenants/:id/data — GDPR Article 17 erasure.

    Attributes:
        tenant_id: ID of the erased tenant.
        deleted: Per-category deletion counts.
    """

    tenant_id: str
    deleted: dict[str, int]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> GdprErasureResult:
        return cls(
            tenant_id=data.get("tenantId", ""),
            deleted=data.get("deleted", {}),
        )


@dataclass
class Webhook:
    """A registered webhook endpoint.

    Attributes:
        id: Unique webhook identifier.
        url: Destination URL for event delivery.
        events: List of event names this webhook subscribes to.
        created_at: ISO-8601 creation timestamp.
        secret: HMAC signing secret — only present in creation responses.
    """

    id: str
    url: str
    events: list[str]
    created_at: str
    secret: str | None = None


@dataclass
class UsageResponse:
    """API key usage statistics.

    Attributes:
        key_id: ID of the key whose usage is reported.
        usage: Map of metric name to count (e.g. {'scans': 42, 'tokens': 18000}).
    """

    key_id: str
    usage: dict[str, int]


@dataclass
class DashboardResponse:
    """Aggregate dashboard statistics.

    Attributes:
        scans: Scan counts keyed by window — 'today', 'week', 'month'.
        risk_distribution: Count of scans per risk level.
        key_usage: Per-key usage breakdown list.
    """

    scans: dict[str, int]
    risk_distribution: dict[str, int]
    key_usage: list[dict[str, Any]]
