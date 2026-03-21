/**
 * PDF Report Generator for Faultline Pro scan results.
 *
 * Produces a multi-section PDF using PDFKit:
 *   1. Cover page — branding, document title, risk badge, metadata
 *   2. Executive summary — key stats, overall risk, top concerns
 *   3. Risk heatmap — visual grid of claims by risk contribution
 *   4. Claim-by-claim analysis — each claim, its status, sources, explanation
 *   5. Recommendations — tailored to the overall risk level
 *
 * Returns a Buffer so the route can stream it as application/pdf.
 */

import PDFDocument from 'pdfkit';

// ── Types (mirrors ScanResult from @nxtg/faultline) ──────────────────────────

export interface PdfClaim {
  id:         string;
  text:       string;
  type:       string;
  importance: number;
}

export interface PdfVerification {
  claimId:     string;
  status:      string;
  explanation: string;
  sources:     Array<{ title: string; uri: string }>;
}

export interface PdfScanResult {
  input:         string;
  provider:      string;
  claims:        PdfClaim[];
  verifications: Record<string, PdfVerification>;
  overallRisk:   string;
  scannedAt?:    string;
}

// ── Colour palette ────────────────────────────────────────────────────────────

const COLORS = {
  bg:          '#0D1117',
  surface:     '#161B22',
  border:      '#30363D',
  text:        '#E6EDF3',
  muted:       '#7D8590',
  blue:        '#58A6FF',
  red:         '#F85149',
  orange:      '#D29922',
  green:       '#3FB950',
  purple:      '#D2A8FF',
  white:       '#FFFFFF',
  pageGutter:  60,
  pageWidth:   595 - 120, // A4 width minus gutters
};

function riskColor(risk: string): string {
  switch (risk?.toLowerCase()) {
    case 'critical': return '#FF6B6B';
    case 'high':     return COLORS.red;
    case 'medium':   return COLORS.orange;
    case 'low':      return COLORS.green;
    default:         return COLORS.muted;
  }
}

function statusColor(status: string): string {
  switch (status?.toLowerCase()) {
    case 'supported':    return COLORS.green;
    case 'contradicted': return COLORS.red;
    case 'mixed':        return COLORS.orange;
    case 'skipped':      return COLORS.muted;
    default:             return COLORS.blue;
  }
}

function statusLabel(status: string): string {
  return (status ?? 'unverified').toUpperCase();
}

function importanceStars(n: number): string {
  return '★'.repeat(Math.min(5, Math.max(1, n))) + '☆'.repeat(5 - Math.min(5, n));
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function generatePdfReport(scan: PdfScanResult): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: COLORS.pageGutter, compress: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const claims = scan.claims ?? [];
    const verifications = scan.verifications ?? {};
    const overallRisk = scan.overallRisk ?? 'unknown';
    const scannedAt = scan.scannedAt ? new Date(scan.scannedAt) : new Date();

    // ── Page 1: Cover ─────────────────────────────────────────────────────────
    drawCover(doc, scan, claims, overallRisk, scannedAt);

    // ── Page 2: Executive Summary ─────────────────────────────────────────────
    doc.addPage();
    drawSection(doc, 'Executive Summary');
    drawExecutiveSummary(doc, scan, claims, verifications, overallRisk);

    // ── Page 3+: Risk Heatmap ─────────────────────────────────────────────────
    doc.addPage();
    drawSection(doc, 'Risk Heatmap');
    drawHeatmap(doc, claims, verifications);

    // ── Page N+: Claim Analysis ───────────────────────────────────────────────
    doc.addPage();
    drawSection(doc, 'Claim-by-Claim Analysis');
    drawClaimAnalysis(doc, claims, verifications);

    // ── Final page: Recommendations ───────────────────────────────────────────
    doc.addPage();
    drawSection(doc, 'Recommendations');
    drawRecommendations(doc, overallRisk, claims, verifications);

    // ── Footer on all pages ───────────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      drawFooter(doc, i + 1, range.count);
    }

    doc.end();
  });
}

// ── Section helpers ───────────────────────────────────────────────────────────

function drawFooter(doc: PDFKit.PDFDocument, page: number, total: number): void {
  const y = doc.page.height - 40;
  doc.save()
    .fontSize(8)
    .fillColor(COLORS.muted)
    .text('Faultline Pro — Confidential Scan Report', COLORS.pageGutter, y, { align: 'left' })
    .text(`Page ${page} of ${total}`, COLORS.pageGutter, y, {
      align: 'right',
      width: doc.page.width - COLORS.pageGutter * 2,
    })
    .restore();
}

