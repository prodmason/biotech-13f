'use strict';
// Data layer: loads data.json (written by export.py) and computes every view in the browser, so the
// site is plain static files (GitHub Pages, or `python3 server.py` locally).

let DB = null;

const push = (map, key, value) => { const a = map.get(key); a ? a.push(value) : map.set(key, [value]); };
const periodLabel = p => `Q${Math.floor((+p.slice(5, 7) - 1) / 3) + 1} ${p.slice(0, 4)}`;

function prevPeriod(p) {
  let y = +p.slice(0, 4), q = Math.floor((+p.slice(5, 7) - 1) / 3) + 1;
  if (q === 1) [y, q] = [y - 1, 4];
  else q -= 1;
  const m = q * 3;
  return `${y}-${String(m).padStart(2, '0')}-${m === 3 || m === 12 ? 31 : 30}`;
}

async function loadDb(reload) {
  if (!DB || reload) {
    const r = await fetch('data.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('No data yet - run: python3 fetch.py');
    DB = indexDb(await r.json());
  }
  return DB;
}

function indexDb(raw) {
  const positions = raw.positions.map(values => {
    const r = {};
    raw.position_fields.forEach((f, i) => { r[f] = values[i]; });
    const sec = raw.securities[r.cusip];
    r.ticker = sec ? sec[0] : null;
    return r;
  });
  const byCikPeriod = new Map(), byPeriod = new Map();
  for (const r of positions) {
    push(byCikPeriod, r.cik + '|' + r.period, r);
    push(byPeriod, r.period, r);
  }
  const reports = new Map(), reportPeriods = new Map();
  for (const [cik, period, value, n_positions, filed, filings] of raw.reports) {
    reports.set(cik + '|' + period, { cik, period, value, n_positions, filed, filings });
    push(reportPeriods, cik, period);
  }
  for (const ps of reportPeriods.values()) ps.sort().reverse();
  return { ...raw, positions, byCikPeriod, byPeriod, reports, reportPeriods };
}

// Identify a security by ticker when known, so CUSIP changes (reverse splits, ADR -> ordinary share
// conversions) don't look like a full exit plus a new position.
const secKey = r => r.ticker || r.cusip;
const posKey = r => `${secKey(r)}|${r.put_call}|${r.sh_type}`;
const addPctCo = (a, b) => a == null && b == null ? null : (a || 0) + (b || 0);

// Collapse rows sharing a posKey (e.g. a fund holding both the ADR and ordinary line).
function mergePositions(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const k = posKey(r), a = out.get(k);
    if (!a) { out.set(k, { ...r }); continue; }
    if ((r.value || 0) > (a.value || 0)) Object.assign(a, { cusip: r.cusip, issuer: r.issuer, title_class: r.title_class });
    for (const f of ['shares', 'value', 'pct_port']) a[f] = (a[f] || 0) + (r[f] || 0);
    a.pct_co = addPctCo(a.pct_co, r.pct_co);
    a.pct_note = a.pct_note || r.pct_note;
  }
  return out;
}

const positionDict = r => ({
  cusip: r.cusip, sym: r.ticker, issuer: r.issuer, cls: r.title_class, put_call: r.put_call,
  sh_type: r.sh_type, shares: r.shares, value: r.value, pct_port: r.pct_port, pct_co: r.pct_co,
  so_shares: r.so_shares, so_as_of: r.so_as_of, pct_note: r.pct_note,
});

function fundInfo(db, cik) {
  const f = db.funds.find(x => x.cik === cik);
  if (!f) throw new Error(`Unknown fund ${cik}`);
  return f;
}

function topSymbols(db, cik, period, n = 4) {
  const rows = (db.byCikPeriod.get(cik + '|' + period) || []).slice().sort((a, b) => b.value - a.value);
  const out = [];
  for (const r of rows) {
    const sym = r.ticker || r.issuer;
    if (!out.includes(sym)) out.push(sym);
    if (out.length === n) break;
  }
  return out;
}

