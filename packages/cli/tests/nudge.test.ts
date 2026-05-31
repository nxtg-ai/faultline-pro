import { describe, it, expect, vi, afterEach } from 'vitest';
import { printConversionNudge, NUDGE_COPY, NUDGE_URL } from '../cli/nudge';

describe('printConversionNudge()', () => {
  afterEach(() => {
    delete process.env.FAULTLINE_NO_NUDGE;
  });

  // PN1: fires on critical risk
  it('PN1: fires on critical risk — writes to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    printConversionNudge('critical', false);
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain(NUDGE_URL);
    spy.mockRestore();
  });

  // PN2: fires on high risk
  it('PN2: fires on high risk — writes to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    printConversionNudge('high', false);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  // PN3: suppressed on clean scan (low risk)
  it('PN3: suppressed on low risk (clean scan) — no stderr write', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    printConversionNudge('low', false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // PN4: suppressed on medium risk
  it('PN4: suppressed on medium risk — no stderr write', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    printConversionNudge('medium', false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // PN5: suppressed by --no-nudge flag (suppress=true)
  it('PN5: suppressed via --no-nudge flag (suppress=true) — no stderr write', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    printConversionNudge('critical', true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // PN6: suppressed via FAULTLINE_NO_NUDGE=1
  it('PN6: suppressed via FAULTLINE_NO_NUDGE=1 env var — no stderr write', () => {
    process.env.FAULTLINE_NO_NUDGE = '1';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    printConversionNudge('critical', false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // PN7: output contains attribution source tag
  it('PN7: NUDGE_URL carries ?src=cli-nudge attribution tag', () => {
    expect(NUDGE_URL).toContain('?src=cli-nudge');
  });

  // PN8: copy is the swap-ready constant
  it('PN8: NUDGE_COPY is a non-empty string (swap-ready placeholder)', () => {
    expect(typeof NUDGE_COPY).toBe('string');
    expect(NUDGE_COPY.length).toBeGreaterThan(0);
  });
});
