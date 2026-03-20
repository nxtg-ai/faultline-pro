/**
 * API Playground (D-167)
 *
 * GET /playground — interactive web UI for testing scan endpoints live
 */

import type { FastifyInstance } from 'fastify';

// ── Sample data ───────────────────────────────────────────────────────────────

const SAMPLES = [
  {
    label: 'AI Revenue Claim',
    text: 'Our AI model increased revenue by 312% in Q3 2024, outperforming every competitor by 10x while reducing costs to near zero.',
  },
  {
    label: 'Medical Research',
    text: 'A new study published last week proves that daily vitamin C supplementation eliminates the risk of all cancers with 99.9% efficacy.',
  },
  {
    label: 'Climate Statistics',
    text: 'Global temperatures have risen by exactly 4.7°C since 1990, causing 85% of all extreme weather events and displacing 2 billion people.',
  },
  {
    label: 'Product Launch',
    text: 'Our platform serves 50 million active users daily, processes 1 trillion requests per second, and has achieved 100% uptime since launch.',
  },
  {
    label: 'Financial Report',
    text: 'The company reported $8.2B in ARR for FY2024, a 180% YoY growth, with EBITDA margins exceeding 45% across all segments.',
  },
];

// ── HTML builder ─────────────────────────────────────────────────────────────

