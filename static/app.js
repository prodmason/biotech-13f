'use strict';

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
const app = $('#app');

// Only the local server (server.py) has an API: the "Refresh data" endpoint. Pages read data.json.
async function api(path, opts) {
  const r = await fetch('api/' + path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

// Navigation can outrun slow requests; drop results that belong to a page we already left.
const STALE = Symbol('stale');
let routeSeq = 0;
async function load(path) {
  const seq = routeSeq;
  const data = await localApi(path);
  if (seq !== routeSeq) throw STALE;
  return data;
}

const nf = new Intl.NumberFormat('en-US');
const signed = (v, txt) => v > 0 ? `<span class="pos">+${txt}</span>` : v < 0 ? `<span class="neg">−${txt}</span>` : '0';
const fmt = {
  int: v => v == null ? '' : nf.format(Math.round(v)),
  k: v => v == null ? '' : nf.format(Math.round(v / 1000)),
  pct: (v, d = 2) => v == null ? '' : v > 0 && v * 100 < 0.5 * 10 ** -d ? `<${10 ** -d}%` : (v * 100).toFixed(d) + '%',
  sInt: v => v == null ? '' : signed(v, nf.format(Math.round(Math.abs(v)))),
  sPct: (v, d = 1) => v == null ? '' : signed(v, (Math.abs(v) * 100).toFixed(d) + '%'),
  sPts: v => v == null ? '' : signed(v, (Math.abs(v) * 100).toFixed(2) + ' pts'),
  date: iso => iso ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}/${iso.slice(0, 4)}` : '',
  big: v => v == null ? '' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : nf.format(v),
};
const quarterOf = p => Math.floor((+p.slice(5, 7) - 1) / 3) + 1;
const qlabel = p => `Q${quarterOf(p)} ${p.slice(0, 4)}`;
const qshort = p => `Q${quarterOf(p)} '${p.slice(2, 4)}`;
const secFilingUrl = (cik, acc) =>
  `https://www.sec.gov/Archives/edgar/data/${+cik}/${acc.replace(/-/g, '')}/${acc}-index.htm`;
const secCompanyUrl = (cik, type = '') =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${type}&dateb=&owner=include&count=40`;
const ext = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${text} ↗</a>`;
const badge = s => s ? `<span class="badge ${s}">${s}</span>` : '';

// Native <select> menus on macOS open with the selected option over the control, so they jump
// up the page when a later option is selected. Swap each <select> for a menu that always drops
// down below it; the hidden <select> keeps the value and still fires 'change'.
function enhanceSelects(root) {
  $$('select:not([data-dd])', root).forEach(sel => {
    sel.dataset.dd = '1';
    sel.hidden = true;
    const dd = document.createElement('span');
    dd.className = 'dd';
    dd.innerHTML = '<button type="button" class="dd-btn" aria-haspopup="listbox"></button><ul class="dd-menu" role="listbox" hidden></ul>';
    sel.before(dd);  // first in DOM, so a wrapping <label> activates the button
    const btn = dd.firstChild, menu = dd.lastChild;
    const sync = () => { btn.textContent = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : ''; };
    const outside = e => { if (!dd.contains(e.target)) close(); };
    const close = () => { menu.hidden = true; document.removeEventListener('mousedown', outside, true); };
    const open = () => {
      menu.innerHTML = [...sel.options].map(o =>
        `<li role="option" data-v="${esc(o.value)}"${o.selected ? ' class="sel"' : ''}>${esc(o.textContent)}</li>`).join('');
      menu.hidden = false;
      const cur = $('.sel', menu);
      if (cur) cur.scrollIntoView({ block: 'nearest' });
      document.addEventListener('mousedown', outside, true);
    };
    // preventDefault stops the wrapping <label> from re-clicking the button
    btn.addEventListener('click', e => { e.preventDefault(); menu.hidden ? open() : close(); });
    menu.addEventListener('click', e => {
      e.preventDefault();
      const li = e.target.closest('li');
      if (!li) return;
      close();
      btn.focus();
      if (sel.value !== li.dataset.v) {
        sel.value = li.dataset.v;
        sync();
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    dd.addEventListener('keydown', e => {
      if (menu.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
        return;
      }
      const items = $$('li', menu);
      let i = items.findIndex(li => li.classList.contains('active'));
      if (i < 0) i = items.findIndex(li => li.classList.contains('sel'));
      if (e.key === 'Escape' || e.key === 'Tab') {
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        i = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        items.forEach((li, j) => li.classList.toggle('active', j === i));
        items[i].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && i >= 0) {
        e.preventDefault();
        items[i].click();
      }
    });
    sel.syncDropdown = sync;
    sync();
  });
}
function setSelect(sel, value) {
  sel.value = value;
  if (sel.syncDropdown) sel.syncDropdown();
}

let META = null;
const fundName = cik => (META.funds.find(f => f.cik === cik) || {}).short || cik;

// Funds excluded from consensus are remembered per browser (new funds default to included).
function selectedFunds() {
  let off = [];
  try { off = JSON.parse(localStorage.getItem('fundsOff') || '[]'); } catch (e) { /* ignore */ }
  return META.funds.map(f => f.cik).filter(c => !off.includes(c));
}
function setFundSelected(cik, on) {
  const off = new Set(META.funds.map(f => f.cik).filter(c => !selectedFunds().includes(c)));
  on ? off.delete(cik) : off.add(cik);
  localStorage.setItem('fundsOff', JSON.stringify([...off]));
}
function setAllFundsSelected(on) {
  localStorage.setItem('fundsOff', JSON.stringify(on ? [] : META.funds.map(f => f.cik)));
}

// Most recent quarter that (nearly) all of the given funds have filed.
function defaultPeriod(ciks) {
  const ps = META.periods;
  const share = p => ciks.filter(c => p.filed.includes(c)).length / ciks.length;
  return (ps.find(p => share(p) === 1) || ps.find(p => share(p) >= 0.5) || ps[0] || {}).period;
}
function filedNote(p, ciks) {
  const m = META.periods.find(x => x.period === p);
  const n = m ? ciks.filter(c => m.filed.includes(c)).length : 0;
  return n === ciks.length ? '' : ` (${n}/${ciks.length} filed)`;
}

// ---------- generic sortable / filterable table ----------
// columns: {key, label, num, get(row), sort(row), fmt(value,row) -> html, csv(row), cls, title}
// state (optional) persists search text + sort across re-mounts of the same table.
function mountTable(el, o) {
  const cols = o.columns;
  const st = o.state || {};
  if (st.sortKey === undefined || !cols.some(c => c.key === st.sortKey)) {
    [st.sortKey, st.sortDir] = o.sort || [null, 'desc'];
  }
  if (st.text === undefined) st.text = o.search || '';
  el.innerHTML = `
    <div class="toolbar">
      <input type="search" class="tsearch" placeholder="${esc(o.placeholder || 'Filter rows…')}" value="${esc(st.text)}">
      ${o.toolbar || ''}
      <span class="tcount"></span>
      <button class="btn tcsv" type="button">Export CSV</button>
    </div>
    <div class="tscroll"><table class="dt"><thead><tr></tr></thead><tbody></tbody><tfoot></tfoot></table></div>`;
  const thead = $('thead tr', el), tbody = $('tbody', el), tfoot = $('tfoot', el);
  const get = (c, r) => c.get ? c.get(r) : r[c.key];
  const sortv = (c, r) => c.sort ? c.sort(r) : get(c, r);
  const hay = r => (o.searchText ? o.searchText(r) : cols.map(c => get(c, r) ?? '').join(' ')).toLowerCase();
  let shown = [];

  function visible() {
    let rs = o.filter ? o.rows.filter(o.filter) : o.rows.slice();
    const terms = st.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length) rs = rs.filter(r => { const h = hay(r); return terms.every(t => h.includes(t)); });
    const c = cols.find(c => c.key === st.sortKey);
    if (c) {
      const dir = st.sortDir === 'asc' ? 1 : -1;
      const blank = v => v == null || v === '' || Number.isNaN(v);
      rs = rs.map(r => [sortv(c, r), r]).sort(([x], [y]) => {
        if (blank(x)) return blank(y) ? 0 : 1;   // blanks always last
        if (blank(y)) return -1;
        return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
      }).map(p => p[1]);
    }
    return rs;
  }

  function render() {
    thead.innerHTML = cols.map(c => {
      const cls = [c.num && 'num', c.key === st.sortKey && 'sorted', c.key === st.sortKey && st.sortDir].filter(Boolean).join(' ');
      return `<th data-k="${esc(c.key)}" class="${cls}" title="${esc(c.title || '')}">${c.label}</th>`;
    }).join('');
    shown = visible();
    tbody.innerHTML = shown.length ? shown.map(r =>
      `<tr class="${o.rowClass ? o.rowClass(r) : ''}">${cols.map(c => {
        const v = get(c, r);
        const cls = [c.num && 'num', typeof c.cls === 'function' ? c.cls(r) : c.cls].filter(Boolean).join(' ');
        return `<td class="${cls}">${c.fmt ? c.fmt(v, r) : esc(v)}</td>`;
      }).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="empty">${o.empty || 'No matching rows'}</td></tr>`;
    tfoot.innerHTML = o.footer ? o.footer(shown) : '';
    $('.tcount', el).textContent = shown.length === o.rows.length
      ? `${shown.length} rows` : `${shown.length} of ${o.rows.length} rows`;
  }

  thead.addEventListener('click', e => {
    const th = e.target.closest('th');
    if (!th) return;
    const c = cols.find(c => c.key === th.dataset.k);
    if (c.key === st.sortKey) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
    else [st.sortKey, st.sortDir] = [c.key, c.num ? 'desc' : 'asc'];
    render();
  });
  $('.tsearch', el).addEventListener('input', e => { st.text = e.target.value; render(); });
  $('.tcsv', el).addEventListener('click', () => downloadCsv(o.csvName || 'export.csv', cols, shown));
  render();
  return { render, el };
}

function downloadCsv(name, cols, rows) {
  const cell = v => {
    v = v == null ? '' : String(v);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = [cols.map(c => cell(c.label.replace(/<[^>]+>/g, ' ').trim())).join(',')];
  for (const r of rows) lines.push(cols.map(c => cell(c.csv ? c.csv(r) : c.get ? c.get(r) : r[c.key])).join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = name.replace(/[^\w.-]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- shared columns ----------
const symCol = {
  key: 'sym', label: 'Sym', cls: 'sym',
  fmt: (v, r) => `<a href="#/stock/${esc(r.cusip)}" title="All tracked holders of ${esc(r.issuer)}">${esc(v || '—')}</a>`,
};
const issuerCol = { key: 'issuer', label: 'Issuer Name' };
// 13F "title of class" is free text. Show every common-stock variant (COM, COM NEW, COMMON STOCK,
// COM PAR $.01, ...) as "Common", keeping any share class or series (COM CL A -> Common Class A).
function classLabel(cls) {
  const c = (cls || '').trim();
  if (!/\bCOM(MON)?\b/i.test(c)) return c;
  const cl = c.match(/\b(?:CL|CLASS)\s+([A-Z])\b/i), ser = c.match(/\bSER(?:IES)?\s+([A-Z0-9]+)\b/i);
  return 'Common' + (cl ? ` Class ${cl[1].toUpperCase()}` : '') + (ser ? ` Series ${ser[1].toUpperCase()}` : '');
}
const clsCol = { key: 'cls', label: 'Cl', get: r => classLabel(r.cls) };
const optCol = { key: 'put_call', label: 'Option Type' };

function pctCoCell(v, r) {
  if (v == null) return '';
  let tip = r.so_shares ? `${fmt.int(r.shares)} held / ${fmt.int(r.so_shares)} shares outstanding as of ${fmt.date(r.so_as_of)}` : '';
  if (r.pct_note) tip += ` — ${r.pct_note}`;
  return `<span title="${esc(tip)}"${r.pct_note ? ' class="approx"' : ''}>${fmt.pct(v)}${r.pct_note ? '*' : ''}</span>`;
}
const PCT_CO_NOTE = `<p class="note">% of Co. = shares held ÷ issuer shares outstanding (SEC XBRL, closest to quarter end). ` +
  `<span class="approx">*</span> = approximate: ADR positions don't apply the depositary ratio, or the share count is stale. Hover for details.</p>`;

const METRICS = {
  value: { label: 'Value ($000)', field: 'value', fmt: fmt.k, sum: true },
  pct_port: { label: '% of portfolio', field: 'pct_port', fmt: v => fmt.pct(v) },
  shares: { label: 'Shares / principal', field: 'shares', fmt: fmt.int, sum: true },
  pct_co: { label: '% of company', field: 'pct_co', fmt: v => fmt.pct(v), sum: true },
};
const metricSelect = cur => `<label>Show <select class="metric">${Object.entries(METRICS).map(([k, m]) =>
  `<option value="${k}"${k === cur ? ' selected' : ''}>${m.label}</option>`).join('')}</select></label>`;

// Share-count change between the last two quarters of a {period: cell} map.
function shareChange(cells, last, prev) {
  const a = cells[last], b = cells[prev];
  if (a && !b) return { status: 'NEW', sort: Infinity };
  if (b && !a) return { status: 'EXIT', sort: -1 };
  if (!a || !b) return null;
  const d = b.shares ? a.shares / b.shares - 1 : null;
  return { d, sort: d };
}
const shareChangeFmt = ch => !ch ? '' : ch.status ? badge(ch.status) : ch.d === 0 ? '<span class="muted">0%</span>' : fmt.sPct(ch.d);

// ---------- views ----------
async function viewConsensus(q) {
  if (!META.periods.length) return noData();
  const funds = selectedFunds();
  const period = q.period || defaultPeriod(funds.length ? funds : META.funds.map(f => f.cik));
  const calls = q.calls === '1';
  const d = funds.length ? await load(`consensus?period=${period}&funds=${funds.join(',')}${calls ? '&calls=1' : ''}`) : null;
  const missing = d ? d.missing : [];
  const st = { min: q.f ? 1 : +(localStorage.getItem('minHolders') || 2) };
  const allOn = funds.length === META.funds.length;
  const minHolders = () => Math.min(st.min, funds.length);  // e.g. one fund selected -> show all its longs

  app.innerHTML = `
    <h1>Consensus longs — ${qlabel(period)}</h1>
    <div class="sub"><span>Long ${calls ? 'share + call' : 'share'} positions held across the selected funds</span>${d ? `<span>changes vs ${qlabel(d.prev)}</span>` : ''}</div>
    <div class="controls">
      <label>Quarter <select id="period">${META.periods.map(p =>
        `<option value="${p.period}"${p.period === period ? ' selected' : ''}>${p.label}${filedNote(p.period, funds)}</option>`).join('')}</select></label>
      <span class="chip-actions">
        <button type="button" class="btn btn-sm" id="fundsAll"${allOn ? ' disabled' : ''}>Select all</button>
        <button type="button" class="btn btn-sm" id="fundsNone"${funds.length ? '' : ' disabled'}>Deselect all</button>
      </span>
      <div class="chips">${META.funds.map(f => {
        const on = funds.includes(f.cik), late = on && missing.includes(f.cik);
        return `<label class="chip${on ? '' : ' off'}" title="${esc(f.sec_name || f.name)}${late ? ' — no 13F for this quarter yet' : ''}">
          <input type="checkbox" data-cik="${f.cik}"${on ? ' checked' : ''}>${esc(f.short)}${late ? ' <span class="warn">⚠</span>' : ''}</label>`;
      }).join('')}</div>
      <label><input type="checkbox" id="calls"${calls ? ' checked' : ''}> Count calls as longs</label>
    </div>
    ${missing.length ? `<div class="notice">No ${qlabel(period)} 13F yet from: ${missing.map(fundName).map(esc).join(', ')}. Holder counts for this quarter are incomplete.</div>` : ''}
    <div id="t">${d ? '' : '<div class="empty">No funds selected. Tick one or more funds above, or click Select all.</div>'}</div>
    ${d ? PCT_CO_NOTE : ''}`;

  const go = params => { location.hash = '#/consensus?' + new URLSearchParams({ period, ...(calls ? { calls: 1 } : {}), ...params }); };
  $('#period').onchange = e => go({ period: e.target.value });
  $('#calls').onchange = e => go({ calls: e.target.checked ? 1 : 0 });
  $$('.chips input').forEach(cb => cb.onchange = () => { setFundSelected(cb.dataset.cik, cb.checked); route(); });
  $('#fundsAll').onclick = () => { setAllFundsSelected(true); route(); };
  $('#fundsNone').onclick = () => { setAllFundsSelected(false); route(); };
  if (!d) return;

  const holderChip = h => {
    const tip = `${h.short}: ${fmt.int(h.shares)} sh, $${fmt.k(h.value)}k, ${fmt.pct(h.pct_port)} of portfolio` +
      (h.pct_co != null ? `, ${fmt.pct(h.pct_co)} of company` : '') +
      (h.call_value ? ` (incl. $${fmt.k(h.call_value)}k calls)` : '') +
      (h.status ? ` — ${h.status}${h.d_shares ? ' ' + (h.d_shares > 0 ? '+' : '') + fmt.int(h.d_shares) + ' sh' : ''}` : '');
    return `<span class="h ${h.status || ''}" title="${esc(tip)}">${esc(h.short)} ${fmt.pct(h.pct_port, 1)}</span>`;
  };
  const table = mountTable($('#t'), {
    rows: d.rows, sort: ['n', 'desc'], csvName: `consensus-${period}.csv`, search: q.f || '',
    placeholder: 'Filter by ticker, issuer, fund…',
    searchText: r => [r.sym, r.issuer, classLabel(r.cls), r.cusip, ...r.holders.map(h => h.short), ...r.exited].join(' '),
    toolbar: `<label>Min holders <input type="number" id="min" min="1" max="${funds.length}" value="${minHolders()}"></label>`,
    filter: r => r.n >= minHolders(),
    columns: [
      symCol, issuerCol, clsCol,
      { key: 'n', label: 'Holders', num: true, title: 'Number of selected funds long (ties broken by Σ % of portfolio)', sort: r => r.n * 1000 + r.sum_pct_port },
      { key: 'd_n', label: 'Δ', num: true, title: `Change in holder count vs ${qlabel(d.prev)}`, fmt: fmt.sInt },
      { key: 'funds', label: 'Funds (% of portfolio)', cls: 'wrap', get: r => r.holders.map(h => h.short).join(' '),
        sort: r => r.n * 1000 + r.sum_pct_port,
        fmt: (v, r) => r.holders.map(holderChip).join('') + r.exited.map(x => `<span class="h x" title="${esc(x)} exited">${esc(x)}</span>`).join(''),
        csv: r => r.holders.map(h => `${h.short} ${fmt.pct(h.pct_port, 1)}${h.status === 'NEW' ? ' (new)' : ''}`).join('; ') },
      { key: 'value', label: 'Value ($000)', num: true, fmt: fmt.k },
      { key: 'sum_pct_port', label: 'Σ % Port', num: true, title: 'Sum of portfolio weights across holders — a conviction-weighted consensus score', fmt: v => fmt.pct(v) },
      { key: 'avg_pct_port', label: 'Avg % Port', num: true, fmt: v => fmt.pct(v) },
      { key: 'max_pct_port', label: 'Max % Port', num: true, fmt: v => fmt.pct(v) },
      { key: 'pct_co', label: '% of Co.', num: true, title: 'Combined % of shares outstanding held by these funds',
        fmt: (v, r) => v == null ? '' : r.pct_co_note ? `<span class="approx" title="${esc(r.pct_co_note)}">${fmt.pct(v)}*</span>` : fmt.pct(v) },
      { key: 'd_shares_pct', label: 'Net Δ Shares', num: true, title: `Combined share change vs ${qlabel(d.prev)} (funds that filed both quarters)`, fmt: v => fmt.sPct(v) },
      { key: 'n_new', label: 'New', num: true, get: r => r.new.length, title: 'Funds that initiated a position', fmt: (v, r) => v ? `<span class="pos" title="${esc(r.new.join(', '))}">${v}</span>` : '' },
      { key: 'n_exit', label: 'Exited', num: true, get: r => r.exited.length, title: 'Funds that sold out of the position', fmt: (v, r) => v ? `<span class="neg" title="${esc(r.exited.join(', '))}">${v}</span>` : '' },
    ],
  });
  $('#min').oninput = e => { st.min = +e.target.value || 1; localStorage.setItem('minHolders', st.min); table.render(); };
}

async function viewFunds() {
  const funds = await load('funds');
  app.innerHTML = `
    <h1>Tracked funds</h1>
    <div class="sub"><span>${funds.length} funds</span><span>Add or remove funds in <code>config.json</code>, then click Refresh data</span></div>
    <div id="t"></div>`;
  mountTable($('#t'), {
    rows: funds, sort: ['value', 'desc'], csvName: 'funds.csv',
    columns: [
      { key: 'name', label: 'Fund', get: r => r.sec_name || r.name, fmt: (v, r) => `<a href="#/manager/${r.cik}">${esc(v)}</a>` },
      { key: 'short', label: 'Short' },
      { key: 'loc', label: 'Location', get: r => [r.city, r.state].filter(Boolean).join(', ') },
      { key: 'period', label: 'Latest 13F', fmt: (v, r) => v ? `<a href="#/filing/${r.cik}/${v}">${qlabel(v)}</a>` : '<span class="muted">no data</span>' },
      { key: 'n_positions', label: 'Holdings', num: true, fmt: fmt.int },
      { key: 'value', label: 'Value ($000)', num: true, fmt: fmt.k },
      { key: 'qoq', label: 'QoQ', num: true, get: r => r.prev_value ? r.value / r.prev_value - 1 : null, fmt: v => fmt.sPct(v) },
      { key: 'top', label: 'Top Holdings', get: r => (r.top || []).join(', ') },
      { key: 'filed', label: 'Date Filed', fmt: fmt.date },
      { key: 'cik', label: 'CIK' },
    ],
  });
}

async function viewManager(cik, q) {
  const tab = q.tab === 'history' ? 'history' : 'filings';
  const d = await load(`manager/${cik}`);
  const m = d.manager;
  const loc = [m.city, m.state].filter(Boolean).join(', ');
  app.innerHTML = `
    <h1>${esc(m.sec_name || m.name)} 13F Filings</h1>
    <div class="sub">${loc ? `<span>${esc(loc)}</span>` : ''}<span>CIK ${cik}</span><span>${ext(secCompanyUrl(cik, '13F'), 'View on sec.gov')}</span></div>
    <div class="tabs">
      <a href="#/manager/${cik}" class="${tab === 'filings' ? 'active' : ''}">13F filings</a>
      <a href="#/manager/${cik}?tab=history" class="${tab === 'history' ? 'active' : ''}">Holdings history (${META.quarters}Q)</a>
    </div>
    <div id="t"></div>`;
  if (tab === 'history') return renderHistory(cik);

  const formLabel = f => f.form + (f.amendment_type ? ` (${f.amendment_type.toLowerCase()})` : '') + (f.applied ? '' : ' — not applied');
  mountTable($('#t'), {
    rows: d.periods, sort: ['period', 'desc'], csvName: `${m.short}-13f-filings.csv`,
    columns: [
      { key: 'period', label: 'Quarter', fmt: v => `<a href="#/filing/${cik}/${v}">${qlabel(v)}</a>`, csv: r => qlabel(r.period) },
      { key: 'n_positions', label: 'Holdings', num: true, fmt: fmt.int },
      { key: 'value', label: 'Value ($000)', num: true, fmt: fmt.k },
      { key: 'qoq', label: 'QoQ', num: true, get: r => r.prev_value ? r.value / r.prev_value - 1 : null, fmt: v => fmt.sPct(v) },
      { key: 'top', label: 'Top Holdings', get: r => r.top.join(', ') },
      { key: 'forms', label: 'Form Type', get: r => r.filings.map(formLabel).join('; '),
        fmt: (v, r) => r.filings.map(f => esc(formLabel(f))).join('<br>') },
      { key: 'filed', label: 'Date Filed', get: r => r.filings.map(f => f.filed).join(' '),
        fmt: (v, r) => r.filings.map(f => fmt.date(f.filed)).join('<br>') },
      { key: 'acc', label: 'Filing ID', get: r => r.filings.map(f => f.accession).join(' '),
        fmt: (v, r) => r.filings.map(f => ext(secFilingUrl(cik, f.accession), f.accession.replace(/-/g, ''))).join('<br>') },
    ],
  });
}

async function renderHistory(cik) {
  const d = await load(`manager/${cik}/history`);
  const ps = d.periods, last = ps[ps.length - 1], prev = ps[ps.length - 2];
  const st = { metric: 'value', current: true, options: false, table: {} };
  const host = $('#t');
  host.innerHTML = `<div class="controls">
      ${metricSelect(st.metric)}
      <label><input type="checkbox" id="cur" checked> Only positions held in ${qlabel(last)}</label>
      <label><input type="checkbox" id="opt"> Include options &amp; notes</label>
    </div><div id="ht"></div>${PCT_CO_NOTE}`;
  const draw = () => {
    const m = METRICS[st.metric];
    mountTable($('#ht'), {
      state: st.table, rows: d.rows, sort: [last, 'desc'], csvName: `${d.manager.short}-history-${st.metric}.csv`,
      filter: r => (!st.current || r.cells[last]) && (st.options || (!r.put_call && r.sh_type === 'SH')),
      columns: [
        symCol, issuerCol, clsCol,
        ...(st.options ? [optCol, { key: 'sh_type', label: 'Type' }] : []),
        ...ps.map(p => ({ key: p, label: qshort(p), num: true, get: r => r.cells[p] ? r.cells[p][m.field] : null, fmt: m.fmt })),
        ...(prev ? [{ key: 'chg', label: `Δ Shares vs ${qshort(prev)}`, num: true,
          get: r => shareChange(r.cells, last, prev), sort: r => (shareChange(r.cells, last, prev) || {}).sort,
          fmt: shareChangeFmt, csv: r => { const c = shareChange(r.cells, last, prev); return c ? c.status || c.d : ''; } }] : []),
      ],
    });
  };
  $('.metric', host).onchange = e => { st.metric = e.target.value; draw(); };
  $('#cur').onchange = e => { st.current = e.target.checked; draw(); };
  $('#opt').onchange = e => { st.options = e.target.checked; draw(); };
  draw();
}

async function viewFiling(cik, period, q) {
  const d = await load(`filing/${cik}/${period}${q.compare ? '?compare=' + q.compare : ''}`);
  const m = d.manager, s = d.summary, cnt = s.counts, cmp = d.compare;
  const i = d.available.indexOf(period);
  const older = d.available[i + 1], newer = d.available[i - 1];
  const st = { status: q.status || 'all', type: 'all' };
  const link = (p, extra = {}) => `#/filing/${cik}/${p}` + (Object.keys(extra).length ? '?' + new URLSearchParams(extra) : '');

  app.innerHTML = `
    <div class="controls" style="margin-top:0">
      <h1><a href="#/manager/${cik}">${esc(m.sec_name || m.name)}</a> — ${qlabel(period)} 13F Holdings</h1>
      <span class="qnav">${older ? `<a href="${link(older)}">← ${qlabel(older)}</a>` : ''}${newer ? `<a href="${link(newer)}">${qlabel(newer)} →</a>` : ''}</span>
    </div>
    <div class="facts">
      <div><span class="k">Holdings date</span><span class="v">${fmt.date(period)}</span></div>
      <div><span class="k">Value ($000)</span><span class="v">${fmt.k(s.value)}</span></div>
      <div><span class="k">QoQ value</span><span class="v">${s.prev_value ? fmt.sPct(s.value / s.prev_value - 1) : '—'}</span></div>
      <div><span class="k">Holdings</span><span class="v">${fmt.int(s.n_positions)}</span></div>
      <div><span class="k">Date filed</span><span class="v">${fmt.date(s.filed)}</span></div>
      <div><span class="k">Filings</span><span class="v" style="font-size:12px;font-weight:400">${s.filings.map(f =>
        `${esc(f.form)}${f.amendment_type ? ` (${esc(f.amendment_type.toLowerCase())})` : ''} ${ext(secFilingUrl(cik, f.accession), fmt.date(f.filed))}`).join('<br>')}</span></div>
    </div>
    <div class="controls">
      <label>Compare to <select id="cmp"><option value="">—</option>${d.available.filter(p => p !== period).map(p =>
        `<option value="${p}"${p === cmp ? ' selected' : ''}>${qlabel(p)}</option>`).join('')}</select></label>
      ${cmp ? ['NEW', 'ADD', 'TRIM', 'EXIT', 'HOLD'].map(k =>
        `<a href="#" data-status="${k}" title="Show only ${k}">${badge(k)} ${cnt[k] || 0}</a>`).join(' ') : ''}
    </div>
    <div id="t"></div>
    ${PCT_CO_NOTE}`;
  $('#cmp').onchange = e => { location.hash = link(period, e.target.value ? { compare: e.target.value } : {}); };

  const pq = cmp ? qshort(cmp) : 'prior';
  const isPrn = r => r.sh_type === 'PRN';
  const typeOk = r => st.type === 'all' || (st.type === 'shares' ? !r.put_call && !isPrn(r)
    : st.type === 'options' ? !!r.put_call : st.type === 'prn' ? isPrn(r) : r.put_call === st.type);
  const opt = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
  const table = mountTable($('#t'), {
    rows: d.rows, sort: ['value', 'desc'], csvName: `${m.short}-${period}.csv`,
    toolbar: `
      <label>Change <select id="fstatus">${[['all', 'All'], ['changed', 'Any change'], ['NEW', 'New'], ['ADD', 'Added'],
        ['TRIM', 'Trimmed'], ['EXIT', 'Exited'], ['HOLD', 'Unchanged']].map(([v, l]) => opt(v, l, st.status)).join('')}</select></label>
      <label>Type <select id="ftype">${[['all', 'All'], ['shares', 'Shares'], ['options', 'Options'], ['Call', 'Calls'],
        ['Put', 'Puts'], ['prn', 'Principal (notes)']].map(([v, l]) => opt(v, l, st.type)).join('')}</select></label>`,
    filter: r => typeOk(r) && (st.status === 'all' || (st.status === 'changed' ? r.status !== 'HOLD' : r.status === st.status)),
    rowClass: r => r.status === 'EXIT' ? 'exit' : '',
    columns: [
      symCol, issuerCol, clsCol,
      { key: 'cusip', label: 'CUSIP' },
      { key: 'value', label: 'Value ($000)', num: true, fmt: fmt.k },
      { key: 'pct_port', label: '%', num: true, title: '% of reported 13F portfolio value', fmt: v => fmt.pct(v) },
      { key: 'shares', label: 'Shares', num: true, get: r => isPrn(r) ? null : r.shares, fmt: fmt.int },
      { key: 'principal', label: 'Principal', num: true, get: r => isPrn(r) ? r.shares : null, fmt: fmt.int },
      optCol,
      { key: 'pct_co', label: '% of Co.', num: true, title: 'Shares held ÷ shares outstanding', fmt: pctCoCell },
      ...(cmp ? [
        { key: 'prev_shares', label: `Shares ${pq}`, num: true, fmt: fmt.int },
        { key: 'd_shares', label: 'Δ Shares', num: true, fmt: fmt.sInt },
        { key: 'd_pct', label: 'Δ %', num: true, get: r => r.status === 'NEW' ? null : r.d_pct,
          sort: r => r.status === 'NEW' ? Infinity : r.d_pct, fmt: (v, r) => r.status === 'NEW' ? '' : fmt.sPct(v) },
        { key: 'prev_pct_port', label: `% ${pq}`, num: true, title: `% of portfolio in ${qlabel(cmp)}`, fmt: v => fmt.pct(v) },
        { key: 'd_pct_co', label: 'Δ % of Co.', num: true, title: `Change in % of company vs ${qlabel(cmp)}`,
          get: r => r.pct_co != null && r.prev_pct_co != null ? r.pct_co - r.prev_pct_co : null, fmt: fmt.sPts },
        { key: 'status', label: 'Status', fmt: badge, sort: r => ({ NEW: 5, ADD: 4, HOLD: 3, TRIM: 2, EXIT: 1 })[r.status] },
      ] : []),
    ],
  });
  $('#fstatus').onchange = e => { st.status = e.target.value; table.render(); };
  $('#ftype').onchange = e => { st.type = e.target.value; table.render(); };
  $$('[data-status]').forEach(a => a.onclick = e => {
    e.preventDefault();
    st.status = a.dataset.status;
    if (st.status === 'EXIT' || st.type !== 'all') st.type = 'all';
    setSelect($('#fstatus'), st.status);
    setSelect($('#ftype'), st.type);
    table.render();
  });
}

async function viewStock(cusip, q) {
  const d = await load(`stock/${cusip}`);
  const ps = d.periods, allFunds = META.funds.map(f => f.cik);
  const cur = defaultPeriod(allFunds) || ps[ps.length - 1];
  const prevP = ps[ps.indexOf(cur) - 1];
  const so = d.shares_outstanding;
  const isLong = r => !r.put_call && r.sh_type === 'SH';
  const st = { metric: 'shares', table: {} };

  app.innerHTML = `
    <h1>${esc(d.sym || d.cusip)} — ${esc(d.issuer)}</h1>
    <div class="sub">
      <span>${esc(classLabel(d.cls))}</span><span>CUSIP ${esc(d.cusip)}</span>${d.security_type ? `<span>${esc(d.security_type)}</span>` : ''}
      ${so ? `<span>${fmt.big(so.shares)} shares outstanding (as of ${fmt.date(so.as_of)})</span>` : ''}
      ${d.issuer_cik ? `<span>${ext(secCompanyUrl(d.issuer_cik), 'Issuer filings')}</span>` : ''}
    </div>
    <h2>Holders in ${qlabel(cur)}</h2>
    <div id="cur"></div>
    <h2>Holdings by quarter</h2>
    <div class="controls">${metricSelect(st.metric)}</div>
    <div id="hist"></div>
    ${PCT_CO_NOTE}`;

  const label = r => r.short + (r.put_call ? ` (${r.put_call})` : r.sh_type === 'PRN' ? ' (notes)' : '');
  const curRows = d.rows.filter(r => r.cells[cur] || (prevP && r.cells[prevP]))
    .map(r => ({ ...r, ...(r.cells[cur] || {}), label: label(r), ch: prevP ? shareChange(r.cells, cur, prevP) : null,
      prev: prevP && r.cells[prevP] ? r.cells[prevP].shares : null }));
  mountTable($('#cur'), {
    rows: curRows, sort: ['value', 'desc'], csvName: `${d.sym || cusip}-holders-${cur}.csv`,
    rowClass: r => r.ch && r.ch.status === 'EXIT' ? 'exit' : '',
    columns: [
      { key: 'label', label: 'Fund', fmt: (v, r) => `<a href="#/filing/${r.cik}/${cur}">${esc(v)}</a>` },
      { key: 'shares', label: 'Shares / principal', num: true, get: r => r.cells[cur] ? r.shares : null, fmt: fmt.int },
      { key: 'value', label: 'Value ($000)', num: true, get: r => r.cells[cur] ? r.value : null, fmt: fmt.k },
      { key: 'pct_port', label: '% of Portfolio', num: true, get: r => r.cells[cur] ? r.pct_port : null, fmt: v => fmt.pct(v) },
      { key: 'pct_co', label: '% of Co.', num: true, get: r => r.cells[cur] ? r.pct_co : null, fmt: pctCoCell },
      ...(prevP ? [
        { key: 'prev', label: `Shares ${qshort(prevP)}`, num: true, fmt: fmt.int },
        { key: 'ch', label: 'Δ Shares', num: true, sort: r => (r.ch || {}).sort, fmt: shareChangeFmt,
          csv: r => r.ch ? r.ch.status || r.ch.d : '' },
      ] : []),
    ],
    footer: rs => {
      const longs = rs.filter(r => isLong(r) && r.cells[cur]);
      const sum = f => longs.reduce((a, r) => a + (r[f] || 0), 0);
      return `<tr class="total"><td>Total long (${longs.length} funds)</td><td class="num">${fmt.int(sum('shares'))}</td>
        <td class="num">${fmt.k(sum('value'))}</td><td></td><td class="num">${fmt.pct(sum('pct_co'))}</td>${prevP ? '<td></td><td></td>' : ''}</tr>`;
    },
  });

  const draw = () => {
    const m = METRICS[st.metric];
    const cellFmt = (p, r) => {
      const c = r.cells[p];
      if (c) return st.metric === 'pct_co' ? pctCoCell(c.pct_co, c) : m.fmt(c[m.field]);
      return (d.filed[p] || []).includes(r.cik) ? '' : '<span class="muted" title="No 13F filed for this quarter yet">n/f</span>';
    };
    mountTable($('#hist'), {
      state: st.table, rows: d.rows.map(r => ({ ...r, label: label(r) })), sort: [ps[ps.length - 1], 'desc'],
      csvName: `${d.sym || cusip}-history-${st.metric}.csv`,
      columns: [
        { key: 'label', label: 'Fund', fmt: (v, r) => `<a href="#/manager/${r.cik}?tab=history">${esc(v)}</a>` },
        ...ps.map(p => ({ key: p, label: qshort(p), num: true, get: r => r.cells[p] ? r.cells[p][m.field] : null, fmt: (v, r) => cellFmt(p, r) })),
      ],
      footer: rs => {
        const longs = rs.filter(isLong);
        const cells = ps.map(p => {
          const held = longs.filter(r => r.cells[p]);
          const total = m.sum ? m.fmt(held.reduce((a, r) => a + (r.cells[p][m.field] || 0), 0)) : '';
          return `<td class="num">${total}<span class="cell-sub">${held.length} holders</span></td>`;
        }).join('');
        return `<tr class="total"><td>Total long</td>${cells}</tr>`;
      },
    });
  };
  $('.metric').onchange = e => { st.metric = e.target.value; draw(); };
  draw();
}

function noData() {
  app.innerHTML = `<h1>No data yet</h1><p>Run <code>python3 fetch.py</code> (or click <b>Refresh data</b>) to pull 13F filings from SEC EDGAR.</p>`;
}

// ---------- routing ----------
const ROUTES = [
  [/^\/?$/, q => viewConsensus(q)],
  [/^\/consensus$/, q => viewConsensus(q)],
  [/^\/funds$/, () => viewFunds()],
  [/^\/manager\/(\d+)$/, (q, cik) => viewManager(cik, q)],
  [/^\/filing\/(\d+)\/(\d{4}-\d{2}-\d{2})$/, (q, cik, p) => viewFiling(cik, p, q)],
  [/^\/stock\/(\w+)$/, (q, cusip) => viewStock(cusip, q)],
];

async function route() {
  routeSeq++;
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  const section = path === '/' || path.startsWith('/consensus') ? 'consensus' : path.startsWith('/funds') ? 'funds' : '';
  $$('.mainnav a').forEach(a => a.classList.toggle('active', a.dataset.nav === section));
  $$('.fundnav a').forEach(a => a.classList.toggle('active', path.includes(a.dataset.cik)));
  try {
    for (const [re, fn] of ROUTES) {
      const m = path.match(re);
      if (m) { await fn(q, ...m.slice(1)); enhanceSelects(app); window.scrollTo(0, 0); return; }
    }
    app.innerHTML = '<div class="error">Page not found</div>';
  } catch (e) {
    if (e !== STALE) app.innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

async function loadMeta() {
  META = await localApi('meta');
  $('#fundnav').innerHTML = META.funds.map(f =>
    `<a href="#/manager/${f.cik}" data-cik="${f.cik}" title="${esc(f.sec_name || f.name)}">${esc(f.short)}</a>`).join('');
  // Short date and time (no seconds) so the top bar stays on one line on a laptop screen.
  $('#updated').textContent = META.updated_at
    ? 'Data updated ' + new Date(META.updated_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
}

async function pollRefresh(btn) {
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  for (;;) {
    const s = await api('refresh');
    btn.title = s.log;
    if (!s.running) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  btn.disabled = false;
  btn.textContent = 'Refresh data';
  await loadDb(true);
  await loadMeta();
  route();
}

$('#refresh').onclick = async e => {
  await api('refresh', { method: 'POST' });
  pollRefresh(e.target);
};
$('#search').onsubmit = e => {
  e.preventDefault();
  const text = $('input', e.target).value.trim();
  location.hash = '#/consensus?' + new URLSearchParams({ f: text });
};
window.addEventListener('hashchange', route);

(async () => {
  try {
    await loadMeta();
  } catch (e) {
    app.innerHTML = `<div class="error">${esc(e.message)}</div>`;
    return;
  }
  route();
  // The Refresh button needs the local server; on the static site (GitHub Pages) data updates on a schedule.
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const s = local ? await api('refresh').catch(() => null) : null;
  $('#refresh').hidden = !s;
  if (s && s.running) pollRefresh($('#refresh'));
})();