function drawSection(doc: PDFKit.PDFDocument, title: string): void {
  doc.save()
    .fontSize(14)
    .font('Helvetica-Bold')
    .fillColor(COLORS.blue)
    .text(title, COLORS.pageGutter, COLORS.pageGutter)
    .moveDown(0.3)
    .strokeColor(COLORS.border)
    .lineWidth(0.5)
    .moveTo(COLORS.pageGutter, doc.y)
    .lineTo(doc.page.width - COLORS.pageGutter, doc.y)
    .stroke()
    .restore();
  doc.moveDown(0.8);
}

// ── Cover page ────────────────────────────────────────────────────────────────

function drawCover(
  doc: PDFKit.PDFDocument,
  scan: PdfScanResult,
  claims: PdfClaim[],
  overallRisk: string,
  scannedAt: Date,
): void {
  const midX = doc.page.width / 2;
  const rCol = riskColor(overallRisk);

  // Brand wordmark
  doc.save()
    .fontSize(28)
    .font('Helvetica-Bold')
    .fillColor(COLORS.red)
    .text('fault', COLORS.pageGutter, 80, { continued: true })
    .fillColor(COLORS.text)
    .text('line', { continued: true })
    .fillColor(COLORS.muted)
    .text(' pro')
    .restore();

  // Divider
  doc.save()
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .moveTo(COLORS.pageGutter, 130)
    .lineTo(doc.page.width - COLORS.pageGutter, 130)
    .stroke()
    .restore();

  // Report title
  doc.save()
    .fontSize(22)
    .font('Helvetica-Bold')
    .fillColor(COLORS.text)
    .text('Scan Report', COLORS.pageGutter, 160)
    .restore();

  // Risk badge
  const badgeX = COLORS.pageGutter;
  const badgeY = 200;
  doc.save()
    .roundedRect(badgeX, badgeY, 140, 36, 4)
    .fillAndStroke(rCol + '22', rCol)
    .fontSize(14)
    .font('Helvetica-Bold')
    .fillColor(rCol)
    .text(`${overallRisk.toUpperCase()} RISK`, badgeX + 8, badgeY + 10)
    .restore();

  // Metadata block
  const metaY = 260;
  const metaItems = [
    ['Provider',   scan.provider ?? 'gemini'],
    ['Claims',     String(claims.length)],
    ['Scanned At', scannedAt.toUTCString()],
  ];
  doc.save().fontSize(11);
  metaItems.forEach(([label, value], i) => {
    doc.fillColor(COLORS.muted)
      .font('Helvetica-Bold')
      .text(`${label}:`, COLORS.pageGutter, metaY + i * 22, { continued: true })
      .font('Helvetica')
      .fillColor(COLORS.text)
      .text(` ${value}`);
  });
  doc.restore();

  // Input preview
  const previewY = metaY + metaItems.length * 22 + 20;
  doc.save()
    .fontSize(10)
    .font('Helvetica-Bold')
    .fillColor(COLORS.muted)
    .text('Input Preview', COLORS.pageGutter, previewY)
    .moveDown(0.3)
    .font('Helvetica')
    .fillColor(COLORS.text)
    .text((scan.input ?? '').slice(0, 400) + ((scan.input?.length ?? 0) > 400 ? '…' : ''), {
      width: COLORS.pageWidth,
      lineGap: 2,
    })
    .restore();
}

// ── Executive summary ─────────────────────────────────────────────────────────

