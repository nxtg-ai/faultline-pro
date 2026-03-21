import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { generatePdfReport } from '../store/pdf-report.js';
import { getScanStore } from '../store/scans.js';
import type { PdfScanResult } from '../store/pdf-report.js';

export async function pdfReportRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /scan/report/pdf — generate PDF from an inline scan result
  fastify.post<{ Body: PdfScanResult }>(
    '/scan/report/pdf',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Reports'],
        summary: 'Generate a PDF scan report from a scan result',
        description: 'POST a ScanResult object (claims, verifications, overallRisk, provider, input). Returns a PDF binary stream. Alternatively, pass { scanId } to generate from a stored scan.',
        security: [{ apiKey: [] }],
        body: {
          type: 'object',
          properties: {
            // Inline scan result
            input:         { type: 'string' },
            provider:      { type: 'string' },
            overallRisk:   { type: 'string' },
            scannedAt:     { type: 'string' },
            claims:        { type: 'array' },
            verifications: { type: 'object' },
            // Alternative: stored scan id
            scanId:        { type: 'string' },
          },
          additionalProperties: true,
        },
      },
    },
    async (request, reply) => {
      let scanData: PdfScanResult;

      const body = request.body as unknown as Record<string, unknown>;

      // If scanId is provided, load from the scan store
      if (body.scanId) {
        const stored = getScanStore().getById(body.scanId as string);
        if (!stored) {
          return reply.status(404).send({ error: 'Scan not found.' });
        }
        scanData = {
          input:         stored.text,
          provider:      (stored.result as Record<string, string>).provider ?? 'unknown',
          overallRisk:   (stored.result as Record<string, string>).overallRisk ?? 'unknown',
          claims:        (stored.result as Record<string, unknown[]>).claims as PdfScanResult['claims'] ?? [],
          verifications: (stored.result as Record<string, Record<string, unknown>>).verifications as PdfScanResult['verifications'] ?? {},
          scannedAt:     stored.scannedAt,
        };
      } else {
        // Use inline body
        scanData = {
          input:         (body.input as string) ?? '',
          provider:      (body.provider as string) ?? 'unknown',
          overallRisk:   (body.overallRisk as string) ?? 'unknown',
          claims:        (body.claims as PdfScanResult['claims']) ?? [],
          verifications: (body.verifications as PdfScanResult['verifications']) ?? {},
          scannedAt:     (body.scannedAt as string) ?? new Date().toISOString(),
        };
      }

      let pdfBuffer: Buffer;
      try {
        pdfBuffer = await generatePdfReport(scanData);
      } catch (err) {
        return reply.status(500).send({ error: 'PDF generation failed.', detail: err instanceof Error ? err.message : String(err) });
      }

      const filename = `faultline-report-${Date.now()}.pdf`;
      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Content-Length', String(pdfBuffer.length));
      return reply.send(pdfBuffer);
    },
  );

  // GET /scan/report/pdf/:scanId — convenience endpoint from a stored scan ID
  fastify.get<{ Params: { id: string } }>(
    '/scan/report/pdf/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Reports'],
        summary: 'Generate a PDF report for a stored scan by ID',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const stored = getScanStore().getById(request.params.id);
      if (!stored) {
        return reply.status(404).send({ error: 'Scan not found.' });
      }

      const scanData: PdfScanResult = {
        input:         stored.text,
        provider:      (stored.result as Record<string, string>).provider ?? 'unknown',
        overallRisk:   (stored.result as Record<string, string>).overallRisk ?? 'unknown',
        claims:        (stored.result as Record<string, unknown>).claims as PdfScanResult['claims'] ?? [],
        verifications: (stored.result as Record<string, unknown>).verifications as PdfScanResult['verifications'] ?? {},
        scannedAt:     stored.scannedAt,
      };

      let pdfBuffer: Buffer;
      try {
        pdfBuffer = await generatePdfReport(scanData);
      } catch (err) {
        return reply.status(500).send({ error: 'PDF generation failed.', detail: err instanceof Error ? err.message : String(err) });
      }

      const filename = `faultline-report-${stored.id}.pdf`;
      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Content-Length', String(pdfBuffer.length));
      return reply.send(pdfBuffer);
    },
  );
}