// --- views ----------------------------------------------------------------------------------

function apiMeta(db) {
  const filed = new Map();
  for (const r of db.reports.values()) push(filed, r.period, r.cik);
  return {
    funds: db.funds,
    periods: [...filed.keys()].sort().reverse().map(p => ({ period: p, label: periodLabel(p), filed: filed.get(p) })),
    quarters: db.quarters,
    updated_at: db.updated_at,
  };
}

function apiFunds(db) {
  return db.funds.map(f => {
    const ps = db.reportPeriods.get(f.cik) || [];
    if (!ps.length) return { ...f };
    const latest = db.reports.get(f.cik + '|' + ps[0]);
    const prev = ps[1] ? db.reports.get(f.cik + '|' + ps[1]) : null;
    return {
      ...f, period: latest.period, value: latest.value, n_positions: latest.n_positions, filed: latest.filed,
      prev_value: prev ? prev.value : null, top: topSymbols(db, f.cik, latest.period),
    };
  });
}

function apiManager(db, cik) {
  const manager = fundInfo(db, cik);
  const reps = (db.reportPeriods.get(cik) || []).slice(0, db.quarters + 1).map(p => db.reports.get(cik + '|' + p));
  return {
    manager,
    periods: reps.slice(0, db.quarters).map((r, i) => ({
      period: r.period, value: r.value, n_positions: r.n_positions, filed: r.filed, filings: r.filings,
      prev_value: reps[i + 1] ? reps[i + 1].value : null, top: topSymbols(db, cik, r.period),
    })),
  };
}

function apiFiling(db, cik, period, q) {
  const manager = fundInfo(db, cik);
  const available = db.reportPeriods.get(cik) || [];
  if (!available.includes(period)) throw new Error(`No 13F from ${manager.short} for ${periodLabel(period)}`);
  let compare = q.compare || available.find(p => p < period) || null;
  if (!available.includes(compare)) compare = null;
  const cur = mergePositions(db.byCikPeriod.get(cik + '|' + period));
  const prev = compare ? mergePositions(db.byCikPeriod.get(cik + '|' + compare)) : new Map();

  const rows = [], counts = {};
  for (const key of [...cur.keys(), ...[...prev.keys()].filter(k => !cur.has(k))]) {
    const a = cur.get(key), b = prev.get(key);
    const row = positionDict(a || b);
    if (!a) Object.assign(row, { shares: null, value: null, pct_port: null, pct_co: null, pct_note: null });
    Object.assign(row, {
      prev_shares: b ? b.shares : null, prev_value: b ? b.value : null,
      prev_pct_port: b ? b.pct_port : null, prev_pct_co: b ? b.pct_co : null,
    });
    row.status = !compare ? null : a && !b ? 'NEW' : b && !a ? 'EXIT'
      : a.shares > b.shares ? 'ADD' : a.shares < b.shares ? 'TRIM' : 'HOLD';
    const curSh = a ? a.shares : 0, prevSh = b ? b.shares : 0;
    row.d_shares = compare ? curSh - prevSh : null;
    row.d_pct = compare && prevSh ? (curSh - prevSh) / prevSh : null;
    counts[row.status] = (counts[row.status] || 0) + 1;
    rows.push(row);
  }
  const r = db.reports.get(cik + '|' + period);
  return {
    manager, period, compare, available: available.slice(0, db.quarters + 1),
    summary: {
      value: r.value, n_positions: r.n_positions, filed: r.filed, filings: r.filings,
      prev_value: compare ? db.reports.get(cik + '|' + compare).value : null, counts,
    },
    rows,
  };
}

