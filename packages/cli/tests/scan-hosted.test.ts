/**
 * `scan --input` and `scan --file` run on the hosted API when FAULTLINE_API_KEY
 * is set, as the help text, the no-key message and the README say.
 *
 * In 0.12.1 the single-file scan path always ran locally: a buyer holding only
 * a Faultline API key got "NOTHING WAS CHECKED" and never reached the API.
 * Only `guard` consulted resolveTransport.
 *
 * No network: global fetch is stubbed and returns a ScanResult produced by the
 * real engine on the mock provider.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../cli/extract.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../cli/extract.js')>();
  return { ...real, extractTextFromFile: vi.fn(async () => 'The Eiffel Tower is in Paris, France.') };
});

import { main } from '../cli/index';
import { scan } from '../cli/scan';
import type { ScanResult } from '../cli/scan';

const ENV_KEYS = [
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY',
  'FAULTLINE_API_KEY', 'FAULTLINE_PROVIDER', 'FAULTLINE_API_URL',
];
// Built at runtime so no key-shaped literal sits in the repo.
const TEST_KEY = ['fl', 'test', 'hosted', 'scan', 'key'].join('_');
const TEXT = 'The Eiffel Tower is in Paris, France.';

let saved: Record<string, string | undefined>;
let dir: string;
let file: string;
let historyDir: string;
let engineResult: ScanResult;
const fetchMock = vi.fn();

function replyOk(result: ScanResult = engineResult) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } }));
}

beforeAll(async () => {
  engineResult = await scan(TEXT, 'mock');
  expect(engineResult.claims.length).toBeGreaterThan(0);
});

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), 'fl-hosted-'));
  file = join(dir, 'input.txt');
  writeFileSync(file, `${TEXT}\n`, 'utf-8');
  historyDir = join(dir, 'history');
  mkdirSync(historyDir);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('scan --input with FAULTLINE_API_KEY and no provider key', () => {
  it('posts the text to the hosted /scan with the key, and reports its claims', async () => {
    process.env.FAULTLINE_API_KEY = TEST_KEY;
    replyOk();
    const { exitCode, output } = await main(['scan', '--input', file, '--output-format', 'json', '--history-dir', historyDir]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://faultline-api.fly.dev/scan');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe(TEST_KEY);
    expect(JSON.parse(init.body)).toEqual({ text: TEXT });
    expect(exitCode).toBe(0);
    expect(output).not.toMatch(/NOTHING WAS CHECKED/);
    const parsed = JSON.parse(output);
    expect(parsed.claims.length).toBe(engineResult.claims.length);
    expect(parsed.claims[0].text).toBe(engineResult.claims[0].text);
  });

  it('sends an explicit --provider, and only an explicit one', async () => {
    process.env.FAULTLINE_API_KEY = TEST_KEY;
    replyOk();
    await main(['scan', '--input', file, '--provider', 'gemini', '--output-format', 'json', '--history-dir', historyDir]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: TEXT, provider: 'gemini' });
  });

  it('a local provider key in the environment does not pull the scan off the hosted API', async () => {
    process.env.FAULTLINE_API_KEY = TEST_KEY;
    process.env.GEMINI_API_KEY = ['local', 'gemini', 'key'].join('_');
    replyOk();
    await main(['scan', '--input', file, '--output-format', 'json', '--history-dir', historyDir]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: TEXT });
  });

  it('uses FAULTLINE_API_URL when set', async () => {
    process.env.FAULTLINE_API_KEY = TEST_KEY;
    process.env.FAULTLINE_API_URL = 'https://api.example.test/';
    replyOk();
    await main(['scan', '--input', file, '--output-format', 'json', '--history-dir', historyDir]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.test/scan');
  });

  it('a refused key is an error that says nothing was verified, not a verdict', async () => {
    process.env.FAULTLINE_API_KEY = TEST_KEY;
    fetchMock.mockResolvedValueOnce(new Response('{"error":"invalid_api_key"}', { status: 401 }));
    const { exitCode, output } = await main(['scan', '--input', file, '--output-format', 'json', '--history-dir', historyDir]);
    expect(exitCode).toBe(1);
    expect(output).toMatch(/hosted scan could not run/);
    expect(output).toMatch(/401/);
    expect(output).toMatch(/Nothing was verified/);
    expect(output).not.toMatch(/\bsupported\b/i);
  });

  it('an unreachable API is an error, under a --fail-on gate too', async () => {
    process.env.FAULTLINE_API_KEY = TEST_KEY;
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const { exitCode, output } = await main(['scan', '--input', file, '--fail-on', 'critical', '--history-dir', historyDir]);
    expect(exitCode).toBe(1);
    expect(output).toMatch(/could not reach https:\/\/faultline-api\.fly\.dev\/scan/);
  });

  it('refuses --rules and --min-confidence rather than dropping them, and sends nothing', async () => {
    process.env.FAULTLINE_API_KEY = TEST_KEY;
    for (const extra of [['--rules', 'pii-detection'], ['--min-confidence', '0.5']]) {
      const { exitCode, output } = await main(['scan', '--input', file, ...extra, '--history-dir', historyDir]);
      expect(exitCode).toBe(1);
      expect(output).toMatch(/apply only to a local scan/);
      expect(output).toMatch(/Nothing was checked/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('scan --file with FAULTLINE_API_KEY', () => {
  it('posts the extracted text to the hosted /scan', async () => {
    process.env.FAULTLINE_API_KEY = TEST_KEY;
    const pdf = join(dir, 'report.pdf');
    writeFileSync(pdf, 'not really a pdf; extraction is mocked');
    replyOk();
    const { exitCode, output } = await main(['scan', '--file', pdf, '--output-format', 'json']);
    expect(exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: TEXT });
    expect(JSON.parse(output).claims.length).toBe(engineResult.claims.length);
  });
});

describe('batch modes with only FAULTLINE_API_KEY', () => {
  it('--dir says it runs on a provider key and points at --input, and sends nothing', async () => {
    process.env.FAULTLINE_API_KEY = TEST_KEY;
    const { exitCode, output } = await main(['scan', '--dir', dir]);
    expect(exitCode).toBe(1);
    expect(output).toMatch(/--dir and --templates run on your own provider key/);
    expect(output).toMatch(/--input/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('--dir still runs locally on an explicit provider', async () => {
    process.env.FAULTLINE_API_KEY = TEST_KEY;
    const { output } = await main(['scan', '--dir', dir, '--provider', 'mock']);
    expect(output).not.toMatch(/--dir and --templates run on your own provider key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('without FAULTLINE_API_KEY nothing changes', () => {
  it('scan --input with no key at all still refuses and calls no API', async () => {
    const { exitCode, output } = await main(['scan', '--input', file]);
    expect(exitCode).toBe(1);
    expect(output).toMatch(/NOTHING WAS CHECKED/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scan --input --provider mock runs locally and calls no API', async () => {
    const { exitCode } = await main(['scan', '--input', file, '--provider', 'mock', '--history-dir', historyDir]);
    expect(exitCode).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
