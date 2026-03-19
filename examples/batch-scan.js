// batch-scan.js — Batch scan multiple AI outputs via the Faultline API
// Requires: API server running at http://localhost:3000
// Usage: FAULTLINE_API_KEY=your-key node examples/batch-scan.js

const API_URL = process.env.FAULTLINE_API_URL ?? 'http://localhost:3000';
const API_KEY = process.env.FAULTLINE_API_KEY;

if (!API_KEY) {
  console.error('Set FAULTLINE_API_KEY environment variable');
  process.exit(1);
}

const texts = [
  'The Great Wall of China is visible from space.',
  'Humans use only 10% of their brains.',
  'Lightning never strikes the same place twice.',
  'The Earth is approximately 4.5 billion years old.',
];

const response = await fetch(`${API_URL}/scan/batch`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
  },
  body: JSON.stringify({ texts, provider: 'mock' }),
});

const { results } = await response.json();

console.log('Batch scan results:');
for (const [i, result] of results.entries()) {
  console.log(`  [${i + 1}] Risk: ${result.overallRisk.padEnd(8)} — "${texts[i].slice(0, 60)}"`);
}