function apiHistory(db, cik) {
  const manager = fundInfo(db, cik);
  const periods = (db.reportPeriods.get(cik) || []).slice(0, db.quarters).reverse();
  const rows = new Map();
  for (const period of periods) {  // oldest first, so rows end up labelled with their latest name/CUSIP
    for (const [key, r] of mergePositions(db.byCikPeriod.get(cik + '|' + period))) {
      let row = rows.get(key);
      if (!row) rows.set(key, row = { cells: {} });
      Object.assign(row, positionDict(r));
      row.cells[period] = { shares: r.shares, value: r.value, pct_port: r.pct_port, pct_co: r.pct_co };
    }
  }
  for (const row of rows.values()) {
    for (const k of ['shares', 'value', 'pct_port', 'pct_co', 'so_shares', 'so_as_of', 'pct_note']) delete row[k];
  }
  return { manager, periods, rows: [...rows.values()] };
}

function apiConsensus(db, q) {
  const all = db.funds.map(f => f.cik);
  const wanted = q.funds ? new Set(q.funds.split(',')) : null;
  const ciks = wanted ? all.filter(c => wanted.has(c)) : all;
  const short = Object.fromEntries(db.funds.map(f => [f.cik, f.short]));
  const period = q.period || [...db.reports.values()].map(r => r.period).sort().pop();
  if (!period || !ciks.length) return { period, rows: [], filed: [], missing: ciks };
  const prev = prevPeriod(period), calls = q.calls === '1';
  const filedIn = p => new Set(ciks.filter(c => db.reports.has(c + '|' + p)));
  const filed = { [period]: filedIn(period), [prev]: filedIn(prev) };
  const selected = new Set(ciks);

  // Long exposure = common/ADR share positions (optionally plus calls), aggregated per security.
  const data = new Map(), info = new Map();
  for (const p of [period, prev]) {
    for (const r of db.byPeriod.get(p) || []) {
      if (!selected.has(r.cik) || r.sh_type !== 'SH' || (r.put_call && !(calls && r.put_call === 'Call'))) continue;
      const key = secKey(r);
      let d = data.get(key);
      if (!d) data.set(key, d = { [period]: new Map(), [prev]: new Map() });
      let h = d[p].get(r.cik);
      if (!h) d[p].set(r.cik, h = { shares: 0, value: 0, pct_port: 0, pct_co: null, call_value: 0 });
      if (r.put_call) {
        h.call_value += r.value;
      } else {
        h.shares += r.shares;
        h.pct_co = addPctCo(h.pct_co, r.pct_co);
        h.pct_note = h.pct_note || r.pct_note;
      }
      h.value += r.value;
      h.pct_port += r.pct_port || 0;
      const seen = info.get(key);
      if (!seen || (p === period && (seen.period !== period || r.value > seen.value))) info.set(key, r);
    }
  }

  // Changes are only measured across funds that filed both quarters.
  const both = new Set([...filed[period]].filter(c => filed[prev].has(c)));
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const rows = [];
  for (const [key, d] of data) {
    const cur = d[period], before = d[prev];
    if (!cur.size) continue;
    const holders = [...cur].sort((a, b) => b[1].value - a[1].value).map(([cik, h]) => {
      const b = before.get(cik);
      const status = !filed[prev].has(cik) ? null : !b ? 'NEW'
        : h.shares > b.shares ? 'ADD' : h.shares < b.shares ? 'TRIM' : 'HOLD';
      return { ...h, cik, short: short[cik], status, d_shares: b ? h.shares - b.shares : null };
    });
    const prevHolders = [...before.keys()].filter(c => both.has(c));
    const curBoth = sum([...cur].filter(([c]) => both.has(c)), ([, h]) => h.shares);
    const prevBoth = sum(prevHolders, c => before.get(c).shares);
    const pctCos = [...cur.values()].map(h => h.pct_co).filter(v => v != null);
    const sumPct = sum(holders, h => h.pct_port);
    const r = info.get(key);
    rows.push({
      cusip: r.cusip, sym: r.ticker, issuer: r.issuer, cls: r.title_class,
      n: holders.length, n_prev: prevHolders.length,
      d_n: filed[prev].size ? [...cur.keys()].filter(c => both.has(c)).length - prevHolders.length : null,
      holders,
      exited: prevHolders.filter(c => !cur.has(c)).map(c => short[c]),
      new: holders.filter(h => h.status === 'NEW').map(h => h.short),
      value: sum(holders, h => h.value),
      shares: sum(holders, h => h.shares),
      sum_pct_port: sumPct,
      avg_pct_port: sumPct / holders.length,
      max_pct_port: Math.max(...holders.map(h => h.pct_port)),
      pct_co: pctCos.length ? pctCos.reduce((s, v) => s + v, 0) : null,
      pct_co_note: ([...cur.values()].find(h => h.pct_note) || {}).pct_note || null,
      d_shares_pct: prevBoth ? (curBoth - prevBoth) / prevBoth : null,
    });
  }
  return {
    period, prev, calls, funds: ciks, filed: [...filed[period]].sort(),
    missing: ciks.filter(c => !filed[period].has(c)), rows,
  };
}

