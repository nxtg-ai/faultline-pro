import type { FastifyReply } from 'fastify';
import type { ExtractionError, ExtractionErrorReason } from '@nxtg/faultline/providers/extraction-error.js';

/** The body every route sends when claim extraction failed. Never carries provider text. */
export interface ExtractionFailedBody {
  error: 'extraction_failed';
  reason: ExtractionErrorReason;
}

export function extractionFailedBody(err: ExtractionError): ExtractionFailedBody {
  return { error: 'extraction_failed', reason: err.reason };
}

/**
 * 502: the upstream extraction provider failed or returned an unreadable claim
 * list, so nothing was checked. Not a 500 (the API itself is fine) and not a
 * result built on synthetic per-sentence claims.
 */
export function sendExtractionFailed(reply: FastifyReply, err: ExtractionError): FastifyReply {
  return reply.status(502).send(extractionFailedBody(err));
}
