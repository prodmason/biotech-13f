"""Shared config, database schema and quarter helpers."""
import json
import os
import sqlite3
from datetime import date

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
DB_PATH = os.path.join(DATA_DIR, "13f.db")
CONFIG_PATH = os.path.join(ROOT, "config.json")

SCHEMA = """
CREATE TABLE IF NOT EXISTS managers (
  cik TEXT PRIMARY KEY, name TEXT, city TEXT, state TEXT, checked_at TEXT);

-- Raw filings and their information-table rows, exactly as reported.
CREATE TABLE IF NOT EXISTS filings (
  accession TEXT PRIMARY KEY, cik TEXT NOT NULL, period TEXT NOT NULL, form TEXT NOT NULL,
  filed TEXT NOT NULL, amendment_type TEXT, amendment_no INTEGER, report_type TEXT,
  table_value_total INTEGER, table_entry_total INTEGER, info_table TEXT, n_rows INTEGER,
  value_scaled INTEGER DEFAULT 0, fetched_at TEXT);
CREATE INDEX IF NOT EXISTS filings_cik_period ON filings(cik, period);
CREATE TABLE IF NOT EXISTS holdings (
  accession TEXT NOT NULL, issuer TEXT, title_class TEXT, cusip TEXT, value INTEGER,
  shares INTEGER, sh_type TEXT, put_call TEXT, discretion TEXT,
  vote_sole INTEGER, vote_shared INTEGER, vote_none INTEGER);
CREATE INDEX IF NOT EXISTS holdings_acc ON holdings(accession);

-- Derived: one row per manager-quarter-security after applying amendments.
CREATE TABLE IF NOT EXISTS positions (
  cik TEXT NOT NULL, period TEXT NOT NULL, cusip TEXT NOT NULL, put_call TEXT NOT NULL,
  sh_type TEXT NOT NULL, issuer TEXT, title_class TEXT, shares INTEGER, value INTEGER,
  pct_port REAL, pct_co REAL, so_shares INTEGER, so_as_of TEXT, pct_note TEXT,
  PRIMARY KEY (cik, period, cusip, put_call, sh_type));
CREATE INDEX IF NOT EXISTS positions_cusip ON positions(cusip, period);
CREATE INDEX IF NOT EXISTS positions_period ON positions(period);
CREATE TABLE IF NOT EXISTS reports (
  cik TEXT NOT NULL, period TEXT NOT NULL, value INTEGER, n_positions INTEGER,
  filed TEXT, filings TEXT, PRIMARY KEY (cik, period));

-- Reference data: CUSIP -> ticker (OpenFIGI), issuer shares outstanding (SEC XBRL).
CREATE TABLE IF NOT EXISTS securities (
  cusip TEXT PRIMARY KEY, ticker TEXT, figi_name TEXT, security_type TEXT,
  security_type2 TEXT, issuer_cik INTEGER, looked_up_at TEXT, source TEXT);
-- CUSIP -> symbol pairs harvested from SEC fails-to-deliver files (fallback for OpenFIGI gaps).
CREATE TABLE IF NOT EXISTS cusip_symbols (cusip TEXT PRIMARY KEY, symbol TEXT, description TEXT, file TEXT);
CREATE TABLE IF NOT EXISTS ftd_files (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS name_lookups (name TEXT PRIMARY KEY, cik INTEGER, looked_up_at TEXT);
CREATE TABLE IF NOT EXISTS shares_outstanding (
  issuer_cik INTEGER NOT NULL, as_of TEXT NOT NULL, source TEXT NOT NULL, shares INTEGER,
  form TEXT, filed TEXT, PRIMARY KEY (issuer_cik, as_of, source));
CREATE TABLE IF NOT EXISTS issuer_fetches (issuer_cik INTEGER PRIMARY KEY, fetched_at TEXT);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def load_config():
    with open(CONFIG_PATH) as f:
        cfg = json.load(f)
    for fund in cfg["funds"]:
        fund["cik"] = str(fund["cik"]).zfill(10)
    cfg.setdefault("quarters", 8)
    return cfg


def connect():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    if "source" not in {r[1] for r in conn.execute("PRAGMA table_info(securities)")}:
        conn.execute("ALTER TABLE securities ADD COLUMN source TEXT")
    return conn


def _quarter_end(year, q):
    m = q * 3
    return date(year, m, 31 if m in (3, 12) else 30)


def quarter_ends_back(n, today=None):
    """The last n completed calendar quarter ends, newest first."""
    today = today or date.today()
    y, q = today.year, (today.month - 1) // 3
    out = []
    while len(out) < n:
        if q == 0:
            y, q = y - 1, 4
        out.append(_quarter_end(y, q))
        q -= 1
    return out


def prev_period(period):
    y, m = int(period[:4]), int(period[5:7])
    q = (m - 1) // 3 + 1
    return (_quarter_end(y - 1, 4) if q == 1 else _quarter_end(y, q - 1)).isoformat()


def period_label(period):
    return "Q%d %s" % ((int(period[5:7]) - 1) // 3 + 1, period[:4])