function apiStock(db, cusip) {
  cusip = cusip.toUpperCase();
  const sec = db.securities[cusip];
  const ticker = sec ? sec[0] : null;
  const short = Object.fromEntries(db.funds.map(f => [f.cik, f.short]));
  const periods = [...new Set([...db.reports.values()].map(r => r.period))].sort().slice(-db.quarters);
  if (!periods.length) throw new Error('No data');
  const filed = Object.fromEntries(periods.map(p => [p, []]));
  for (const r of db.reports.values()) if (filed[r.period]) filed[r.period].push(r.cik);

  const inWindow = new Set(periods);
  const matches = db.positions
    .filter(r => (ticker ? r.ticker === ticker : r.cusip === cusip) && short[r.cik] && inWindow.has(r.period))
    .sort((a, b) => a.period < b.period ? -1 : a.period > b.period ? 1 : a.value - b.value);
  const rows = new Map();
  let latest = null;
  for (const r of matches) {
    const key = `${r.cik}|${r.put_call}|${r.sh_type}`;
    let row = rows.get(key);
    if (!row) rows.set(key, row = { cik: r.cik, short: short[r.cik], put_call: r.put_call, sh_type: r.sh_type, cells: {} });
    const cell = row.cells[r.period];
    if (cell) {  // same fund holds two CUSIPs of this security (e.g. ADR + ordinary)
      for (const f of ['shares', 'value', 'pct_port']) cell[f] = (cell[f] || 0) + (r[f] || 0);
      cell.pct_co = addPctCo(cell.pct_co, r.pct_co);
    } else {
      row.cells[r.period] = {
        shares: r.shares, value: r.value, pct_port: r.pct_port, pct_co: r.pct_co,
        so_shares: r.so_shares, so_as_of: r.so_as_of, pct_note: r.pct_note,
      };
    }
    latest = r;
  }
  if (!latest) throw new Error(`None of the tracked funds held ${cusip} in the last ${db.quarters} quarters`);
  const so = sec && sec[2] ? db.shares_outstanding[sec[2]] : null;
  return {
    cusip, sym: ticker, issuer: latest.issuer, cls: latest.title_class,
    security_type: sec ? sec[1] : null, issuer_cik: sec ? sec[2] : null,
    shares_outstanding: so ? { as_of: so[0], shares: so[1] } : null,
    periods, filed, rows: [...rows.values()],
  };
}

// Same paths the old Python API served, e.g. 'filing/0001263508/2026-06-30?compare=2026-03-31'.
async function localApi(path) {
  const db = await loadDb();
  const [p, qs] = path.split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  const [a, b, c] = p.split('/').filter(Boolean);
  if (a === 'meta') return apiMeta(db);
  if (a === 'funds') return apiFunds(db);
  if (a === 'consensus') return apiConsensus(db, q);
  if (a === 'manager' && c === 'history') return apiHistory(db, b);
  if (a === 'manager') return apiManager(db, b);
  if (a === 'filing') return apiFiling(db, b, c, q);
  if (a === 'stock') return apiStock(db, b);
  throw new Error('Page not found');
}
