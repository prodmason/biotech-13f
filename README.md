# Biotech 13F Tracker

A 13F tracker for a hand-picked set of biotech funds, modeled on 13f.info. No dependencies:
just Python 3 (standard library only), SQLite, and a vanilla-JS static site.

```
python3 fetch.py     # pull/refresh filings from SEC EDGAR (incremental), then export static/data.json
python3 server.py    # open http://localhost:8013
```

The site itself is static: `static/` plus the generated `static/data.json`. All the views are
computed in the browser, so it can be hosted anywhere. Here that's GitHub Pages, refreshed daily
by a GitHub Action (see [Publishing](#publishing-github-pages)).

## Views

- **Consensus** (home page): long positions held across the selected funds for a given quarter.
  - Columns: # holders, change in holder count vs. the prior quarter, each fund's portfolio
    weight (green = new position, ▲/▼ = added/trimmed, struck-through = exited), Σ portfolio
    weight (a conviction-weighted score), combined % of the company, and net share change.
  - Fund chips toggle which funds count. Your selection is remembered.
- **Fund page**: 13f.info-style list of the last 8 quarterly 13Fs (holdings, value, top
  holdings, form type, date filed, and SEC links). The **Holdings history** tab is a security ×
  quarter matrix of value, % of portfolio, shares, or % of company.
- **13F view** (click a quarter): every holding with Value, %, Shares, Principal, and Option
  Type, plus:
  - % of company owned
  - the change vs. last quarter, or any other quarter you pick: prior shares, Δ shares, Δ %,
    prior % of portfolio, Δ % of company, and status (NEW / ADD / TRIM / EXIT / HOLD)
  - exited positions as their own rows
- **Stock page** (click any ticker): current holders across tracked funds, plus an 8-quarter
  holder matrix with totals.

Every table sorts on column-header click, filters with the search box (all words must match),
and exports to CSV. The top search box searches every security held by any tracked fund.

## Configuration: `config.json`

- `funds`: list of `{cik, short, name}`. To add a fund, look up its CIK on
  [EDGAR](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=13F-HR), add it, then
  run `fetch.py` (or **Refresh data** locally; on GitHub, just push the change).
- `sec_user_agent`: SEC asks automated clients to identify themselves with a name and email.
  Leave the placeholder in this public file and set the `SEC_USER_AGENT` environment variable
  (or GitHub secret) instead, e.g. `Jane Doe jane@example.com`.
- `openfigi_api_key` (optional): a free key from openfigi.com makes ticker lookups about 10× faster.
  Also settable as the `OPENFIGI_API_KEY` environment variable (or GitHub secret).
- `quarters`: how many quarters to show (default 8). One extra quarter is fetched so the oldest
  quarter shown still has a comparison.

## Data notes

- **Source**: SEC EDGAR 13F-HR information tables.
  - Amendments are applied: a RESTATEMENT replaces the quarter's report, while NEW HOLDINGS
    adds to it.
  - Rows for the same security, option type, and share type are summed.
- **Tickers**: OpenFIGI first. CUSIPs OpenFIGI doesn't cover fall back to SEC fails-to-deliver
  data, then an exact issuer-name match against SEC's company list.
- **Matching across quarters**: positions are matched by ticker, so a CUSIP change (reverse
  split, or an ADR converted to ordinary shares like ASND in Q2 2026) isn't shown as an exit
  plus a new position.
- **% of company** = shares held ÷ shares outstanding, using the SEC XBRL data point closest to
  the quarter end (balance-sheet `CommonStockSharesOutstanding`, else the 10-Q/10-K cover-page
  count).
  - Marked `*` when approximate. ADRs don't apply the depositary ratio, and 20-F filers only
    report a share count once a year.
  - Excludes pre-funded warrants and non-13F securities, so funds' true economic stakes are
    often higher.
  - Covers ~98% of long value. Gaps are mostly multi-class issuers (e.g. NUVL, KNSA), which
    report share counts per class.
- **13F limits**: these are long US-listed equity, option, and convertible positions only, with a
  45-day lag. There are no shorts or private holdings, and option rows show the underlying's
  notional value.
- Values are shown in $000 (like 13f.info). Since 2023 filers report in dollars. A filing that
  still reports in $000 is detected and scaled automatically.

## Publishing (GitHub Pages)

`.github/workflows/update.yml` runs `fetch.py` daily at 13:00 UTC, on every push to `main`, and on
demand. It then deploys `static/` to GitHub Pages. The SQLite database is carried between runs in
the Actions cache, so runs stay incremental. If the cache is evicted, the run rebuilds it (~20 min).

One-time setup in the repo:

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → New repository secret:**
   - `SEC_USER_AGENT`: your name and email, e.g. `Jane Doe jane@example.com`.
   - Optional: `OPENFIGI_API_KEY`.
3. **Actions → "Update data and deploy" → Run workflow** for the first build. After that it runs
   on its own.

GitHub pauses scheduled workflows in repos with no activity for 60 days. If that happens you'll
get an email; re-enable the workflow from the Actions tab, or push any commit.

## Files

- `fetch.py`: EDGAR → `data/13f.db` pipeline, then calls `export.py`. It's safe to re-run;
  already-loaded filings are skipped.
- `export.py`: writes `static/data.json` from the database. Run it on its own to re-export after
  editing `config.json` without hitting SEC.
- `server.py`: local static server plus the **Refresh data** endpoint.
- `static/`: the site (`index.html`, `data.js` = data layer/view logic, `app.js` = UI, `style.css`).
- `data/13f.db`: SQLite database (not committed). Delete it to rebuild from scratch.
