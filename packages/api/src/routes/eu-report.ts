import type { FastifyInstance } from 'fastify';
import PDFDocument from 'pdfkit';
import { requireApiKey } from '../plugins/auth.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import type { ScanResult } from '@nxtg/faultline/cli/scan.js';

// ── EU AI Act Article Reference Data ────────────────────────────────────────

interface ArticleRef {
  ref: string;
  title: string;
  obligation: string;
}

const HIGH_RISK_ARTICLES: ArticleRef[] = [
  { ref: 'Art. 6', title: 'Classification of High-Risk AI Systems', obligation: 'System must be classified and registered.' },
  { ref: 'Art. 9', title: 'Risk Management System', obligation: 'Continuous risk management process required throughout lifecycle.' },
  { ref: 'Art. 13', title: 'Transparency and Provision of Information', obligation: 'Users must be informed of AI system capabilities and limitations.' },
  { ref: 'Art. 14', title: 'Human Oversight', obligation: 'Effective human oversight measures must be built-in.' },
  { ref: 'Art. 15', title: 'Accuracy, Robustness and Cybersecurity', obligation: 'System must achieve appropriate levels of accuracy and be robust.' },
  { ref: 'Annex III', title: 'High-Risk AI Systems List', obligation: 'Verify whether system falls within Annex III category.' },
];

const LIMITED_RISK_ARTICLES: ArticleRef[] = [
  { ref: 'Art. 52', title: 'Transparency Obligations', obligation: 'Users must be informed they are interacting with an AI system.' },
  { ref: 'Art. 69', title: 'Codes of Conduct', obligation: 'Voluntary adherence to codes of conduct is encouraged.' },
];

const MINIMAL_RISK_ARTICLES: ArticleRef[] = [
  { ref: 'Art. 69', title: 'Voluntary Codes of Conduct', obligation: 'No mandatory obligations; voluntary best practices apply.' },
  { ref: 'Recital 47', title: 'Minimal Risk Definition', obligation: 'System poses minimal risk to rights and safety. Standard due diligence applies.' },
];

function getArticlesForRisk(risk: string): ArticleRef[] {
  if (risk === 'critical' || risk === 'high') return HIGH_RISK_ARTICLES;
  if (risk === 'medium') return LIMITED_RISK_ARTICLES;
  return MINIMAL_RISK_ARTICLES;
}

function riskClassification(risk: string): string {
  if (risk === 'critical' || risk === 'high') return 'HIGH RISK (Annex III candidate)';
  if (risk === 'medium') return 'LIMITED RISK';
  return 'MINIMAL RISK';
}

function claimComplianceFlag(status: string): { flag: string; article?: string; color: string } {
  switch (status) {
    case 'contradicted':
      return { flag: 'VIOLATION RISK', article: 'Art. 13(1)', color: '#dc2626' };
    case 'unverified':
    case 'mixed':
      return { flag: 'FLAG', article: 'Art. 13(1)', color: '#d97706' };
    case 'supported':
      return { flag: 'COMPLIANT', color: '#16a34a' };
    default:
      return { flag: 'REVIEW', color: '#6b7280' };
  }
}

const EU_BLUE = '#003399'; // EU flag blue
const GRAY = '#6b7280';
const DARK = '#111827';

// ── PDF Builder ──────────────────────────────────────────────────────────────

