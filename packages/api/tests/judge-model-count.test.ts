// Validates: GoPMO 1.18.11.7.127 (ruling Dx3 abccffac item 4): a daily count of which Gemini model
// judged each claim, with the fallback judge's 7-day share and an alert above 10%.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getJudgeModelStatus,
  isGeminiJudgeLeg,
  recordJudgeLeg,
  resetJudgeModelLedger,
  windowDays,
} from '../src/store/judge-model-count.js';
import { recordUsage, captureUsage } from '@nxtg/faultline/lib/usage-sink.js';
import { buildServer } from '../src/server.js';

const PRIMARY = 'gemini-3.1-pro-preview';
const FALLBACK = 'gemini-3.8-flash';
const NOW = new Date('2026-11-20T12:00:00Z');
let dir: string;
let saved: string | undefined;

const judgeLeg = (model: string) => ({ provider: 'gemini', model, callType: 'grounded-verify:gemini', inputTokens: 1, outputTokens: 1, isGrounding: false });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judge-models-'));
  saved = process.env.FAULTLINE_JUDGE_MODEL_LEDGER;
  process.env.FAULTLINE_JUDGE_MODEL_LEDGER = join(dir, 'judge-models.jsonl');
  resetJudgeModelLedger();
});

afterEach(() => {
  if (saved === undefined) delete process.env.FAULTLINE_JUDGE_MODEL_LEDGER;
  else process.env.FAULTLINE_JUDGE_MODEL_LEDGER = saved;
  resetJudgeModelLedger();
  rmSync(dir, { recursive: true, force: true });
});

describe('which legs count', () => {
  it('counts Gemini judge calls only, never extraction, retrieval, critique or other providers', () => {
    expect(isGeminiJudgeLeg(judgeLeg(PRIMARY))).toBe(true);
    expect(isGeminiJudgeLeg({ ...judgeLeg(PRIMARY), callType: 'extraction' })).toBe(false);
    expect(isGeminiJudgeLeg({ ...judgeLeg(PRIMARY), callType: 'grounded-retrieve:gemini' })).toBe(false);
    expect(isGeminiJudgeLeg({ ...judgeLeg(PRIMARY), callType: 'critique:gemini' })).toBe(false);
    expect(isGeminiJudgeLeg({ ...judgeLeg('gpt-4o-mini'), provider: 'openai', callType: 'grounded-verify:openai' })).toBe(false);
    expect(recordJudgeLeg({ ...judgeLeg(''), model: '' }, NOW)).toBe(false);
    expect(recordJudgeLeg({ ...judgeLeg('?') }, NOW)).toBe(false);
  });
});

describe('the 7-day status', () => {
  it('reports per-model counts, the fallback share and no alert at 10% or less', () => {
    for (let i = 0; i < 18; i += 1) recordJudgeLeg(judgeLeg(PRIMARY), NOW);
    for (let i = 0; i < 2; i += 1) recordJudgeLeg(judgeLeg(FALLBACK), NOW);
    const s = getJudgeModelStatus(NOW, PRIMARY);
    expect(s.byModel).toEqual({ [PRIMARY]: 18, [FALLBACK]: 2 });
    expect(s.total).toBe(20);
    expect(s.fallbackShare).toBeCloseTo(0.10, 10);
    expect(s.alert).toBe(false);
    expect(s.from).toBe('2026-11-14');
    expect(s.to).toBe('2026-11-20');
  });

  it('alerts above 10%', () => {
    for (let i = 0; i < 8; i += 1) recordJudgeLeg(judgeLeg(PRIMARY), NOW);
    for (let i = 0; i < 2; i += 1) recordJudgeLeg(judgeLeg(FALLBACK), NOW);
    const s = getJudgeModelStatus(NOW, PRIMARY);
    expect(s.fallbackShare).toBeCloseTo(0.2, 10);
    expect(s.alert).toBe(true);
  });

  it('a day older than the window is left out', () => {
    recordJudgeLeg(judgeLeg(FALLBACK), new Date('2026-11-13T23:59:59Z'));
    recordJudgeLeg(judgeLeg(PRIMARY), NOW);
    const s = getJudgeModelStatus(NOW, PRIMARY);
    expect(s.byModel).toEqual({ [PRIMARY]: 1 });
    expect(s.fallbackShare).toBe(0);
  });

  it('no judge calls: share null, no alert', () => {
    const s = getJudgeModelStatus(NOW, PRIMARY);
    expect(s.total).toBe(0);
    expect(s.fallbackShare).toBeNull();
    expect(s.alert).toBe(false);
  });

  it('the window is 7 UTC days ending today', () => {
    expect(windowDays(NOW)).toEqual(['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
  });
});

describe('the ledger', () => {
  it('appends one row per judge call and a new process hydrates from it', () => {
    recordJudgeLeg(judgeLeg(PRIMARY), NOW);
    recordJudgeLeg(judgeLeg(FALLBACK), NOW);
    const rows = readFileSync(process.env.FAULTLINE_JUDGE_MODEL_LEDGER!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toEqual([
      { ts: NOW.toISOString(), day: '2026-11-20', model: PRIMARY },
      { ts: NOW.toISOString(), day: '2026-11-20', model: FALLBACK },
    ]);
    resetJudgeModelLedger();
    expect(getJudgeModelStatus(NOW, PRIMARY).byModel).toEqual({ [PRIMARY]: 1, [FALLBACK]: 1 });
  });

  it('skips unreadable rows instead of zeroing the count', () => {
    writeFileSync(process.env.FAULTLINE_JUDGE_MODEL_LEDGER!, `not json\n${JSON.stringify({ ts: NOW.toISOString(), day: '2026-11-20', model: PRIMARY })}\n{"day":"2026-11-20"}\n`);
    expect(getJudgeModelStatus(NOW, PRIMARY).byModel).toEqual({ [PRIMARY]: 1 });
  });

  it('a failed write is counted and never throws', () => {
    process.env.FAULTLINE_JUDGE_MODEL_LEDGER = join(dir, 'missing', '\0bad', 'x.jsonl');
    resetJudgeModelLedger();
    expect(() => recordJudgeLeg(judgeLeg(PRIMARY), NOW)).not.toThrow();
    expect(getJudgeModelStatus(NOW, PRIMARY).ledgerWriteFailures).toBe(1);
    expect(getJudgeModelStatus(NOW, PRIMARY).byModel).toEqual({ [PRIMARY]: 1 });
  });
});

describe('wired into the server', () => {
  it('a judge leg emitted during a request is counted, and admin /usage reports judgeModels', async () => {
    process.env.FAULTLINE_API_KEY = 'judge-count-admin-key';
    const server = buildServer();
    await server.ready();
    try {
      await captureUsage(async () => { recordUsage(judgeLeg('gemini-2.5-flash')); });
      const body = (await server.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': 'judge-count-admin-key' } })).json();
      expect(body.judgeModels).toBeDefined();
      expect(body.judgeModels.total).toBeGreaterThan(0);
      expect(body.judgeModels.byModel['gemini-2.5-flash']).toBeGreaterThan(0);
      expect(body.judgeModels.alertShare).toBe(0.10);
    } finally {
      await server.close();
      delete process.env.FAULTLINE_API_KEY;
    }
  });
});
