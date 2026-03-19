// basic-scan.js — Scan a string of AI-generated text
// Usage: node examples/basic-scan.js

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

const text = `
  The Eiffel Tower was built in 1889 and stands 324 meters tall.
  It attracts over 7 million visitors per year, making it the most visited paid monument in the world.
  Napoleon Bonaparte commissioned the tower for the 1889 World's Fair.
`;

// Write to a temp file and scan
const tmpFile = '/tmp/faultline-example.txt';
writeFileSync(tmpFile, text);

try {
  const result = execSync(
    `faultline scan --input ${tmpFile} --provider mock --output-format json`,
    { encoding: 'utf8' }
  );
  const report = JSON.parse(result);
  console.log('Risk level:', report.overallRisk);
  console.log('Claims found:', report.claims?.length ?? 0);
  console.log('Verified:', Object.values(report.verifications ?? {}).filter(v => v.status === 'verified').length);
} finally {
  unlinkSync(tmpFile);
}
