/**
 * assert-prompt-fidelity.ts — GATE G1 (runnable, fail-loud).
 *
 * Run:  npx tsx scripts/assert-prompt-fidelity.ts
 * Exit 0 = every call-type's harness prompt matches the engine's real prompt.
 * Exit 1 = a mismatch/capture failure → STOP, NO SPEND (per Wolf G1).
 *
 * Method per call-type:
 *  - grounded-verify:openai/claude — IMPORTED-CLEANLY: the providers import the
 *    shared `buildGroundedPrompt` (grounded_prompt.ts). We assert the captured
 *    request body's message text === buildGroundedPrompt(sample) → equality by
 *    construction (the provider literally calls the fn we import).
 *  - extraction / web_search / grounded-verify:gemini — prompt is INLINED in an
 *    impure engine fn (not exported). We cannot statically import it, so fidelity
 *    is proven by RUNTIME CAPTURE of the engine's own emitted request (executing
 *    the engine's real code) + structural anchors + determinism across two runs.
 *    No reimplementation, no copy-paste.
 */

import { captureAll, SAMPLE, extractPrompt, type CallType } from './consensus-cost/capture';
import { buildGroundedPrompt } from '../packages/cli/providers/grounded_prompt';

interface Check { callType: CallType; verdict: 'IMPORTED-CLEANLY' | 'CAPTURED-RUNTIME'; pass: boolean; detail: string; }

function anchorsPresent(text: string, anchors: string[]): string[] {
  return anchors.filter((a) => !text.includes(a));
}

async function main(): Promise<void> {
  const run1 = await captureAll();
  const run2 = await captureAll(); // determinism cross-run
  const checks: Check[] = [];

  // --- grounded-verify:openai / claude — IMPORTED-CLEANLY (true equality) ---
  const expectedGrounded = buildGroundedPrompt(SAMPLE.claim, SAMPLE.sources);
  for (const ct of ['grounded-verify:openai', 'grounded-verify:claude'] as CallType[]) {
    const got = run1[ct]?.prompt ?? '';
    checks.push({
      callType: ct,
      verdict: 'IMPORTED-CLEANLY',
      pass: got === expectedGrounded && got.length > 0,
      detail: got === expectedGrounded ? `equals buildGroundedPrompt() (${got.length} chars)` : 'MISMATCH vs imported buildGroundedPrompt()',
    });
  }

  // --- extraction — CAPTURED-RUNTIME (inlined; anchors + determinism) ---
  {
    const p = run1.extraction?.prompt ?? '';
    const missing = anchorsPresent(p, ['atomic claims', 'CRITICAL RULE', SAMPLE.extractionText]);
    const deterministic = p === (run2.extraction?.prompt ?? '');
    checks.push({ callType: 'extraction', verdict: 'CAPTURED-RUNTIME', pass: p.length > 0 && missing.length === 0 && deterministic, detail: p.length === 0 ? 'EMPTY capture' : missing.length ? `missing anchors: ${missing.join(', ')}` : deterministic ? `captured ${p.length} chars, anchors ok, deterministic` : 'NON-DETERMINISTIC across runs' });
  }

  // --- web_search — CAPTURED-RUNTIME (inlined; anchors + determinism) ---
  {
    const p = run1.web_search?.prompt ?? '';
    const missing = anchorsPresent(p, ['CONFIRM or REFUTE', SAMPLE.claim.text]);
    const deterministic = p === (run2.web_search?.prompt ?? '');
    checks.push({ callType: 'web_search', verdict: 'CAPTURED-RUNTIME', pass: p.length > 0 && missing.length === 0 && deterministic, detail: p.length === 0 ? 'EMPTY capture' : missing.length ? `missing anchors: ${missing.join(', ')}` : deterministic ? `captured ${p.length} chars, anchors ok, deterministic` : 'NON-DETERMINISTIC across runs' });
  }

  // --- grounded-verify:gemini — CAPTURED-RUNTIME (own inlined grounded prompt) ---
  {
    const p = run1['grounded-verify:gemini']?.prompt ?? '';
    const deterministic = p === (run2['grounded-verify:gemini']?.prompt ?? '');
    checks.push({ callType: 'grounded-verify:gemini', verdict: 'CAPTURED-RUNTIME', pass: p.length > 0 && p.includes(SAMPLE.claim.text) && deterministic, detail: p.length === 0 ? 'EMPTY capture' : deterministic ? `captured ${p.length} chars, claim present, deterministic` : 'NON-DETERMINISTIC' });
  }

  // Report
  console.log('\nGATE G1 — PROMPT FIDELITY\n' + '='.repeat(60));
  let allPass = true;
  for (const c of checks) {
    const mark = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${mark}] ${c.callType.padEnd(24)} ${c.verdict.padEnd(18)} ${c.detail}`);
  }
  console.log('='.repeat(60));

  if (!allPass) {
    console.error('\nG1 FAILED — prompt fidelity NOT proven. STOP: no paid matrix run.');
    process.exit(1);
  }
  console.log('\nG1 PASSED — harness prompts == engine prompts by construction. Spend gate may open (after G2).');
}

main().catch((e) => { console.error('G1 harness error:', e); process.exit(1); });
