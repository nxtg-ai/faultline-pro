/**
 * The keystore file is replaced by rename, never written in place. With rename
 * made to fail, the previous file must be left whole (a crash mid-write cannot
 * leave a half-written keystore) and the failure must be counted.
 */
// NEXUS: durable hashed keystore (atomic write: temp file, fsync, rename)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const control = vi.hoisted(() => ({ failRename: false, renames: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    renameSync: (from: import('node:fs').PathLike, to: import('node:fs').PathLike) => {
      control.renames += 1;
      if (control.failRename) throw Object.assign(new Error('rename failed (test)'), { code: 'EIO' });
      return real.renameSync(from, to);
    },
  };
});

const { KeyStore } = await import('../src/store/keys.js');

// The first test pays for loading the store module; under a full parallel suite that can pass 5 s.
vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fl-keystore-atomic-'));
  file = join(dir, 'keystore.json');
  control.failRename = false;
  control.renames = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('keystore atomic write', () => {
  it('every write goes through a rename', () => {
    const store = new KeyStore({ path: file });
    store.create('a');
    store.create('b');
    expect(control.renames).toBe(2);
    expect(readdirSync(dir)).toEqual(['keystore.json']);
  });

  it('a failed rename leaves the previous file whole, is counted, and memory still serves', () => {
    const store = new KeyStore({ path: file });
    const first = store.create('first');
    const before = readFileSync(file, 'utf8');
    expect(JSON.parse(before).keys).toHaveLength(1);

    control.failRename = true;
    const second = store.create('second');
    expect(store.getWriteFailures()).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(store.validateKey(second.key)?.id).toBe(second.id);

    // A restart sees the last good file: the first key, not the second.
    control.failRename = false;
    const reloaded = new KeyStore({ path: file });
    expect(reloaded.size).toBe(1);
    expect(reloaded.validateKey(first.key)?.id).toBe(first.id);
    expect(reloaded.validateKey(second.key)).toBeNull();
  });
});
