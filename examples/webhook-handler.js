// webhook-handler.js — Receive Faultline webhook events
// Verifies HMAC-SHA256 signatures and handles scan.complete / claim.verdict_changed
// Usage: node examples/webhook-handler.js
// Then register: POST http://localhost:3000/webhooks with { url: "http://your-server/webhook", events: ["scan.complete"] }

import http from 'node:http';
import crypto from 'node:crypto';

const WEBHOOK_SECRET = process.env.FAULTLINE_WEBHOOK_SECRET ?? 'your-webhook-secret';
const PORT = 4000;

function verifySignature(body, signature) {
  const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const sig = req.headers['x-faultline-signature'] ?? '';
    if (!verifySignature(body, sig)) {
      console.warn('Invalid webhook signature — rejected');
      res.writeHead(401).end('Unauthorized');
      return;
    }

    const event = JSON.parse(body);
    console.log(`Event: ${event.event}`);

    if (event.event === 'scan.complete') {
      const { overallRisk, claims } = event.data;
      console.log(`  Risk: ${overallRisk}, Claims: ${claims?.length ?? 0}`);
      if (overallRisk === 'critical' || overallRisk === 'high') {
        console.warn('  High-risk scan — alert your team!');
      }
    }

    if (event.event === 'claim.verdict_changed') {
      const { claim, previousVerdict, currentVerdict } = event.data;
      console.warn(`  Verdict flip: "${claim.slice(0, 60)}" ${previousVerdict} -> ${currentVerdict}`);
    }

    res.writeHead(200).end('OK');
  });
});

server.listen(PORT, () => console.log(`Webhook receiver listening on :${PORT}`));
