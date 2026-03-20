/**
 * Telemetry routes
 *
 * GET  /telemetry          — HTML team dashboard (auth required)
 * GET  /telemetry/dashboard — JSON aggregate stats (auth required)
 * GET  /telemetry/status   — Public opt-in status
 * GET  /telemetry/privacy  — Public machine-readable privacy policy
 */

import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getTelemetryStore } from '../store/telemetry.js';

// ── HTML dashboard ────────────────────────────────────────────────────────────

const TELEMETRY_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Faultline Pro — Telemetry Dashboard</title>
<style>
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3a;--text:#e2e8f0;--muted:#718096;--green:#48bb78;--yellow:#ecc94b;--red:#fc8181;--blue:#63b3ed;--accent:#7c3aed;--accent-light:#a78bfa}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding-bottom:60px}
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:20px 0}
.container{max-width:1000px;margin:0 auto;padding:0 24px}
.header-inner{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.logo{font-size:18px;font-weight:700;letter-spacing:-.5px}
.logo span{color:var(--accent)}
.header-sub{font-size:13px;color:var(--muted)}
.nav{margin-left:auto;display:flex;gap:14px;font-size:13px;color:var(--muted)}
.nav a{color:var(--blue);text-decoration:none}
.refresh-label{font-size:12px;color:var(--muted)}
#opt-in-banner{background:#1a2a1a;border:1px solid #2a4a2a;border-radius:8px;padding:14px 18px;margin-top:24px;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--green);display:none}
#opt-out-banner{background:#2a1a1a;border:1px solid var(--red);border-radius:8px;padding:14px 18px;margin-top:24px;font-size:13px;color:var(--red);display:none}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px}
.card-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:8px}
.card-value{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
.card-sub{font-size:12px;color:var(--muted);margin-top:4px}
.section{margin-top:28px}
.section-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:12px}
.table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.table th,.table td{padding:10px 14px;text-align:left;font-size:13px}
.table th{background:rgba(255,255,255,.03);font-weight:600;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.table tr+tr td{border-top:1px solid var(--border)}
.bar-wrap{display:flex;align-items:center;gap:8px}
.bar{height:6px;border-radius:3px;background:var(--accent);min-width:2px}
.pct{font-size:12px;color:var(--muted)}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
.badge-ok{background:#1a3a2a;color:var(--green)}
.badge-warn{background:#3a2a1a;color:var(--yellow)}
.badge-off{background:#2a2a2a;color:var(--muted)}
.sparkline-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px}
#sparkline{width:100%;height:60px}
.privacy-box{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px;margin-top:28px}
.privacy-box h3{font-size:13px;font-weight:600;margin-bottom:10px;color:var(--accent-light)}
.privacy-items{display:flex;flex-wrap:wrap;gap:8px}
.privacy-item{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);background:rgba(255,255,255,.03);padding:4px 10px;border-radius:4px;border:1px solid var(--border)}
.privacy-item .tick{color:var(--green)}
.privacy-item .cross{color:var(--red)}
.loading{color:var(--muted);font-size:13px;padding:40px 0;text-align:center}
#error-msg{display:none;background:#2a1a1a;border:1px solid var(--red);border-radius:8px;padding:12px 16px;color:var(--red);font-size:13px;margin-top:16px}
</style>
</head>
<body>
<div class="header">
  <div class="container">
    <div class="header-inner">
      <span class="logo"><span>fault</span>line pro</span>
      <span class="header-sub">Telemetry Dashboard</span>
      <div class="nav">
        <a href="/status">Status</a>
        <a href="/changelog">Changelog</a>
        <a href="/telemetry/privacy">Privacy</a>
      </div>
      <span class="refresh-label" id="refresh-label">Refreshing in 60s</span>
    </div>
  </div>
</div>

<div class="container">
  <div id="error-msg"></div>
  <div id="opt-in-banner">✓ Telemetry is enabled — collecting anonymous usage statistics</div>
  <div id="opt-out-banner">Telemetry is <strong>disabled</strong> — set FAULTLINE_TELEMETRY=1 to enable anonymous usage statistics</div>

  <div class="grid" id="stat-cards">
    <div class="loading">Loading telemetry data…</div>
  </div>

  <div class="section">
    <div class="section-title">Scans per hour — last 24 hours</div>
    <div class="sparkline-wrap">
      <div id="sparkline-area"><div class="loading" style="padding:16px 0">Collecting data…</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Provider breakdown</div>
    <div id="providers-table"><div class="loading">…</div></div>
  </div>

  <div class="section" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
    <div>
      <div class="section-title">Risk distribution</div>
      <div id="risk-table"></div>
    </div>
    <div>
      <div class="section-title">Latency buckets</div>
      <div id="latency-table"></div>
    </div>
  </div>

  <div class="privacy-box">
    <h3>Privacy guarantees</h3>
    <div class="privacy-items" id="privacy-items">…</div>
  </div>
</div>

<script>
let countdown = 60;
let timer;

function fmt(n, dec=0){return(n??0).toLocaleString(undefined,{maximumFractionDigits:dec});}

function bar(val,max){
  const pct=max>0?Math.round(val/max*100):0;
  return \`<div class="bar-wrap"><div class="bar" style="width:\${Math.max(pct,2)}px"></div><span class="pct">\${pct}%</span></div>\`;
}

function simpleTable(rows, headers){
  if(!rows||!rows.length) return '<div class="loading" style="padding:12px 0">No data</div>';
  return \`<table class="table">
    <thead><tr>\${headers.map(h=>\`<th>\${h}</th>\`).join('')}</tr></thead>
    <tbody>\${rows.map(r=>\`<tr>\${r.map(c=>\`<td>\${c}</td>\`).join('')}</tr>\`).join('')}</tbody>
  </table>\`;
}

function sparkline(hours){
  const counts=hours.map(h=>h.count);
  const maxVal=Math.max(...counts,1);
  const W=960,H=50;
  const step=W/(counts.length-1||1);
  const y=v=>H-(v/maxVal)*(H-4);
  if(counts.every(c=>c===0)) return '<div class="loading" style="padding:12px 0">No scans recorded yet</div>';
  const pts=counts.map((v,i)=>\`\${(i*step).toFixed(1)},\${y(v).toFixed(1)}\`).join(' ');
  const area=counts.map((v,i)=>(i===0?\`M\${(i*step).toFixed(1)},\${H}\`:\`\`)+\`L\${(i*step).toFixed(1)},\${y(v).toFixed(1)}\`).join(' ')+\`L\${W},\${H} Z\`;
  return \`<svg viewBox="0 0 \${W} \${H}" preserveAspectRatio="none" style="width:100%;height:60px">
    <defs><linearGradient id="tg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#7c3aed" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#7c3aed" stop-opacity="0.02"/>
    </linearGradient></defs>
    <path d="\${area}" fill="url(#tg)"/>
    <polyline points="\${pts}" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>\`;
}

async function load(apiKey){
  try{
    const r=await fetch('/telemetry/dashboard',{headers:{'x-api-key':apiKey}});
    if(!r.ok){
      document.getElementById('error-msg').style.display='block';
      document.getElementById('error-msg').textContent=r.status===401?'Enter a valid API key in the URL: /telemetry?key=YOUR_API_KEY':'Error '+r.status;
      return;
    }
    document.getElementById('error-msg').style.display='none';
    const d=await r.json();
    render(d);
  }catch(e){
    document.getElementById('error-msg').style.display='block';
    document.getElementById('error-msg').textContent='Failed to load: '+e.message;
  }
}

function render(d){
  // Banners
  document.getElementById('opt-in-banner').style.display=d.optInEnabled?'flex':'none';
  document.getElementById('opt-out-banner').style.display=d.optInEnabled?'none':'block';

  // Stat cards
  const errPct=d.optInEnabled?fmt(d.totals.errorRate*100,1)+'%':'—';
  document.getElementById('stat-cards').innerHTML=\`
    <div class="card"><div class="card-title">Total Events</div><div class="card-value">\${fmt(d.totals.events)}</div><div class="card-sub">all time</div></div>
    <div class="card"><div class="card-title">Cache Hit Rate</div><div class="card-value">\${d.totals.events>0?fmt(d.totals.cacheHits/d.totals.events*100,1)+'%':'—'}</div><div class="card-sub">\${fmt(d.totals.cacheHits)} hits</div></div>
    <div class="card"><div class="card-title">Error Rate</div><div class="card-value" style="color:\${d.totals.errorRate>0.1?'var(--red)':'var(--green)'}">\${errPct}</div><div class="card-sub">\${fmt(d.totals.errors)} errors</div></div>
    <div class="card"><div class="card-title">Avg Claims/Scan</div><div class="card-value">\${d.optInEnabled?fmt(d.avgClaimsPerScan,1):'—'}</div></div>
  \`;

  // Sparkline
  document.getElementById('sparkline-area').innerHTML=sparkline(d.hourly);

  // Providers
  const provEntries=Object.entries(d.providers).sort((a,b)=>b[1].count-a[1].count);
  const maxProv=provEntries.length>0?provEntries[0][1].count:1;
  document.getElementById('providers-table').innerHTML=simpleTable(
    provEntries.map(([name,s])=>[
      \`<strong>\${name}</strong>\`,
      fmt(s.count),
      bar(s.count,maxProv),
      \`<span class="badge \${s.errorRate>0.1?'badge-warn':'badge-ok'}">\${fmt(s.errorRate*100,1)}% errors</span>\`,
    ]),
    ['Provider','Scans','Share','Error Rate']
  );

  // Risk
  const riskOrder=['low','medium','high','critical'];
  const riskColors={'low':'var(--green)','medium':'var(--yellow)','high':'var(--red)','critical':'var(--red)'};
  const riskTotal=Object.values(d.riskDistribution).reduce((s,v)=>s+v,0)||1;
  document.getElementById('risk-table').innerHTML=simpleTable(
    riskOrder.filter(r=>d.riskDistribution[r]!==undefined).map(r=>[
      \`<span style="color:\${riskColors[r]||'var(--text)'}">\${r}</span>\`,
      fmt(d.riskDistribution[r]||0),
      bar(d.riskDistribution[r]||0,riskTotal),
    ]),
    ['Level','Count','Share']
  );

  // Latency
  const latOrder=['<100ms','100-500ms','500ms-2s','>2s'];
  const latTotal=Object.values(d.latencyDistribution).reduce((s,v)=>s+v,0)||1;
  document.getElementById('latency-table').innerHTML=simpleTable(
    latOrder.filter(k=>d.latencyDistribution[k]!==undefined).map(k=>[
      \`<code style="font-size:12px">\${k}</code>\`,
      fmt(d.latencyDistribution[k]||0),
      bar(d.latencyDistribution[k]||0,latTotal),
    ]),
    ['Bucket','Count','Share']
  );

  // Privacy
  const p=d.privacy;
  const items=[
    [true,'No text content recorded'],
    [true,'No user identity stored'],
    [true,'No IP addresses'],
    [true,'Timestamps truncated to hour'],
    [true,'In-memory only (cleared on restart)'],
    [true,'Opt-in required (FAULTLINE_TELEMETRY=1)'],
  ];
  document.getElementById('privacy-items').innerHTML=items.map(([ok,label])=>
    \`<div class="privacy-item"><span class="\${ok?'tick':'cross'}">\${ok?'✓':'✗'}</span>\${label}</div>\`
  ).join('');
}

// Extract API key from query param or prompt
const params=new URLSearchParams(location.search);
const apiKey=params.get('key')||localStorage.getItem('fl_api_key')||'';
if(apiKey) localStorage.setItem('fl_api_key',apiKey);

if(!apiKey){
  document.getElementById('error-msg').style.display='block';
  document.getElementById('error-msg').textContent='Pass your API key: /telemetry?key=YOUR_API_KEY';
}else{
  load(apiKey);
  timer=setInterval(()=>{
    countdown--;
    const lbl=document.getElementById('refresh-label');
    if(countdown<=0){
      lbl.textContent='Refreshing…';
      load(apiKey).then(()=>{countdown=60;lbl.textContent='Refreshing in 60s';});
    }else{
      lbl.textContent='Refreshing in '+countdown+'s';
    }
  },1000);
}
</script>
</body>
</html>`;

// ── Routes ────────────────────────────────────────────────────────────────────

export async function telemetryRoutes(fastify: FastifyInstance): Promise<void> {
  // HTML dashboard — auth handled client-side via ?key= param + JSON fetch
  fastify.get('/telemetry', {
    schema: { tags: ['Analytics'], summary: 'HTML telemetry dashboard (team view)' },
  }, async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return TELEMETRY_HTML;
  });

  // JSON aggregate stats — auth required
  fastify.get('/telemetry/dashboard', {
    preHandler: [requireApiKey],
    schema: { tags: ['Analytics'], summary: 'JSON telemetry aggregate stats (auth required)' },
  }, async () => {
    return getTelemetryStore().getDashboard();
  });

  // Public opt-in status
  fastify.get('/telemetry/status', {
    schema: { tags: ['Analytics'], summary: 'Telemetry opt-in status (public)' },
  }, async () => {
    return {
      enabled: getTelemetryStore().isEnabled(),
      enableWith: 'Set FAULTLINE_TELEMETRY=1 environment variable to enable opt-in telemetry.',
      privacyPolicy: '/telemetry/privacy',
    };
  });

  // Machine-readable privacy policy
  fastify.get('/telemetry/privacy', {
    schema: { tags: ['Analytics'], summary: 'Machine-readable telemetry privacy policy (public)' },
  }, async () => {
    return {
      version: '1.0',
      lastUpdated: '2026-03-20',
      optIn: {
        mechanism: 'environment variable',
        variable: 'FAULTLINE_TELEMETRY',
        value: '1',
        default: 'disabled',
      },
      collectedFields: [
        { field: 'provider',            description: 'Which LLM provider processed the scan', example: 'gemini' },
        { field: 'riskLevel',           description: 'Overall risk verdict', example: 'low' },
        { field: 'claimCount',          description: 'Number of claims extracted', example: 3 },
        { field: 'claimTypes',          description: 'Distribution of claim types (no text)', example: { fact: 2, opinion: 1 } },
        { field: 'latencyBucket',       description: 'Request latency bracket', example: '100-500ms' },
        { field: 'inputLengthBucket',   description: 'Input character count bracket (not exact)', example: '500-2000' },
        { field: 'cacheHit',            description: 'Whether the result was served from cache', example: false },
        { field: 'hour',                description: 'Timestamp truncated to the hour (no minutes/seconds)', example: '2026-03-20T22:00:00.000Z' },
        { field: 'errorCode',           description: 'HTTP status code for failed scans only', example: 500 },
      ],
      neverCollectedFields: [
        'text content of any scan input',
        'keyId or any user identifier',
        'IP address or network information',
        'exact timestamps (minutes/seconds)',
        'exact input character count',
        'file names',
        'claim text or explanations',
        'source URLs from verifications',
      ],
      retention: {
        storage: 'in-memory only',
        persistedToDisk: false,
        sentToExternalService: false,
        clearedOn: 'server restart',
      },
    };
  });
}