function drawExecutiveSummary(
  doc: PDFKit.PDFDocument,
  _scan: PdfScanResult,
  claims: PdfClaim[],
  verifications: Record<string, PdfVerification>,
  overallRisk: string,
): void {
  const vValues = Object.values(verifications);
  const supported    = vValues.filter(v => v.status === 'supported').length;
  const contradicted = vValues.filter(v => v.status === 'contradicted').length;
  const mixed        = vValues.filter(v => v.status === 'mixed').length;
  const unverified   = vValues.filter(v => v.status === 'unverified' || v.status === 'skipped').length;

  const stats = [
    { label: 'Total Claims',    value: String(claims.length),    color: COLORS.text },
    { label: 'Supported',       value: String(supported),         color: COLORS.green },
    { label: 'Contradicted',    value: String(contradicted),      color: COLORS.red },
    { label: 'Mixed',           value: String(mixed),             color: COLORS.orange },
    { label: 'Unverified',      value: String(unverified),        color: COLORS.muted },
  ];

  // Stat cards (row of 5)
  const cardW = Math.floor(COLORS.pageWidth / stats.length) - 8;
  const cardH = 60;
  const startY = doc.y;
  stats.forEach((stat, i) => {
    const x = COLORS.pageGutter + i * (cardW + 8);
    doc.save()
      .rect(x, startY, cardW, cardH)
      .lineWidth(0.5)
      .strokeColor(COLORS.border)
      .stroke()
      .fontSize(22)
      .font('Helvetica-Bold')
      .fillColor(stat.color)
      .text(stat.value, x + 6, startY + 8, { width: cardW - 12, align: 'center' })
      .fontSize(8)
      .font('Helvetica')
      .fillColor(COLORS.muted)
      .text(stat.label.toUpperCase(), x + 6, startY + 38, { width: cardW - 12, align: 'center' })
      .restore();
  });
  doc.y = startY + cardH + 20;

  // Overall risk sentence
  const rCol = riskColor(overallRisk);
  doc.save()
    .fontSize(11)
    .font('Helvetica')
    .fillColor(COLORS.text)
    .text('Overall risk assessment: ', COLORS.pageGutter, doc.y, { continued: true })
    .font('Helvetica-Bold')
    .fillColor(rCol)
    .text(overallRisk.toUpperCase() + '.', { continued: false })
    .restore();
  doc.moveDown(0.8);

  // Top concerns (claims with highest importance that are contradicted or mixed)
  const concerns = claims
    .filter(c => {
      const v = verifications[c.id];
      return v && (v.status === 'contradicted' || v.status === 'mixed');
    })
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 3);

  if (concerns.length > 0) {
    doc.save()
      .fontSize(11)
      .font('Helvetica-Bold')
      .fillColor(COLORS.text)
      .text('Top Concerns', COLORS.pageGutter, doc.y)
      .restore();
    doc.moveDown(0.4);
    concerns.forEach((claim, i) => {
      const v = verifications[claim.id];
      doc.save()
        .fontSize(10)
        .font('Helvetica-Bold')
        .fillColor(statusColor(v.status))
        .text(`${i + 1}. [${statusLabel(v.status)}]  `, COLORS.pageGutter + 10, doc.y, { continued: true })
        .font('Helvetica')
        .fillColor(COLORS.text)
        .text(claim.text.slice(0, 160) + (claim.text.length > 160 ? '…' : ''), {
          width: COLORS.pageWidth - 20,
          continued: false,
        })
        .restore();
      doc.moveDown(0.3);
    });
  }
}

// ── Risk heatmap ──────────────────────────────────────────────────────────────

function drawHeatmap(
  doc: PDFKit.PDFDocument,
  claims: PdfClaim[],
  verifications: Record<string, PdfVerification>,
): void {
  const cols = 5;
  const cellW = Math.floor(COLORS.pageWidth / cols) - 4;
  const cellH = 70;
  const startY = doc.y;

  claims.slice(0, 25).forEach((claim, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = COLORS.pageGutter + col * (cellW + 4);
    const y = startY + row * (cellH + 6);
    const v = verifications[claim.id];
    const status = v?.status ?? 'unverified';
    const bg = statusColor(status) + '22';
    const border = statusColor(status);

    doc.save()
      .rect(x, y, cellW, cellH)
      .fillAndStroke(bg, border)
      .fontSize(7)
      .font('Helvetica-Bold')
      .fillColor(border)
      .text(statusLabel(status), x + 4, y + 4, { width: cellW - 8 })
      .font('Helvetica')
      .fillColor(COLORS.text)
      .text(claim.text.slice(0, 80), x + 4, y + 16, {
        width: cellW - 8,
        height: cellH - 24,
        ellipsis: true,
        lineGap: 1,
      })
      .fontSize(7)
      .fillColor(COLORS.muted)
      .text(`#${i + 1}  ${importanceStars(claim.importance)}`, x + 4, y + cellH - 14, { width: cellW - 8 })
      .restore();
  });

  if (claims.length > 25) {
    doc.moveDown((Math.ceil(Math.min(claims.length, 25) / cols)) * (cellH + 6) / 12 + 1);
    doc.save()
      .fontSize(9)
      .fillColor(COLORS.muted)
      .text(`+ ${claims.length - 25} more claims not shown in heatmap.`, COLORS.pageGutter, doc.y)
      .restore();
  }
}

// ── Claim-by-claim analysis ───────────────────────────────────────────────────