function buildEuPdf(result: ScanResult, projectName: string, scanDate: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const articles = getArticlesForRisk(result.overallRisk);
    const classification = riskClassification(result.overallRisk);

    // ── COVER PAGE ───────────────────────────────────────────────────────────
    // EU flag colour bar
    doc.rect(0, 0, doc.page.width, 8).fill(EU_BLUE);
    doc.rect(0, 8, doc.page.width, 4).fill('#FFDD00'); // EU gold stripe

    doc.moveDown(3);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(EU_BLUE)
      .text('EUROPEAN UNION ARTIFICIAL INTELLIGENCE ACT', { align: 'center' });
    doc.font('Helvetica-Bold').fontSize(22).fillColor(DARK)
      .text('Compliance Assessment Report', { align: 'center' });
    doc.font('Helvetica').fontSize(12).fillColor(GRAY)
      .text('Regulation (EU) 2024/1689 — AI Act', { align: 'center' });

    doc.moveDown(1.5);

    // Classification badge
    const badgeColor = result.overallRisk === 'critical' || result.overallRisk === 'high'
      ? '#dc2626' : result.overallRisk === 'medium' ? '#d97706' : '#16a34a';
    const badgeX = (doc.page.width - 200) / 2;
    doc.roundedRect(badgeX, doc.y, 200, 32, 4).fill(badgeColor);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff')
      .text(classification, badgeX, doc.y - 22, { width: 200, align: 'center' });

    doc.moveDown(2);

    // Metadata box
    const boxX = 80;
    const boxW = doc.page.width - 160;
    doc.roundedRect(boxX, doc.y, boxW, 120, 6).strokeColor('#e5e7eb').stroke();
    const metaTop = doc.y + 16;
    doc.font('Helvetica').fontSize(10).fillColor(GRAY);
    ['Project', 'Assessment Date', 'Provider', 'Risk Classification', 'Claims Analysed'].forEach((label, i) => {
      doc.text(label, boxX + 20, metaTop + i * 20);
    });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK);
    [
      projectName || 'Untitled Assessment',
      scanDate,
      result.provider,
      classification,
      String(result.claims.length),
    ].forEach((val, i) => {
      if (i === 3) doc.fillColor(badgeColor);
      else doc.fillColor(DARK);
      doc.text(val, boxX + 180, metaTop + i * 20);
    });

    doc.moveDown(8);
    doc.rect(0, doc.page.height - 30, doc.page.width, 30).fill('#f0f4ff');
    doc.font('Helvetica').fontSize(9).fillColor(GRAY)
      .text('Faultline Pro — EU AI Act Compliance Assessment | faultline.nxtg.ai', 0, doc.page.height - 20, { align: 'center' });

    // ── EXECUTIVE SUMMARY ────────────────────────────────────────────────────
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 8).fill(EU_BLUE);
    doc.moveDown(1.5);

    doc.font('Helvetica-Bold').fontSize(16).fillColor(DARK).text('1. Executive Summary', 50);
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor('#e5e7eb').stroke();
    doc.moveDown(0.5);

    const verifs = Object.values(result.verifications);
    const supported = verifs.filter(v => v.status === 'supported').length;
    const contradicted = verifs.filter(v => v.status === 'contradicted').length;
    const unverified = verifs.filter(v => ['unverified', 'mixed'].includes(v.status)).length;
    const violationRisk = contradicted > 0 || result.overallRisk === 'critical';

    doc.font('Helvetica').fontSize(11).fillColor(DARK).text(
      `This EU AI Act compliance assessment analysed ${result.claims.length} claim(s) extracted from the provided AI system output using the ${result.provider} verification provider. ` +
      `The system has been classified as ${classification} under Regulation (EU) 2024/1689.`,
      50, doc.y, { width: doc.page.width - 100, lineGap: 4 }
    );

    doc.moveDown(0.5);
    if (verifs.length > 0) {
      doc.font('Helvetica').fontSize(11).fillColor(DARK).text(
        `Verification outcome: ${supported} claim(s) supported, ${contradicted} contradicted, ${unverified} unverified/partial.`,
        50, doc.y, { width: doc.page.width - 100 }
      );
    }

    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11)
      .fillColor(violationRisk ? '#dc2626' : '#16a34a')
      .text(
        violationRisk
          ? 'Potential Art. 13(1) transparency obligation violations detected. Immediate review recommended.'
          : 'No critical transparency violations detected. Continue monitoring per applicable articles.',
        50, doc.y, { width: doc.page.width - 100 }
      );

    // ── APPLICABLE ARTICLES ──────────────────────────────────────────────────
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(16).fillColor(DARK).text('2. Applicable EU AI Act Articles', 50);
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor('#e5e7eb').stroke();
    doc.moveDown(0.5);

    for (const article of articles) {
      if (doc.y > doc.page.height - 120) {
        doc.addPage();
        doc.rect(0, 0, doc.page.width, 8).fill(EU_BLUE);
        doc.moveDown(1);
      }
      // Article badge
      doc.roundedRect(50, doc.y, 70, 16, 3).fill(EU_BLUE);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#ffffff')
        .text(article.ref, 54, doc.y - 12, { width: 62, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK)
        .text(article.title, 130, doc.y - 13);
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(9.5).fillColor(GRAY)
        .text(article.obligation, 130, doc.y, { width: doc.page.width - 180 });
      doc.moveDown(0.6);
    }

    // ── CLAIMS COMPLIANCE TABLE ───────────────────────────────────────────────
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 8).fill(EU_BLUE);
    doc.moveDown(1.5);

    doc.font('Helvetica-Bold').fontSize(16).fillColor(DARK).text('3. Claim-Level Compliance Analysis', 50);
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor('#e5e7eb').stroke();
    doc.moveDown(0.5);

    if (result.claims.length === 0) {
      doc.font('Helvetica').fontSize(11).fillColor(GRAY).text('No claims extracted.', 50);
    } else {
      const colX = { num: 50, claim: 70, verdict: 290, flag: 390, article: 460 };
      const headerY = doc.y;
      doc.rect(50, headerY, doc.page.width - 100, 18).fill('#f0f4ff');
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(EU_BLUE);
      doc.text('#', colX.num + 2, headerY + 4);
      doc.text('CLAIM', colX.claim + 2, headerY + 4);
      doc.text('VERDICT', colX.verdict + 2, headerY + 4);
      doc.text('STATUS', colX.flag + 2, headerY + 4);
      doc.text('ARTICLE', colX.article + 2, headerY + 4);

      let rowY = headerY + 22;
      result.claims.forEach((claim, idx) => {
        if (rowY > doc.page.height - 80) {
          doc.addPage();
          doc.rect(0, 0, doc.page.width, 8).fill(EU_BLUE);
          rowY = 60;
        }

        const verif = result.verifications[claim.id];
        const status = verif?.status ?? 'unverified';
        const { flag, article, color } = claimComplianceFlag(status);
        const claimText = claim.text.length > 60 ? claim.text.substring(0, 57) + '...' : claim.text;
        const verdictMap: Record<string, string> = {
          supported: 'Supported', contradicted: 'Contradicted',
          unverified: 'Unverified', mixed: 'Partial', skipped: 'Skipped',
        };

        doc.moveTo(50, rowY - 1).lineTo(doc.page.width - 50, rowY - 1).strokeColor('#f3f4f6').stroke();
        doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text(String(idx + 1), colX.num + 2, rowY);
        doc.font('Helvetica').fontSize(8.5).fillColor(DARK).text(claimText, colX.claim, rowY, { width: 215 });
        doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text(verdictMap[status] ?? status, colX.verdict, rowY, { width: 95 });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(color).text(flag, colX.flag, rowY, { width: 65 });
        doc.font('Helvetica').fontSize(8.5).fillColor(EU_BLUE).text(article ?? '—', colX.article, rowY, { width: 70 });
        rowY += 18;
      });
    }

    // ── FOOTER ───────────────────────────────────────────────────────────────
    doc.rect(0, doc.page.height - 30, doc.page.width, 30).fill('#f0f4ff');
    doc.font('Helvetica').fontSize(9).fillColor(GRAY)
      .text('Faultline Pro — EU AI Act Compliance Assessment | Reg. (EU) 2024/1689', 0, doc.page.height - 20, { align: 'center' });

    doc.end();
  });
}

// ── Route ────────────────────────────────────────────────────────────────────

const BODY_SCHEMA = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 50000 },
    provider: {
      type: 'string',
      enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'],
    },
    projectName: { type: 'string', maxLength: 200 },
  },
  additionalProperties: false,
} as const;

interface EuReportBody {
  text: string;
  provider?: 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';
  projectName?: string;
}

export async function euReportRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: EuReportBody }>(
    '/scan/eu-report',
    {
      preHandler: requireApiKey,
      schema: { tags: ['Compliance'], summary: 'Generate EU AI Act compliance PDF report', body: BODY_SCHEMA },
    },
    async (request, reply) => {
      const { text, provider, projectName } = request.body;
      const scanDate = new Date().toISOString().split('T')[0];
      try {
        const result = await scan(text, provider);
        const pdf = await buildEuPdf(result, projectName ?? 'EU AI Act Assessment', scanDate);
        return reply
          .status(200)
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', `attachment; filename="eu-ai-act-report-${scanDate}.pdf"`)
          .send(pdf);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );
}
