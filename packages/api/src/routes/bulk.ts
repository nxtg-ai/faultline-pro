import type { FastifyInstance } from 'fastify';
import AdmZip from 'adm-zip';
import { requireApiKey } from '../plugins/auth.js';
import { getBulkJobStore } from '../store/bulk-jobs.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import type { Provider } from '../store/jobs.js';

const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.json']);

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx !== -1 ? filename.slice(idx).toLowerCase() : '';
}

async function processBulkJob(
  jobId: string,
  zipBuffer: Buffer,
  provider: Provider,
): Promise<void> {
  const store = getBulkJobStore();
  store.update(jobId, { status: 'running' });

  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.fail(jobId, message);
    return;
  }

  const entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory && ALLOWED_EXTENSIONS.has(getExtension(e.entryName)));

  for (const entry of entries) {
    const filename = entry.entryName;
    try {
      const text = entry.getData().toString('utf8');
      const result = await scan(text, provider);
      store.recordFileResult(jobId, {
        filename,
        status: 'done',
        overallRisk: result.overallRisk as string,
        claimCount: Array.isArray(result.claims) ? result.claims.length : 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.recordFileResult(jobId, { filename, status: 'failed', error: message });
    }
  }

  store.complete(jobId);
}

export async function bulkRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /scan/bulk — accepts ZIP archive, returns jobId immediately (202)
  fastify.post<{ Querystring: { provider?: string } }>(
    '/scan/bulk',
    { preHandler: requireApiKey, schema: { tags: ['Jobs'], summary: 'Upload ZIP of documents for async bulk scan' } },
    async (request, reply) => {
      let zipBuffer: Buffer | null = null;

      try {
        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === 'file' && part.fieldname === 'archive') {
            const chunks: Buffer[] = [];
            for await (const chunk of part.file) {
              chunks.push(chunk as Buffer);
            }
            zipBuffer = Buffer.concat(chunks);
          } else if (part.type === 'file') {
            // drain unrecognised file fields
            await part.toBuffer();
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }

      if (zipBuffer === null || zipBuffer.length === 0) {
        return reply.status(400).send({ error: 'No archive field in multipart request.' });
      }

      // Determine total entry count for job creation
      let entryCount = 0;
      try {
        const zip = new AdmZip(zipBuffer);
        entryCount = zip
          .getEntries()
          .filter((e) => !e.isDirectory && ALLOWED_EXTENSIONS.has(getExtension(e.entryName)))
          .length;
      } catch {
        return reply.status(400).send({ error: 'Invalid or unreadable ZIP archive.' });
      }

      const provider = ((request.query as { provider?: string }).provider ?? 'openai') as Provider;
      const job = getBulkJobStore().create(entryCount);

      if (entryCount === 0) {
        // Nothing to process — mark done immediately
        getBulkJobStore().complete(job.id);
        return reply.status(202).send({ jobId: job.id });
      }

      // Fire-and-forget background processing
      void processBulkJob(job.id, zipBuffer, provider);

      return reply.status(202).send({ jobId: job.id });
    },
  );

  // GET /jobs/:id/progress — returns BulkJob or 404
  fastify.get<{ Params: { id: string } }>(
    '/jobs/:id/progress',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Get progress and results of a bulk scan job',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const job = getBulkJobStore().get(request.params.id);
      if (!job) {
        return reply.status(404).send({ error: 'Job not found.' });
      }
      return reply.status(200).send(job);
    },
  );
}
