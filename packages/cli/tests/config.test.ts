import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, mergeFlags, generateSampleConfig } from '../cli/config';
import type { FaultlineConfig } from '../cli/config';

describe('Config: loadConfig()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-config-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return empty object when no config file exists', () => {
    const config = loadConfig(tmpDir);
    expect(config).toEqual({});
  });

  it('should load .faultlinerc.json from specified directory', () => {
    writeFileSync(join(tmpDir, '.faultlinerc.json'), JSON.stringify({
      provider: 'claude',
      'min-confidence': 0.7,
      'output-format': 'markdown',
      rules: ['pii'],
    }));
    const config = loadConfig(tmpDir);
    expect(config.provider).toBe('claude');
    expect(config['min-confidence']).toBe(0.7);
    expect(config['output-format']).toBe('markdown');
    expect(config.rules).toEqual(['pii']);
  });

  it('should walk up directories to find config', () => {
    // Place config in tmpDir, start search from a child
    writeFileSync(join(tmpDir, '.faultlinerc.json'), JSON.stringify({ provider: 'mock' }));
    const child = join(tmpDir, 'sub', 'deep');
    mkdirSync(child, { recursive: true });
    const config = loadConfig(child);
    expect(config.provider).toBe('mock');
  });

  it('should ignore invalid JSON gracefully', () => {
    writeFileSync(join(tmpDir, '.faultlinerc.json'), 'NOT VALID JSON!!!');
    const config = loadConfig(tmpDir);
    expect(config).toEqual({});
  });

  it('should strip unknown keys', () => {
    writeFileSync(join(tmpDir, '.faultlinerc.json'), JSON.stringify({
      provider: 'mock',
      unknownKey: 'should be stripped',
      $comment: 'should be stripped',
    }));
    const config = loadConfig(tmpDir);
    expect(config).toEqual({ provider: 'mock' });
    expect((config as any).unknownKey).toBeUndefined();
    expect((config as any).$comment).toBeUndefined();
  });

  it('should reject out-of-range min-confidence', () => {
    writeFileSync(join(tmpDir, '.faultlinerc.json'), JSON.stringify({ 'min-confidence': 1.5 }));
    const config = loadConfig(tmpDir);
    expect(config['min-confidence']).toBeUndefined();
  });

  it('should reject invalid output-format', () => {
    writeFileSync(join(tmpDir, '.faultlinerc.json'), JSON.stringify({ 'output-format': 'yaml' }));
    const config = loadConfig(tmpDir);
    expect(config['output-format']).toBeUndefined();
  });

  it('should reject non-string rules', () => {
    writeFileSync(join(tmpDir, '.faultlinerc.json'), JSON.stringify({ rules: [123, true] }));
    const config = loadConfig(tmpDir);
    expect(config.rules).toBeUndefined();
  });

  it('should accept valid partial config', () => {
    writeFileSync(join(tmpDir, '.faultlinerc.json'), JSON.stringify({ provider: 'gemini' }));
    const config = loadConfig(tmpDir);
    expect(config).toEqual({ provider: 'gemini' });
    expect(config['min-confidence']).toBeUndefined();
  });
});

describe('Config: mergeFlags()', () => {
  it('should use defaults when no config and no flags', () => {
    const result = mergeFlags({}, {});
    expect(result.provider).toBeUndefined();
    expect(result.minConfidence).toBeUndefined();
    expect(result.outputFormat).toBe('json');
    expect(result.ruleNames).toBeUndefined();
  });

  it('should use config values when no flags', () => {
    const config: FaultlineConfig = {
      provider: 'claude',
      'min-confidence': 0.8,
      'output-format': 'html',
      rules: ['pii', 'bias'],
    };
    const result = mergeFlags(config, {});
    expect(result.provider).toBe('claude');
    expect(result.minConfidence).toBe(0.8);
    expect(result.outputFormat).toBe('html');
    expect(result.ruleNames).toEqual(['pii', 'bias']);
  });

  it('should let flags override config values', () => {
    const config: FaultlineConfig = {
      provider: 'claude',
      'min-confidence': 0.8,
      'output-format': 'html',
      rules: ['pii'],
    };
    const flags = {
      provider: 'mock',
      'min-confidence': '0.5',
      'output-format': 'markdown',
      rules: 'toxicity,bias',
    };
    const result = mergeFlags(config, flags);
    expect(result.provider).toBe('mock');
    expect(result.minConfidence).toBe(0.5);
    expect(result.outputFormat).toBe('markdown');
    expect(result.ruleNames).toEqual(['toxicity', 'bias']);
  });

  it('should partially override — flag provider, config rules', () => {
    const config: FaultlineConfig = { provider: 'claude', rules: ['pii'] };
    const flags = { provider: 'mock' };
    const result = mergeFlags(config, flags);
    expect(result.provider).toBe('mock');
    expect(result.ruleNames).toEqual(['pii']);
  });

  it('should handle empty flags string gracefully', () => {
    const result = mergeFlags({}, { rules: '' });
    expect(result.ruleNames).toBeUndefined();
  });
});

describe('Config: generateSampleConfig()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'faultline-init-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create .faultlinerc.json', () => {
    const filePath = generateSampleConfig(tmpDir);
    expect(existsSync(filePath)).toBe(true);
    expect(filePath).toContain('.faultlinerc.json');
  });

  it('should contain valid JSON with all config keys', () => {
    generateSampleConfig(tmpDir);
    const content = JSON.parse(readFileSync(join(tmpDir, '.faultlinerc.json'), 'utf-8'));
    expect(content.provider).toBeDefined();
    expect(content['min-confidence']).toBeDefined();
    expect(content['output-format']).toBeDefined();
    expect(content.rules).toBeDefined();
    expect(Array.isArray(content.rules)).toBe(true);
  });

  it('should include a $comment field', () => {
    generateSampleConfig(tmpDir);
    const content = JSON.parse(readFileSync(join(tmpDir, '.faultlinerc.json'), 'utf-8'));
    expect(content.$comment).toContain('Faultline');
  });

  it('should be loadable by loadConfig', () => {
    generateSampleConfig(tmpDir);
    const config = loadConfig(tmpDir);
    expect(config.provider).toBe('mock');
    expect(config['min-confidence']).toBe(0.5);
    expect(config.rules).toEqual(['pii', 'bias', 'toxicity']);
  });
});