function drawClaimAnalysis(
  doc: PDFKit.PDFDocument,
  claims: PdfClaim[],
  verifications: Record<string, PdfVerification>,
): void {
  claims.forEach((claim, i) => {
    const v = verifications[claim.id];
    const status = v?.status ?? 'unverified';
    const col = statusColor(status);

    // Check if we need a new page
    if (doc.y > doc.page.height - 160) {
      doc.addPage();
    }

    // Claim header bar
    const barY = doc.y;
    doc.save()
      .rect(COLORS.pageGutter, barY, COLORS.pageWidth, 22)
      .fill(col + '33')
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor(col)
      .text(`Claim ${i + 1} · ${statusLabel(status)}`, COLORS.pageGutter + 6, barY + 6, { continued: true })
      .font('Helvetica')
      .fillColor(COLORS.muted)
      .text(`  ${claim.type.toUpperCase()}  ${importanceStars(claim.importance)}`, { continued: false })
      .restore();
    doc.y = barY + 26;

    // Claim text
    doc.save()
      .fontSize(10)
      .font('Helvetica')
      .fillColor(COLORS.text)
      .text(claim.text, COLORS.pageGutter + 10, doc.y, { width: COLORS.pageWidth - 10 })
      .restore();
    doc.moveDown(0.4);

    if (v) {
      // Explanation
      doc.save()
        .fontSize(9)
        .font('Helvetica-Bold')
        .fillColor(COLORS.muted)
        .text('Explanation: ', COLORS.pageGutter + 10, doc.y, { continued: true })
        .font('Helvetica')
        .fillColor(COLORS.text)
        .text(v.explanation ?? '', { width: COLORS.pageWidth - 20 })
        .restore();
      doc.moveDown(0.3);

      // Sources
      if (v.sources?.length > 0) {
        doc.save()
          .fontSize(8)
          .font('Helvetica-Bold')
          .fillColor(COLORS.muted)
          .text('Sources:', COLORS.pageGutter + 10, doc.y)
          .restore();
        v.sources.slice(0, 3).forEach(src => {
          doc.save()
            .fontSize(8)
            .font('Helvetica')
            .fillColor(COLORS.blue)
            .text(`• ${src.title ?? src.uri}`, COLORS.pageGutter + 20, doc.y, {
              width: COLORS.pageWidth - 30,
              ellipsis: true,
            })
            .restore();
          doc.moveDown(0.15);
        });
      }
    }
    doc.moveDown(0.6);
  });
}

// ── Recommendations ───────────────────────────────────────────────────────────

function drawRecommendations(
  doc: PDFKit.PDFDocument,
  overallRisk: string,
  claims: PdfClaim[],
  verifications: Record<string, PdfVerification>,
): void {
  const contradicted = Object.values(verifications).filter(v => v.status === 'contradicted');
  const mixed        = Object.values(verifications).filter(v => v.status === 'mixed');

  const recs: string[] = [];

  if (overallRisk === 'critical' || overallRisk === 'high') {
    recs.push('Immediate review required. Multiple claims are directly contradicted by available evidence. Do not publish without editorial oversight.');
  }
  if (contradicted.length > 0) {
    recs.push(`${contradicted.length} claim(s) are contradicted by sources. Each should be individually fact-checked, corrected, or removed.`);
  }
  if (mixed.length > 0) {
    recs.push(`${mixed.length} claim(s) have mixed evidence — partially supported but with contradicting signals. Add nuance or cite specific sources to strengthen these claims.`);
  }
  const unsourced = claims.filter(c => {
    const v = verifications[c.id];
    return !v || !v.sources || v.sources.length === 0;
  });
  if (unsourced.length > 0) {
    recs.push(`${unsourced.length} claim(s) have no source citations. Add authoritative citations to improve credibility.`);
  }
  const highImportanceClaims = claims.filter(c => c.importance >= 4);
  if (highImportanceClaims.length > 0) {
    recs.push(`${highImportanceClaims.length} high-importance claim(s) detected. Prioritise verification of these above others.`);
  }
  if (recs.length === 0) {
    recs.push('No critical issues detected. Consider a secondary review with an alternative provider for additional confidence.');
  }

  recs.forEach((rec, i) => {
    doc.save()
      .rect(COLORS.pageGutter, doc.y, 4, 40)
      .fill(riskColor(overallRisk))
      .fontSize(10)
      .font('Helvetica')
      .fillColor(COLORS.text)
      .text(`${i + 1}. ${rec}`, COLORS.pageGutter + 14, doc.y, {
        width: COLORS.pageWidth - 14,
      })
      .restore();
    doc.moveDown(0.8);
  });
}
