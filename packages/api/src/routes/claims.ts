import type { FastifyInstance } from 'fastify';
import { getClaimIndex, computeAttributionConfidence } from '../store/claims.js';
import { escHtml } from '../lib/html.js';

export async function claimsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{
    Querystring: {
      text?: string;
      verdict?: string;
      from?: string;
      to?: string;
      source?: string;
      limit?: string;
    };
  }>(
    '/claims',
    {
      schema: {
        tags: ['Claims'],
        summary: 'Search claims by text, verdict, date, or source',
        querystring: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            verdict: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            source: { type: 'string' },
            limit: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { text, verdict, from, to, source, limit } = request.query;
      const limitNum = limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50;
      const results = getClaimIndex().search({ text, verdict, from, to, source, limit: limitNum });
      return reply.status(200).send({
        claims: results.map((r) => ({
          id: r.id,
          text: r.originalText,
          normalizedText: r.normalizedText,
          claimType: r.claimType,
          firstSeen: r.firstSeen,
          lastSeen: r.lastSeen,
          frequency: r.frequency,
          lastVerdict: r.lastVerdict,
          sourceCount: r.sources.length,
        })),
        total: results.length,
      });
    },
  );

  fastify.get('/claims/trending', { schema: { tags: ['Claims'], summary: 'Trending claims by frequency and emerging in last 24h' } }, async (_request, reply) => {
    const index = getClaimIndex();

    return reply.status(200).send({
      trending: index.getTrending(20).map((r) => ({
        text: r.originalText,
        normalizedText: r.normalizedText,
        frequency: r.frequency,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        lastVerdict: r.lastVerdict,
      })),
      emerging: index.getEmerging(10).map((r) => ({
        text: r.originalText,
        normalizedText: r.normalizedText,
        frequency: r.frequency,
        firstSeen: r.firstSeen,
        lastVerdict: r.lastVerdict,
      })),
      verdictChanged: index.getVerdictChanges(10),
    });
  });

  fastify.get<{ Params: { id: string } }>(
    '/claims/:id/attribution',
    {
      schema: {
        tags: ['Claims'],
        summary: 'Provenance chain and attribution confidence for a claim',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const record = getClaimIndex().getById(request.params.id);
      if (!record) {
        return reply.status(404).send({ error: 'Claim not found.' });
      }

      const attributionConfidence = computeAttributionConfidence(record);

      return reply.status(200).send({
        id: record.id,
        claim: record.originalText,
        claimType: record.claimType,
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
        frequency: record.frequency,
        lastVerdict: record.lastVerdict,
        attributionConfidence,
        attributionChain: {
          sources: record.sources,
          scanHistory: record.verdicts,
        },
      });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/claims/:id/explain',
    {
      schema: {
        tags: ['Claims'],
        summary: 'Reasoning chain and improvement suggestions for a claim',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const explanation = getClaimIndex().explain(request.params.id);
      if (!explanation) {
        return reply.status(404).send({ error: 'Claim not found.' });
      }
      return reply.status(200).send(explanation);
    },
  );

  /**
   * GET /claims/stats
   * Aggregate statistics across all indexed claims.
   */
  fastify.get(
    '/claims/stats',
    { schema: { tags: ['Claims'], summary: 'Aggregate statistics across all verified claims' } },
    async (_request, reply) => {
      return reply.send(getClaimIndex().getStats());
    },
  );

  /**
   * GET /claims/view
   * Full-featured claim database search UI.
   */
  fastify.get(
    '/claims/view',
    { schema: { tags: ['Claims'], summary: 'Claim database search UI (HTML)' } },
    async (_request, reply) => {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(buildClaimsHtml());
    },
  );
}

// ── HTML dashboard ─────────────────────────────────────────────────────────────

function buildClaimsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claim Database — Faultline Pro</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
  header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;gap:12px}
  header h1{font-size:1.1rem;font-weight:600;color:#58a6ff}
  .container{max-width:1400px;margin:0 auto;padding:24px;display:grid;grid-template-columns:1fr 300px;gap:24px}
  @media(max-width:900px){.container{grid-template-columns:1fr}}
  .main{}
  .sidebar{}

  /* Stats bar */
  .stats-bar{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
  @media(max-width:700px){.stats-bar{grid-template-columns:1fr 1fr}}
  .stat-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 16px;text-align:center}
  .stat-value{font-size:1.6rem;font-weight:700;color:#58a6ff;line-height:1}
  .stat-label{font-size:.72rem;color:#7d8590;margin-top:4px;text-transform:uppercase;letter-spacing:.04em}
  .stat-card.good .stat-value{color:#3fb950}
  .stat-card.warn .stat-value{color:#d29922}
  .stat-card.err  .stat-value{color:#f85149}

  /* Search */
  .search-panel{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
  .search-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
  .field{display:flex;flex-direction:column;gap:4px}
  .field label{font-size:.72rem;color:#7d8590;text-transform:uppercase;letter-spacing:.04em}
  .field input,.field select{background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:4px;padding:6px 10px;font-size:.85rem;outline:none}
  .field input:focus,.field select:focus{border-color:#58a6ff}
  .field.grow{flex:1;min-width:160px}
  .btn-search{background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 18px;font-size:.85rem;font-weight:600;cursor:pointer;align-self:flex-end}
  .btn-search:hover{background:#388bfd}
  .btn-clear{background:transparent;color:#58a6ff;border:1px solid #30363d;border-radius:4px;padding:6px 12px;font-size:.82rem;cursor:pointer;align-self:flex-end}
  .btn-clear:hover{border-color:#58a6ff}

  /* Results */
  .results-meta{font-size:.78rem;color:#7d8590;margin-bottom:10px;display:flex;align-items:center;gap:8px}
  .results-meta strong{color:#e6edf3}
  table{width:100%;border-collapse:collapse;font-size:.83rem}
  th{text-align:left;padding:8px 10px;border-bottom:2px solid #30363d;color:#8b949e;font-size:.71rem;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
  td{padding:8px 10px;border-bottom:1px solid #21262d;vertical-align:top}
  tr:hover td{background:#161b22;cursor:pointer}
  .claim-text{max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .claim-text.expanded{white-space:normal}

  /* Verdict badges */
  .vbadge{display:inline-block;padding:1px 8px;border-radius:3px;font-size:.68rem;font-weight:700;border:1px solid;white-space:nowrap}
  .v-supported{background:#122023;color:#3fb950;border-color:#3fb950}
  .v-contradicted{background:#3d1a1a;color:#f85149;border-color:#f85149}
  .v-unverified{background:#21262d;color:#7d8590;border-color:#7d8590}
  .v-mixed{background:#2d2010;color:#d29922;border-color:#d29922}
  .v-other{background:#21262d;color:#8b949e;border-color:#30363d}
  .type-badge{font-size:.68rem;color:#8b949e;background:#21262d;padding:1px 6px;border-radius:3px}

  /* Empty / loading */
  .empty{color:#7d8590;font-style:italic;padding:32px 0;text-align:center}
  #main-error{color:#f85149;font-size:.82rem;margin-top:10px;display:none}

  /* Sidebar */
  .sidebar-section{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:16px}
  .sidebar-section h3{font-size:.75rem;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px}
  .trend-item{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid #21262d}
  .trend-item:last-child{border-bottom:none}
  .trend-rank{font-size:.7rem;color:#7d8590;min-width:18px;padding-top:1px}
  .trend-text{font-size:.78rem;color:#e6edf3;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .trend-freq{font-size:.7rem;color:#58a6ff;font-weight:600;white-space:nowrap;padding-top:1px}
  .trend-item .vbadge{flex-shrink:0}
  .verdict-bar{margin-top:8px}
  .vbar-row{display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:.78rem}
  .vbar-label{width:90px;color:#8b949e;text-align:right}
  .vbar-track{flex:1;background:#21262d;border-radius:2px;height:8px;overflow:hidden}
  .vbar-fill{height:100%;border-radius:2px;transition:width .4s}
  .vbar-count{width:30px;text-align:right;color:#8b949e;font-size:.72rem}

  /* Pagination */
  .pagination{display:flex;gap:8px;margin-top:14px;align-items:center;font-size:.82rem}
  .page-btn{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:.82rem}
  .page-btn:disabled{opacity:.4;cursor:default}
  .page-btn:not(:disabled):hover{border-color:#58a6ff}
  #page-info{color:#7d8590}

  h2{font-size:.85rem;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
</style>
</head>
<body>
<header>
  <div style="font-size:1.2rem;font-weight:700;letter-spacing:-.02em"><span style="color:#f85149">fault</span>line pro</div>
  <h1>Claim Database</h1>
</header>

<div class="container">
  <!-- Main column -->
  <div class="main">

    <!-- Stats bar -->
    <div class="stats-bar" id="stats-bar">
      <div class="stat-card"><div class="stat-value" id="s-total">—</div><div class="stat-label">Total Claims</div></div>
      <div class="stat-card" id="sc-acc"><div class="stat-value" id="s-acc">—</div><div class="stat-label">Accuracy Rate</div></div>
      <div class="stat-card"><div class="stat-value" id="s-scans">—</div><div class="stat-label">Scans Indexed</div></div>
      <div class="stat-card"><div class="stat-value" id="s-verified">—</div><div class="stat-label">Verified Claims</div></div>
    </div>

    <!-- Search panel -->
    <div class="search-panel">
      <div class="search-row">
        <div class="field grow">
          <label>Search text</label>
          <input id="f-text" type="text" placeholder="e.g. revenue growth…" />
        </div>
        <div class="field">
          <label>Verdict</label>
          <select id="f-verdict">
            <option value="">All</option>
            <option value="supported">Supported</option>
            <option value="contradicted">Contradicted</option>
            <option value="unverified">Unverified</option>
            <option value="mixed">Mixed</option>
          </select>
        </div>
        <div class="field">
          <label>From date</label>
          <input id="f-from" type="date" />
        </div>
        <div class="field">
          <label>To date</label>
          <input id="f-to" type="date" />
        </div>
        <div class="field grow">
          <label>Source domain</label>
          <input id="f-source" type="text" placeholder="e.g. reuters.com" />
        </div>
        <button class="btn-search" onclick="runSearch(1)">Search</button>
        <button class="btn-clear" onclick="clearFilters()">Clear</button>
      </div>
    </div>

    <div class="results-meta" id="results-meta" style="display:none">
      <span>Showing <strong id="r-count">0</strong> results</span>
    </div>

    <div id="results-wrap"><p class="empty">Enter a search or browse all claims below.</p></div>
    <div id="main-error"></div>

    <div class="pagination" id="pagination" style="display:none">
      <button class="page-btn" id="btn-prev" onclick="changePage(-1)" disabled>← Prev</button>
      <span id="page-info"></span>
      <button class="page-btn" id="btn-next" onclick="changePage(1)">Next →</button>
    </div>
  </div>

  <!-- Sidebar -->
  <div class="sidebar">

    <div class="sidebar-section" id="sidebar-trending">
      <h3>Trending Claims</h3>
      <div id="trending-list"><p class="empty" style="padding:12px 0">Loading…</p></div>
    </div>

    <div class="sidebar-section" id="sidebar-emerging">
      <h3>Emerging (last 24h)</h3>
      <div id="emerging-list"><p class="empty" style="padding:12px 0">Loading…</p></div>
    </div>

    <div class="sidebar-section">
      <h3>Verdict Breakdown</h3>
      <div id="verdict-bar" class="verdict-bar"></div>
    </div>

  </div>
</div>

<script>
const PAGE_SIZE = 25;
let allResults = [];
let currentPage = 1;

function verdictClass(v) {
  const m = { supported: 'v-supported', contradicted: 'v-contradicted', unverified: 'v-unverified', mixed: 'v-mixed' };
  return m[v] || 'v-other';
}

function verdictLabel(v) {
  return (v || 'unknown').toUpperCase();
}

function fmt(iso) {
  if (!iso) return '—';
  return iso.slice(0, 10);
}


// ── Stats ──────────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const d = await fetch('/claims/stats').then(r => r.json());
    document.getElementById('s-total').textContent = d.totalClaims.toLocaleString();
    document.getElementById('s-scans').textContent = d.totalScans.toLocaleString();
    const acc = (d.accuracyRate * 100).toFixed(1) + '%';
    document.getElementById('s-acc').textContent = acc;
    const accCard = document.getElementById('sc-acc');
    if      (d.accuracyRate >= 0.7) accCard.classList.add('good');
    else if (d.accuracyRate >= 0.4) accCard.classList.add('warn');
    else                            accCard.classList.add('err');
    document.getElementById('s-verified').textContent = (d.byVerdict['supported'] || 0).toLocaleString();

    // Verdict bar
    const total = d.totalClaims || 1;
    const verdicts = [
      { label: 'Supported',    key: 'supported',    color: '#3fb950' },
      { label: 'Contradicted', key: 'contradicted', color: '#f85149' },
      { label: 'Unverified',   key: 'unverified',   color: '#7d8590' },
      { label: 'Mixed',        key: 'mixed',        color: '#d29922' },
    ];
    document.getElementById('verdict-bar').innerHTML = verdicts.map(v => {
      const count = d.byVerdict[v.key] || 0;
      const pct   = Math.round(count / total * 100);
      return \`<div class="vbar-row">
        <span class="vbar-label">\${escHtml(v.label)}</span>
        <div class="vbar-track"><div class="vbar-fill" style="width:\${pct}%;background:\${v.color}"></div></div>
        <span class="vbar-count">\${count}</span>
      </div>\`;
    }).join('');
  } catch(e) {
    console.error('Stats load failed', e);
  }
}

// ── Trending / Emerging ────────────────────────────────────────────────────────
async function loadSidebar() {
  try {
    const d = await fetch('/claims/trending').then(r => r.json());

    document.getElementById('trending-list').innerHTML = d.trending.length === 0
      ? '<p class="empty" style="padding:12px 0">No claims yet.</p>'
      : d.trending.map((c, i) => \`<div class="trend-item" onclick="filterByText('\${escHtml(c.text.slice(0,30))}')">
          <span class="trend-rank">\${i + 1}</span>
          <span class="trend-text" title="\${escHtml(c.text)}">\${escHtml(c.text.slice(0, 60))}\${c.text.length > 60 ? '…' : ''}</span>
          <span class="trend-freq">×\${c.frequency}</span>
          <span class="vbadge \${verdictClass(c.lastVerdict)}" style="font-size:.6rem">\${verdictLabel(c.lastVerdict)}</span>
        </div>\`).join('');

    document.getElementById('emerging-list').innerHTML = d.emerging.length === 0
      ? '<p class="empty" style="padding:12px 0">None in last 24h.</p>'
      : d.emerging.map(c => \`<div class="trend-item">
          <span class="trend-text" title="\${escHtml(c.text)}">\${escHtml(c.text.slice(0, 70))}\${c.text.length > 70 ? '…' : ''}</span>
          <span class="vbadge \${verdictClass(c.lastVerdict)}" style="font-size:.6rem">\${verdictLabel(c.lastVerdict)}</span>
        </div>\`).join('');
  } catch(e) {
    document.getElementById('trending-list').innerHTML = '<p class="empty" style="padding:8px 0">Failed to load.</p>';
  }
}

// ── Search ─────────────────────────────────────────────────────────────────────
async function runSearch(page) {
  currentPage = page || 1;
  const params = new URLSearchParams();
  const text    = document.getElementById('f-text').value.trim();
  const verdict = document.getElementById('f-verdict').value;
  const from    = document.getElementById('f-from').value;
  const to      = document.getElementById('f-to').value;
  const source  = document.getElementById('f-source').value.trim();
  if (text)    params.set('text',    text);
  if (verdict) params.set('verdict', verdict);
  if (from)    params.set('from',    from);
  if (to)      params.set('to',      to);
  if (source)  params.set('source',  source);
  params.set('limit', '200');

  try {
    const d = await fetch('/claims?' + params.toString()).then(r => r.json());
    allResults = d.claims || [];
    renderPage();
    loadStats();  // refresh stats after search
    document.getElementById('main-error').style.display = 'none';
  } catch(e) {
    showError('Search failed: ' + e.message);
  }
}

function renderPage() {
  const start = (currentPage - 1) * PAGE_SIZE;
  const page  = allResults.slice(start, start + PAGE_SIZE);
  const total = allResults.length;

  document.getElementById('results-meta').style.display = '';
  document.getElementById('r-count').textContent = total.toLocaleString();

  if (total === 0) {
    document.getElementById('results-wrap').innerHTML = '<p class="empty">No claims match your filters.</p>';
    document.getElementById('pagination').style.display = 'none';
    return;
  }

  document.getElementById('results-wrap').innerHTML = \`<table>
    <thead><tr>
      <th>Claim Text</th><th>Type</th><th>Verdict</th><th>Sources</th><th>Frequency</th><th>First Seen</th><th>Last Seen</th>
    </tr></thead>
    <tbody>\${page.map(c => \`<tr onclick="this.querySelector('.claim-text').classList.toggle('expanded')">
      <td><span class="claim-text">\${escHtml(c.text)}</span></td>
      <td><span class="type-badge">\${escHtml(c.claimType || 'fact')}</span></td>
      <td><span class="vbadge \${verdictClass(c.lastVerdict)}">\${verdictLabel(c.lastVerdict)}</span></td>
      <td style="color:#58a6ff">\${c.sourceCount}</td>
      <td style="color:#58a6ff;font-weight:600">\${c.frequency}</td>
      <td style="color:#7d8590;font-size:.78rem">\${fmt(c.firstSeen)}</td>
      <td style="color:#7d8590;font-size:.78rem">\${fmt(c.lastSeen)}</td>
    </tr>\`).join('')}
    </tbody></table>\`;

  // Pagination controls
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages > 1) {
    document.getElementById('pagination').style.display = '';
    document.getElementById('btn-prev').disabled = currentPage <= 1;
    document.getElementById('btn-next').disabled = currentPage >= totalPages;
    document.getElementById('page-info').textContent = \`Page \${currentPage} of \${totalPages}\`;
  } else {
    document.getElementById('pagination').style.display = 'none';
  }
}

function changePage(delta) {
  const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
  const next = currentPage + delta;
  if (next < 1 || next > totalPages) return;
  currentPage = next;
  renderPage();
  window.scrollTo(0, 0);
}

function clearFilters() {
  ['f-text','f-from','f-to','f-source'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('f-verdict').value = '';
  allResults = [];
  document.getElementById('results-wrap').innerHTML = '<p class="empty">Filters cleared. Run a search or click Search to see all claims.</p>';
  document.getElementById('results-meta').style.display = 'none';
  document.getElementById('pagination').style.display = 'none';
}

function filterByText(text) {
  document.getElementById('f-text').value = text;
  runSearch(1);
}

function showError(msg) {
  const el = document.getElementById('main-error');
  el.textContent = msg;
  el.style.display = '';
}

// ── Init ───────────────────────────────────────────────────────────────────────
// Enter on text/source inputs triggers search
['f-text','f-source'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(1); });
});

loadStats();
loadSidebar();
runSearch(1);  // show all on load
</script>
</body>
</html>`;
}
