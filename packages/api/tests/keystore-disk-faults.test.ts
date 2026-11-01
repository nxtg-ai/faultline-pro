/**
 * Disk faults the keystore must not hide or turn into data loss: a directory
 * fsync that fails after the rename, and a bad file that cannot be moved aside.
 */
// NEXUS: durable hashed keystore (fail closed, never overwrite an unread file)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const control = vi.hoisted(() => ({ failDirFsync: false, failQuarantineRename: false, failQuarantineCopy: false }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    fsyncSync: (fd: number) => {
      if (control.failDirFsync && real.fstatSync(fd).isDirectory()) throw Object.assign(new Error('fsync failed (test)'), { code: 'EIO' });
      return real.fsyncSync(fd);
    },
    renameSync: (from: import('node:fs').PathLike, to: import('node:fs').PathLike) => {
      if (control.failQuarantineRename && String(to).includes('.unreadable-')) throw Object.assign(new Error('rename failed (test)'), { code: 'EIO' });
      return real.renameSync(from, to);
    },
    copyFileSync: (from: import('node:fs').PathLike, to: import('node:fs').PathLike, mode?: number) => {
      if (control.failQuarantineCopy) throw Object.assign(new Error('copy failed (test)'), { code: 'EIO' });
      return real.copyFileSync(from, to, mode);
    },
  };
});

const { KeyStore, KEYSTORE_WRITE_FAILED_LOG } = await import('../src/store/keys.js');

// The first test pays for loading the store module; under a full parallel suite that can pass 5 s.
vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let file: string;
const BAD = '{broken';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fl-keystore-faults-'));
  file = join(dir, 'keystore.json');
  control.failDirFsync = false;
  control.failQuarantineRename = false;
  control.failQuarantineCopy = false;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('keystore disk faults', () => {
  it('a directory fsync that fails after the rename is counted and logged', () => {
    const store = new KeyStore({ path: file });
    store.create('first');
    expect(store.getWriteFailures()).toBe(0);
    control.failDirFsync = true;
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    const second = store.create('second');
    expect(store.getWriteFailures()).toBe(1);
    expect(warn).toHaveBeenCalledWith(KEYSTORE_WRITE_FAILED_LOG);
    expect(store.validateKey(second.key)?.id).toBe(second.id);
  });

  it('a bad file whose rename aside fails is copied aside, and writes go on', () => {
    writeFileSync(file, BAD);
    control.failQuarantineRename = true;
    const store = new KeyStore({ path: file });
    expect(store.getLoadFailures()).toBe(1);
    const aside = readdirSync(dir).filter((n) => n.startsWith('keystore.json.unreadable-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]), 'utf8')).toBe(BAD);
    const issued = store.create('fresh');
    expect(store.getWriteFailures()).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).keys).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]), 'utf8')).toBe(BAD);
    expect(store.validateKey(issued.key)?.id).toBe(issued.id);
  });

  it('a bad file that cannot be moved or copied aside is never overwritten; writes are refused and counted', () => {
    writeFileSync(file, BAD);
    control.failQuarantineRename = true;
    control.failQuarantineCopy = true;
    const store = new KeyStore({ path: file });
    expect(store.getLoadFailures()).toBe(1);
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    const issued = store.create('fresh');
    expect(readFileSync(file, 'utf8')).toBe(BAD);
    expect(store.getWriteFailures()).toBe(1);
    expect(warn).toHaveBeenCalledWith(KEYSTORE_WRITE_FAILED_LOG);
    // Memory still serves the new key.
    expect(store.validateKey(issued.key)?.id).toBe(issued.id);
    expect(readdirSync(dir)).toEqual(['keystore.json']);
  });
});