function buildPlaygroundHtml(): string {
  const samplesJson = JSON.stringify(SAMPLES);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Faultline Pro — API Playground</title>
<style>
  :root{--bg:#0f1117;--surface:#1a1d27;--surface2:#22263a;--border:#2d3148;--accent:#6c63ff;--accent2:#00c9a7;--warn:#f5a623;--danger:#e05c5c;--text:#e2e4f0;--text-muted:#7a7f99;--r:10px}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:14px;min-height:100vh;display:flex;flex-direction:column}
  header{padding:16px 28px;border-bottom:1px solid var(--border);background:var(--surface);display:flex;align-items:center;gap:12px;flex-shrink:0}
  header h1{font-size:17px;font-weight:700}
  .badge{background:var(--accent);color:#fff;font-size:10px;padding:2px 7px;border-radius:99px;font-weight:700;letter-spacing:.3px}
  .layout{display:grid;grid-template-columns:420px 1fr;flex:1;overflow:hidden}
  @media(max-width:860px){.layout{grid-template-columns:1fr;overflow:auto}}
  .panel{display:flex;flex-direction:column;overflow:hidden}
  .panel-header{padding:14px 20px;border-bottom:1px solid var(--border);font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;flex-shrink:0;display:flex;align-items:center;gap:8px}
  .panel-body{padding:20px;overflow-y:auto;flex:1}
  .left{border-right:1px solid var(--border)}

  /* Form elements */
  label{display:block;font-size:12px;color:var(--text-muted);margin-bottom:5px;font-weight:500}
  textarea,select,input[type=text],input[type=password]{width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:10px 12px;font-size:13px;font-family:inherit;outline:none;transition:border-color .15s}
  textarea:focus,select:focus,input:focus{border-color:var(--accent)}
  textarea{resize:vertical;min-height:140px;line-height:1.5}
  select option{background:var(--surface2)}
  .form-row{margin-bottom:16px}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}

  /* Samples */
  .samples-title{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
  .sample-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px}
  .chip{background:var(--surface2);border:1px solid var(--border);border-radius:99px;padding:4px 12px;font-size:12px;cursor:pointer;transition:all .15s;white-space:nowrap}
  .chip:hover{border-color:var(--accent);color:var(--accent)}

  /* Auth */
  .auth-row{display:flex;align-items:center;gap:8px}
  .auth-row input{flex:1}
  .auth-pill{font-size:11px;padding:3px 9px;border-radius:99px;flex-shrink:0}
  .auth-pill.ok{background:rgba(0,201,167,.15);color:var(--accent2);border:1px solid rgba(0,201,167,.3)}
  .auth-pill.warn{background:rgba(245,166,35,.12);color:var(--warn);border:1px solid rgba(245,166,35,.3)}

  /* Run button */
  .run-btn{width:100%;padding:12px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:opacity .15s;margin-top:4px}
  .run-btn:hover{opacity:.88}
  .run-btn:disabled{opacity:.45;cursor:not-allowed}
  .spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;display:none}
  .run-btn.loading .spinner{display:block}
  .run-btn.loading .btn-label{display:none}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* Result panels */
  .result-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);gap:12px;text-align:center;padding:40px}
  .result-empty svg{opacity:.3}
  .result-empty p{font-size:13px;line-height:1.5;max-width:280px}
  .result-tabs{display:flex;gap:2px;padding:12px 20px 0;border-bottom:1px solid var(--border);flex-shrink:0}
  .tab{padding:8px 14px;border-radius:6px 6px 0 0;font-size:12px;font-weight:600;cursor:pointer;color:var(--text-muted);border:1px solid transparent;border-bottom:none;transition:all .15s;position:relative;top:1px}
  .tab.active{background:var(--surface2);color:var(--text);border-color:var(--border)}
  .tab-pane{display:none;padding:20px;overflow-y:auto;flex:1}
  .tab-pane.active{display:block}

  /* Risk badge */
  .risk{display:inline-flex;align-items:center;gap:6px;padding:5px 14px;border-radius:99px;font-size:13px;font-weight:700;margin-bottom:16px}
  .risk.low{background:rgba(0,201,167,.15);color:#00c9a7;border:1px solid rgba(0,201,167,.3)}
  .risk.medium{background:rgba(245,166,35,.15);color:#f5a623;border:1px solid rgba(245,166,35,.3)}
  .risk.high{background:rgba(249,115,22,.15);color:#f97316;border:1px solid rgba(249,115,22,.3)}
  .risk.critical{background:rgba(224,92,92,.15);color:#e05c5c;border:1px solid rgba(224,92,92,.3)}

  /* Claim cards */
  .claim-card{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;margin-bottom:10px}
  .claim-header{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .verdict{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;text-transform:uppercase;letter-spacing:.4px}
  .verdict.supported{background:rgba(0,201,167,.15);color:#00c9a7}
  .verdict.contradicted{background:rgba(224,92,92,.15);color:#e05c5c}
  .verdict.unverified{background:rgba(122,127,153,.15);color:#7a7f99}
  .verdict.mixed{background:rgba(245,166,35,.15);color:#f5a623}
  .claim-type{font-size:11px;color:var(--text-muted);background:var(--surface);padding:2px 7px;border-radius:4px}
  .claim-text{font-size:13px;line-height:1.5;color:var(--text)}
  .claim-explanation{font-size:12px;color:var(--text-muted);margin-top:6px;line-height:1.4}
  .sources{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px}
  .source-chip{font-size:11px;background:rgba(108,99,255,.12);color:#a89fff;border:1px solid rgba(108,99,255,.25);border-radius:4px;padding:2px 8px}

  /* Stats row */
  .stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
  .stat{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;text-align:center}
  .stat .num{font-size:22px;font-weight:700;line-height:1}
  .stat .lbl{font-size:11px;color:var(--text-muted);margin-top:3px}

  /* JSON view */
  pre{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:16px;font-size:12px;line-height:1.6;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
  .key{color:#a89fff}.str{color:#79c0ff}.num2{color:#f5a623}.bool{color:#00c9a7}.null{color:#e05c5c}

  /* Request/response panel */
  .req-box{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:14px}
  .req-box .method{font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase}
  .req-box .url{font-size:12px;color:var(--text-muted);margin-top:2px;font-family:monospace}
  .req-box .timing{font-size:11px;color:var(--text-muted);margin-top:6px}
  .status-ok{color:var(--accent2)}
  .status-err{color:var(--danger)}

  /* Error */
  .error-box{background:rgba(224,92,92,.1);border:1px solid rgba(224,92,92,.3);border-radius:8px;padding:16px;color:#e05c5c;font-size:13px}
</style>
</head>
<body>
<header>
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#6c63ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <h1>Faultline Pro</h1>
  <span class="badge">Playground</span>
</header>

<div class="layout">
  <!-- LEFT: Input panel -->
  <div class="panel left">
    <div class="panel-header">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      Request
    </div>
    <div class="panel-body">
      <!-- Sample chips -->
      <div class="samples-title">Sample texts</div>
      <div class="sample-chips" id="chips"></div>

      <div class="form-row">
        <label for="txt">Text to scan</label>
        <textarea id="txt" placeholder="Paste or type text containing claims to verify…" rows="7"></textarea>
      </div>

      <div class="row2 form-row">
        <div>
          <label for="provider">Provider</label>
          <select id="provider">
            <option value="mock" selected>mock (instant demo)</option>
            <option value="gemini">gemini</option>
            <option value="openai">openai</option>
            <option value="claude">claude</option>
            <option value="perplexity">perplexity</option>
          </select>
        </div>
        <div>
          <label for="endpoint">Endpoint</label>
          <select id="endpoint">
            <option value="/scan">POST /scan</option>
            <option value="/scan/batch">POST /scan/batch</option>
            <option value="/scan/eu-report">POST /scan/eu-report</option>
            <option value="/scan/deep">POST /scan/deep</option>
          </select>
        </div>
      </div>

      <div class="form-row">
        <label for="apikey">API Key (optional)</label>
        <div class="auth-row">
          <input type="password" id="apikey" placeholder="Leave blank to use demo mode">
          <span class="auth-pill warn" id="auth-pill">demo</span>
        </div>
      </div>

      <button class="run-btn" id="run-btn" onclick="runScan()">
        <div class="spinner"></div>
        <span class="btn-label">▶ Run Scan</span>
      </button>

      <!-- Keyboard shortcut hint -->
      <div style="text-align:center;margin-top:10px;font-size:11px;color:var(--text-muted)">
        Press <kbd style="background:var(--surface2);padding:1px 6px;border-radius:3px;border:1px solid var(--border)">Ctrl+Enter</kbd> to run
      </div>
    </div>
  </div>

  <!-- RIGHT: Result panel -->
  <div class="panel" id="result-panel">
    <div id="result-empty" class="result-empty">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35M11 8v6M8 11h6"/></svg>
      <p>Enter some text on the left and click <strong>Run Scan</strong> to verify claims live against the Faultline API.</p>
    </div>

    <div id="result-content" style="display:none;flex-direction:column;height:100%">
      <div class="result-tabs">
        <div class="tab active" onclick="showTab('overview')">Overview</div>
        <div class="tab" onclick="showTab('claims')">Claims <span id="claims-count" style="font-size:11px;color:var(--text-muted)"></span></div>
        <div class="tab" onclick="showTab('raw')">Raw JSON</div>
        <div class="tab" onclick="showTab('request')">Request</div>
      </div>

      <!-- Overview tab -->
      <div class="tab-pane active" id="tab-overview">
        <div id="risk-badge"></div>
        <div class="stat-row" id="stat-row"></div>
        <div id="compliance-summary"></div>
      </div>

      <!-- Claims tab -->
      <div class="tab-pane" id="tab-claims">
        <div id="claims-list"></div>
      </div>

      <!-- Raw JSON tab -->
      <div class="tab-pane" id="tab-raw">
        <pre id="raw-json"></pre>
      </div>

      <!-- Request tab -->
      <div class="tab-pane" id="tab-request">
        <div class="req-box">
          <div class="method">POST</div>
          <div class="url" id="req-url"></div>
          <div class="timing" id="req-timing"></div>
        </div>
        <label style="font-size:12px;color:var(--text-muted);margin-bottom:6px;display:block">Request body</label>
        <pre id="req-body"></pre>
      </div>
    </div>
  </div>
</div>

<script>
const SAMPLES = ${samplesJson};

// Populate sample chips
const chipsEl = document.getElementById('chips');
SAMPLES.forEach((s, i) => {
  const chip = document.createElement('button');
  chip.className = 'chip';
  chip.textContent = s.label;
  chip.onclick = () => {
    document.getElementById('txt').value = s.text;
    document.querySelectorAll('.chip').forEach(c => c.style.borderColor = '');
    chip.style.borderColor = 'var(--accent)';
    chip.style.color = 'var(--accent)';
  };
  chipsEl.appendChild(chip);
  // Pre-load first sample
  if (i === 0) chip.click();
});

// Auth pill update
document.getElementById('apikey').addEventListener('input', e => {
  const val = e.target.value.trim();
  const pill = document.getElementById('auth-pill');
  if (val) {
    pill.textContent = '✓ key set';
    pill.className = 'auth-pill ok';
  } else {
    pill.textContent = 'demo';
    pill.className = 'auth-pill warn';
  }
});

// Ctrl+Enter shortcut
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runScan();
});

function showTab(name) {
  document.querySelectorAll('.tab, .tab-pane').forEach(el => el.classList.remove('active'));
  document.querySelector('[onclick="showTab(\\''+name+'\\')"]').classList.add('active');
  document.getElementById('tab-'+name).classList.add('active');
}

function riskClass(r) {
  if (!r) return 'low';
  const v = r.toLowerCase();
  if (v === 'critical') return 'critical';
  if (v === 'high') return 'high';
  if (v === 'medium') return 'medium';
  return 'low';
}

function verdictClass(v) {
  if (!v) return 'unverified';
  const lv = v.toLowerCase();
  if (lv === 'supported' || lv === 'verified') return 'supported';
  if (lv === 'contradicted') return 'contradicted';
  if (lv === 'mixed') return 'mixed';
  return 'unverified';
}

function colorJson(obj) {
  const str = JSON.stringify(obj, null, 2);
  return str
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(?:\\s*:)?|\b(true|false|null)\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g, match => {
      if (/^"/.test(match)) {
        if (/:$/.test(match)) return '<span class="key">'+match+'</span>';
        return '<span class="str">'+match+'</span>';
      }
      if (/true|false/.test(match)) return '<span class="bool">'+match+'</span>';
      if (/null/.test(match)) return '<span class="null">'+match+'</span>';
      return '<span class="num2">'+match+'</span>';
    });
}

async function runScan() {
  const text = document.getElementById('txt').value.trim();
  if (!text) { alert('Please enter some text to scan.'); return; }

  const provider = document.getElementById('provider').value;
  const endpoint = document.getElementById('endpoint').value;
  const apiKey   = document.getElementById('apikey').value.trim();

  const btn = document.getElementById('run-btn');
  btn.classList.add('loading');
  btn.disabled = true;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  let body;
  if (endpoint === '/scan/batch') {
    body = JSON.stringify({ texts: [text], provider });
  } else {
    body = JSON.stringify({ text, provider });
  }

  document.getElementById('req-url').textContent = window.location.origin + endpoint;
  document.getElementById('req-body').innerHTML = colorJson(JSON.parse(body));

  const t0 = Date.now();
  let data, statusCode;
  try {
    const res = await fetch(endpoint, { method: 'POST', headers, body });
    statusCode = res.status;
    const ct = res.headers.get('content-type') || '';

    if (ct.includes('application/pdf')) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      data = { _pdfGenerated: true, sizeBytes: blob.size };
    } else {
      data = await res.json();
    }
  } catch (err) {
    data = { error: String(err) };
    statusCode = 0;
  }

  const elapsed = Date.now() - t0;
  document.getElementById('req-timing').innerHTML =
    '<span class="'+(statusCode >= 200 && statusCode < 300 ? 'status-ok' : 'status-err')+'">'+statusCode+'</span>' +
    ' · ' + elapsed + ' ms';

  btn.classList.remove('loading');
  btn.disabled = false;

  renderResult(data, endpoint, elapsed, statusCode);
}

function renderResult(data, endpoint, elapsed, status) {
  document.getElementById('result-empty').style.display = 'none';
  const content = document.getElementById('result-content');
  content.style.display = 'flex';

  // Raw JSON always rendered
  document.getElementById('raw-json').innerHTML = colorJson(data);

  // If PDF or error — show raw only
  if (data._pdfGenerated) {
    document.getElementById('tab-overview').innerHTML =
      '<div style="padding:20px 0;color:var(--accent2)">✓ PDF generated ('+data.sizeBytes.toLocaleString()+' bytes) — opened in new tab.</div>';
    showTab('overview');
    return;
  }
  if (data.error || status >= 400) {
    document.getElementById('tab-overview').innerHTML =
      '<div class="error-box">'+
      '<strong>Error '+(status||'')+'</strong><br>'+
      (data.error || JSON.stringify(data, null, 2))+
      '</div>';
    showTab('overview');
    return;
  }

  // Determine the scan result (batch wraps in results[])
  const scan = endpoint === '/scan/batch' ? data.results?.[0] : data;

  // Overview
  const risk = scan?.overallRisk ?? 'unknown';
  const rc = riskClass(risk);
  const claims = scan?.claims ?? [];
  const verifs = scan?.verifications ?? {};

  const supported    = claims.filter(c => verifs[c.id]?.status === 'supported').length;
  const contradicted = claims.filter(c => verifs[c.id]?.status === 'contradicted').length;
  const unverified   = claims.filter(c => !['supported','contradicted'].includes(verifs[c.id]?.status)).length;

  document.getElementById('risk-badge').innerHTML =
    '<span class="risk '+rc+'">'+
    (rc === 'critical' ? '🚨' : rc === 'high' ? '⚠️' : rc === 'medium' ? '⚡' : '✓')+
    ' Risk: '+risk.toUpperCase()+'</span>';

  document.getElementById('stat-row').innerHTML =
    '<div class="stat"><div class="num">'+claims.length+'</div><div class="lbl">Claims</div></div>'+
    '<div class="stat"><div class="num" style="color:var(--accent2)">'+supported+'</div><div class="lbl">Supported</div></div>'+
    '<div class="stat"><div class="num" style="color:var(--danger)">'+contradicted+'</div><div class="lbl">Contradicted</div></div>'+
    '<div class="stat"><div class="num" style="color:var(--text-muted)">'+unverified+'</div><div class="lbl">Unverified</div></div>';

  // Compliance summary
  const comp = scan?.complianceReport;
  if (comp) {
    document.getElementById('compliance-summary').innerHTML =
      '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px 16px">'+
      '<div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Compliance</div>'+
      '<div style="font-size:13px">Risk tier: <strong>'+comp.riskTier+'</strong></div>'+
      (comp.findings?.length > 0
        ? '<div style="margin-top:6px;font-size:12px;color:var(--warn)">'+comp.findings.length+' finding(s)</div>'
        : '<div style="margin-top:6px;font-size:12px;color:var(--accent2)">✓ No compliance findings</div>')+
      '</div>';
  } else {
    document.getElementById('compliance-summary').innerHTML = '';
  }

  // Claims tab
  document.getElementById('claims-count').textContent = '('+claims.length+')';
  const claimHtml = claims.map(c => {
    const v = verifs[c.id] ?? {};
    const vc = verdictClass(v.status);
    const sources = (v.sources ?? []).map(s =>
      '<span class="source-chip">'+
      (s.title || (s.url ? new URL(s.url).hostname : 'source'))+'</span>'
    ).join('');
    return '<div class="claim-card">'+
      '<div class="claim-header">'+
        '<span class="verdict '+vc+'">'+( v.status || 'unverified')+'</span>'+
        (c.type ? '<span class="claim-type">'+c.type+'</span>' : '')+
      '</div>'+
      '<div class="claim-text">'+escHtml(c.text)+'</div>'+
      (v.explanation ? '<div class="claim-explanation">'+escHtml(v.explanation)+'</div>' : '')+
      (sources ? '<div class="sources">'+sources+'</div>' : '')+
    '</div>';
  }).join('') || '<div style="color:var(--text-muted);font-size:13px">No claims extracted.</div>';
  document.getElementById('claims-list').innerHTML = claimHtml;

  showTab('overview');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function playgroundRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/playground',
    {
      schema: {
        tags: ['Developer-X'],
        summary: 'Interactive API playground for live endpoint testing',
      },
    },
    async (_request, reply) => {
      return reply.type('text/html').send(buildPlaygroundHtml());
    },
  );
}
