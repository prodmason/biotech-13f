#!/usr/bin/env python3
"""Pull 13F filings for the funds in config.json from SEC EDGAR into data/13f.db.

Incremental: filings already in the database are skipped, so re-running is cheap.

    python3 fetch.py                  # fetch new filings + refresh reference data
    python3 fetch.py --only 0001263508
    python3 fetch.py --refresh-shares # re-pull shares outstanding for every issuer
"""
import argparse
import gzip
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode, urljoin
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from common import connect, load_config, quarter_ends_back
from export import export

FORMS = ("13F-HR", "13F-HR/A")
# FIGI security types for which "% of company" (shares / shares outstanding) is meaningful.
EQUITY_TYPES2 = ("Common Stock", "Depositary Receipt")
SHARES_REFRESH_DAYS = 14
FIGI_RETRY_DAYS = 30


def log(msg):
    print(msg, flush=True)


def utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def now():
    return utcnow().replace(microsecond=0).isoformat() + "Z"


class Http:
    """Polite HTTP client: SEC asks for <= 10 requests/second and a descriptive User-Agent."""

    def __init__(self, user_agent, per_second=8):
        self.user_agent = user_agent
        self.min_interval = 1.0 / per_second
        self.last = 0.0

    def get(self, url, allow_404=False, data=None, headers=None, min_interval=None):
        for attempt in range(6):
            wait = self.last + (min_interval or self.min_interval) - time.time()
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            hdrs = {"User-Agent": self.user_agent, "Accept-Encoding": "gzip"}
            hdrs.update(headers or {})
            req = urllib.request.Request(url, data=data, headers=hdrs)
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    body = resp.read()
                    if resp.headers.get("Content-Encoding") == "gzip":
                        body = gzip.decompress(body)
                    return body
            except urllib.error.HTTPError as e:
                if e.code == 404 and allow_404:
                    return None
                if e.code == 429 or e.code >= 500:
                    delay = 60 if e.code == 429 and "openfigi" in url else 2 ** attempt
                    log("  HTTP %d for %s, retrying in %ds" % (e.code, url, delay))
                    time.sleep(delay)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                log("  %s for %s, retrying" % (e, url))
                time.sleep(2 ** attempt)
        raise RuntimeError("giving up on " + url)

    def json(self, url, allow_404=False, **kw):
        body = self.get(url, allow_404=allow_404, **kw)
        return None if body is None else json.loads(body)


# --- XML parsing ----------------------------------------------------------------------------

def parse_xml(body):
    root = ET.fromstring(body)
    for el in root.iter():  # namespaces vary by filer software; drop them
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def _int(s):
    s = (s or "").replace(",", "").strip()
    if not s:
        return None
    try:
        return int(round(float(s)))
    except ValueError:
        return None


def parse_primary_doc(root):
    t = lambda path: (root.findtext(path) or "").strip() or None
    return {
        "amendment_type": t(".//amendmentInfo/amendmentType"),
        "amendment_no": _int(t(".//amendmentNo")),
        "report_type": t(".//coverPage/reportType"),
        "table_value_total": _int(t(".//summaryPage/tableValueTotal")),
        "table_entry_total": _int(t(".//summaryPage/tableEntryTotal")),
        "name": t(".//coverPage/filingManager/name"),
    }


def parse_info_table(root):
    rows = []
    for it in root.iter("infoTable"):
        t = lambda tag: (it.findtext(tag) or "").strip()
        put_call = t("putCall").capitalize()
        rows.append({
            "issuer": t("nameOfIssuer"),
            "title_class": t("titleOfClass"),
            "cusip": t("cusip").upper(),
            "value": _int(t("value")) or 0,
            "shares": _int(t("shrsOrPrnAmt/sshPrnamt")) or 0,
            "sh_type": t("shrsOrPrnAmt/sshPrnamtType").upper() or "SH",
            "put_call": put_call if put_call in ("Put", "Call") else "",
            "discretion": t("investmentDiscretion"),
            "vote_sole": _int(t("votingAuthority/Sole")),
            "vote_shared": _int(t("votingAuthority/Shared")),
            "vote_none": _int(t("votingAuthority/None")),
        })
    return rows


def reported_in_thousands(rows):
    """Since 2023 values must be in dollars, but some filers still report $000. Detect that by
    the implied share price of plain stock positions being implausibly small."""
    prices = sorted(r["value"] / r["shares"] for r in rows
                    if r["sh_type"] == "SH" and not r["put_call"] and r["shares"] > 0 and r["value"] > 0)
    return len(prices) >= 5 and prices[len(prices) // 2] < 0.3


# --- Step 1: filings ------------------------------------------------------------------------

def fetch_manager(conn, http, cik, since):
    subs = http.json("https://data.sec.gov/submissions/CIK%s.json" % cik)
    biz = (subs.get("addresses") or {}).get("business") or {}
    conn.execute("INSERT OR REPLACE INTO managers VALUES (?,?,?,?,?)",
                 (cik, subs.get("name"), biz.get("city"), biz.get("stateOrCountry"), now()))
    pages = [subs["filings"]["recent"]]
    for extra in subs["filings"].get("files", []):
        if extra.get("filingTo", "9999") >= since:
            pages.append(http.json("https://data.sec.gov/submissions/" + extra["name"]))

    have = {r[0] for r in conn.execute("SELECT accession FROM filings WHERE cik=?", (cik,))}
    todo = []
    for pg in pages:
        for i, form in enumerate(pg["form"]):
            if form in FORMS and pg["reportDate"][i] >= since and pg["accessionNumber"][i] not in have:
                todo.append((pg["filingDate"][i], pg["accessionNumber"][i], form, pg["reportDate"][i]))
    log("%s: %d new 13F filing(s)" % (subs.get("name"), len(todo)))
    for filed, acc, form, period in sorted(todo):
        fetch_filing(conn, http, cik, acc, form, period, filed)
        conn.commit()


def fetch_filing(conn, http, cik, acc, form, period, filed):
    base = "https://www.sec.gov/Archives/edgar/data/%d/%s/" % (int(cik), acc.replace("-", ""))
    items = http.json(base + "index.json")["directory"]["item"]
    xmls = [it for it in items if it["name"].lower().endswith(".xml")]
    primary = {}
    if any(x["name"].lower() == "primary_doc.xml" for x in xmls):
        primary = parse_primary_doc(parse_xml(http.get(base + "primary_doc.xml")))

    rows, info_name = [], None
    candidates = [x for x in xmls if x["name"].lower() != "primary_doc.xml"]
    candidates.sort(key=lambda x: -int(x.get("size") or 0))
    for x in candidates:
        root = parse_xml(http.get(base + x["name"]))
        if root.tag == "informationTable":
            rows, info_name = parse_info_table(root), x["name"]
            break

    scaled = reported_in_thousands(rows)
    if scaled:
        log("  %s looks like it was reported in $000; scaling values x1000" % acc)
        for r in rows:
            r["value"] *= 1000

    log("  %s %-8s period %s filed %s: %d rows%s" % (
        acc, form, period, filed, len(rows),
        " (%s)" % primary["amendment_type"] if primary.get("amendment_type") else ""))
    conn.execute("DELETE FROM holdings WHERE accession=?", (acc,))
    conn.execute(
        "INSERT OR REPLACE INTO filings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (acc, cik, period, form, filed, primary.get("amendment_type"), primary.get("amendment_no"),
         primary.get("report_type"), primary.get("table_value_total"), primary.get("table_entry_total"),
         info_name, len(rows), int(scaled), now()))
    conn.executemany(
        "INSERT INTO holdings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [(acc, r["issuer"], r["title_class"], r["cusip"], r["value"], r["shares"], r["sh_type"],
          r["put_call"], r["discretion"], r["vote_sole"], r["vote_shared"], r["vote_none"]) for r in rows])


# --- Step 2: effective positions per manager-quarter ----------------------------------------

def effective_filings(filings, keys):
    """Apply amendments in filing order: a RESTATEMENT replaces the report, NEW HOLDINGS adds to it.
    Some filers label a full restatement NEW HOLDINGS (e.g. Logos Q2 2024 re-reported all 54
    original positions plus 3 more), so one that repeats most positions already on file also
    replaces the report instead of double-counting them. keys: accession -> {(cusip, put_call)}."""
    eff, base_rows = [], 0
    for f in filings:
        if not f["n_rows"]:
            continue  # cover-page-only amendment
        amend = (f["amendment_type"] or "").upper()
        have = set().union(*(keys[e["accession"]] for e in eff))
        if (f["form"] == "13F-HR" or "RESTATEMENT" in amend
                or (not amend and f["n_rows"] >= 0.5 * base_rows)
                or len(keys[f["accession"]] & have) > 0.5 * len(have)):
            eff, base_rows = [f], f["n_rows"]
        else:
            eff.append(f)
    return eff


def derive_positions(conn):
    conn.execute("DELETE FROM positions")
    conn.execute("DELETE FROM reports")
    groups = defaultdict(list)
    for f in conn.execute("SELECT * FROM filings ORDER BY filed, accession"):
        groups[(f["cik"], f["period"])].append(f)
    keys = defaultdict(set)
    for acc, cusip, put_call in conn.execute("SELECT accession, cusip, put_call FROM holdings"):
        keys[acc].add((cusip, put_call or ""))

    for (cik, period), filings in groups.items():
        eff = effective_filings(filings, keys)
        if not eff:
            continue
        applied = {f["accession"] for f in eff}
        agg = {}
        for f in eff:
            for h in conn.execute("SELECT * FROM holdings WHERE accession=?", (f["accession"],)):
                key = (h["cusip"], h["put_call"] or "", h["sh_type"] or "SH")
                a = agg.setdefault(key, {"issuer": h["issuer"], "title_class": h["title_class"],
                                         "shares": 0, "value": 0})
                a["shares"] += h["shares"] or 0
                a["value"] += h["value"] or 0
        total = sum(a["value"] for a in agg.values())
        conn.executemany(
            "INSERT INTO positions (cik, period, cusip, put_call, sh_type, issuer, title_class, shares,"
            " value, pct_port) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [(cik, period, k[0], k[1], k[2], a["issuer"], a["title_class"], a["shares"], a["value"],
              a["value"] / total if total else None) for k, a in agg.items()])
        conn.execute("INSERT INTO reports VALUES (?,?,?,?,?,?)", (
            cik, period, total, len(agg), filings[0]["filed"],
            json.dumps([{"accession": f["accession"], "form": f["form"], "filed": f["filed"],
                         "amendment_type": f["amendment_type"], "n_rows": f["n_rows"],
                         "applied": f["accession"] in applied} for f in filings])))
    conn.commit()


# --- Step 3: CUSIP -> ticker via OpenFIGI ---------------------------------------------------

US_EXCHANGES = {"US", "UN", "UQ", "UW", "UA", "UR", "UP", "UF", "UV", "UD", "UX", "UB", "UM", "UT"}


def pick_figi(data):
    """Prefer the US composite listing. Equities that only map to foreign listings (tickers like
    'NUVLEUR') keep their security type but no ticker, so the fallbacks below can fill it in."""
    for codes in ({"US"}, US_EXCHANGES):
        hit = next((d for d in data if d.get("exchCode") in codes), None)
        if hit:
            return hit
    if not data:
        return {}
    first = dict(data[0])
    if first.get("marketSector") == "Equity":
        first["ticker"] = None
    return first


def map_cusips(conn, http, api_key):
    retry_before = (utcnow() - timedelta(days=FIGI_RETRY_DAYS)).isoformat()
    cusips = [r[0] for r in conn.execute(
        "SELECT DISTINCT p.cusip FROM positions p LEFT JOIN securities s ON s.cusip = p.cusip"
        " WHERE s.cusip IS NULL OR (s.ticker IS NULL AND s.looked_up_at < ?)", (retry_before,))]
    if not cusips:
        return
    # Without a key OpenFIGI allows 25 requests/minute of 10 jobs each.
    batch, interval = (100, 0.3) if api_key else (10, 2.6)
    log("Mapping %d CUSIPs to tickers via OpenFIGI (~%d min)..."
        % (len(cusips), max(1, len(cusips) / batch * interval / 60)))
    # Don't forward the SEC User-Agent (which carries your contact details) to OpenFIGI.
    headers = {"Content-Type": "application/json", "User-Agent": "biotech-13f-tracker"}
    if api_key:
        headers["X-OPENFIGI-APIKEY"] = api_key
    for i in range(0, len(cusips), batch):
        chunk = cusips[i:i + batch]
        body = json.dumps([{"idType": "ID_CUSIP", "idValue": c} for c in chunk]).encode()
        results = http.json("https://api.openfigi.com/v3/mapping", data=body, headers=headers,
                            min_interval=interval)
        for cusip, job in zip(chunk, results):
            pick = pick_figi(job.get("data") or [])
            conn.execute(
                "INSERT OR REPLACE INTO securities (cusip, ticker, figi_name, security_type, security_type2,"
                " looked_up_at, source) VALUES (?,?,?,?,?,?,?)",
                (cusip, pick.get("ticker"), pick.get("name"), pick.get("securityType"),
                 pick.get("securityType2"), now(), "figi" if pick.get("ticker") else None))
        conn.commit()
        if (i // batch) % 10 == 9:
            log("  %d/%d" % (min(i + batch, len(cusips)), len(cusips)))


def infer_type(title_class):
    """Rough security type from the 13F title of class, for CUSIPs OpenFIGI doesn't know."""
    c = (title_class or "").upper()
    if re.search(r"\bADR|\bADS|SPON|DEPOSIT", c):
        return "Depositary Receipt"
    if re.search(r"\*W|WARR|\bWTS?\b|RIGHT|\bRTS?\b|UNIT|NOTE|DEBT|BOND|PFD|PREF|%|CONV", c):
        return "Other"
    if re.search(r"COM|ORD|\bSHS?\b|SHARE|STOCK|STK|\bCL [A-Z]\b|CLASS", c):
        return "Common Stock"
    return None


FTD_PAGE = "https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data"


def parse_ftd_zip(body, name):
    rows = []
    with zipfile.ZipFile(io.BytesIO(body)) as z:
        for member in z.namelist():
            for line in z.read(member).decode("latin-1").splitlines()[1:]:
                parts = [x.strip() for x in line.split("|")]
                if len(parts) >= 5 and parts[1] and parts[2]:
                    rows.append((parts[1].upper(), parts[2], parts[4], name))
    return rows


def map_cusips_ftd(conn, http, since):
    """SEC fails-to-deliver files list CUSIP + symbol for most US-traded securities, including
    warrants, rights and delisted names that OpenFIGI doesn't cover. Scan newest-first and stop
    once every unmapped CUSIP is found (processed files are remembered)."""
    classes = defaultdict(list)
    for cusip, cls in conn.execute(
            "SELECT s.cusip, p.title_class FROM securities s JOIN positions p ON p.cusip = s.cusip"
            " WHERE s.security_type2 IS NULL").fetchall():
        classes[cusip].append(infer_type(cls))
    for cusip, types in classes.items():
        types = [t for t in types if t]
        conn.execute("UPDATE securities SET security_type2=? WHERE cusip=?",
                     (max(set(types), key=types.count) if types else None, cusip))

    def unresolved():
        return {r[0] for r in conn.execute(
            "SELECT s.cusip FROM securities s LEFT JOIN cusip_symbols c ON c.cusip = s.cusip"
            " WHERE s.ticker IS NULL AND c.cusip IS NULL")}

    todo = unresolved()
    if todo:
        done = {r[0] for r in conn.execute("SELECT name FROM ftd_files")}
        page = http.get(FTD_PAGE).decode("utf-8", "replace")
        links = re.findall(r'href="([^"]*/(cnsfails(\d{6})[ab]\.zip))"', page)
        files = sorted({(name, path) for path, name, ym in links
                        if ym >= since[:7].replace("-", "") and name not in done}, reverse=True)
        if files:
            log("Looking up %d unmapped CUSIPs in SEC fails-to-deliver data..." % len(todo))
        for name, path in files:
            body = http.get(urljoin(FTD_PAGE, path), allow_404=True)
            rows = parse_ftd_zip(body, name) if body else []
            # newest file first, so INSERT OR IGNORE keeps the most recent symbol
            conn.executemany("INSERT OR IGNORE INTO cusip_symbols VALUES (?,?,?,?)", rows)
            conn.execute("INSERT INTO ftd_files VALUES (?)", (name,))
            conn.commit()
            todo = unresolved()
            log("  %s: %d still unmapped" % (name, len(todo)))
            if not todo:
                break
    conn.execute("UPDATE securities SET source='ftd', ticker=(SELECT symbol FROM cusip_symbols c"
                 " WHERE c.cusip = securities.cusip) WHERE ticker IS NULL"
                 " AND cusip IN (SELECT cusip FROM cusip_symbols)")
    conn.commit()


NAME_STOPWORDS = {"INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED", "PLC",
                  "SA", "NV", "AG", "AB", "AS", "SE", "SPA", "LLC", "LP", "THE", "HOLDINGS", "HOLDING",
                  "GROUP", "NEW", "DEL", "ADR", "ADS", "A", "S", "N", "V"}


def norm_name(name):
    words = re.sub(r"[^A-Z0-9]+", " ", (name or "").upper().replace("&", " AND ")).split()
    return " ".join(w for w in words if w not in NAME_STOPWORDS)


def map_issuer_ciks(conn, http):
    """Issuer CIK (needed for shares outstanding) via ticker, falling back to an exact match on
    the normalized issuer name against SEC's company list."""
    by_ticker, by_name, title_of = {}, {}, {}
    for v in http.json("https://www.sec.gov/files/company_tickers.json").values():
        by_ticker.setdefault(v["ticker"].upper(), v["cik_str"])
        by_name.setdefault(norm_name(v["title"]), (v["cik_str"], v["ticker"]))
        title_of.setdefault(v["cik_str"], v["title"])
    issuers = dict(conn.execute("SELECT cusip, MAX(issuer) FROM positions GROUP BY cusip").fetchall())
    for s in conn.execute("SELECT * FROM securities").fetchall():
        issuer, ticker, source, cik = issuers.get(s["cusip"], ""), s["ticker"], s["source"], None
        if ticker:
            cik = by_ticker.get(ticker.upper().replace("/", "-").replace(".", "-"))
            # Fails-to-deliver symbols can be stale (tickers get reused), so require the names to agree.
            if cik and source == "ftd" and norm_name(issuer)[:1] and \
                    norm_name(issuer).split()[0] != (norm_name(title_of[cik]).split() or [""])[0]:
                cik = None
        if not cik and s["security_type2"] in EQUITY_TYPES2:
            hit = by_name.get(norm_name(issuer))
            if hit:
                cik = hit[0]
                if not ticker:
                    ticker, source = hit[1], "name"
        if not cik and s["security_type2"] in EQUITY_TYPES2:
            cik = search_edgar_cik(conn, http, issuer)
        conn.execute("UPDATE securities SET issuer_cik=?, ticker=?, source=? WHERE cusip=?",
                     (cik, ticker, source, s["cusip"]))
    conn.commit()


def search_edgar_cik(conn, http, issuer):
    """EDGAR entity-name search, for issuers that dropped out of company_tickers.json (acquired,
    delisted). Accepts a hit only if the normalized names agree (13F names may be truncated)."""
    key = norm_name(issuer)
    if len(key) < 6:
        return None
    row = conn.execute("SELECT cik FROM name_lookups WHERE name=?", (key,)).fetchone()
    if row:
        return row[0]
    d = http.json("https://efts.sec.gov/LATEST/search-index?" + urlencode({"keysTyped": key}), allow_404=True)
    cik = None
    for hit in ((d or {}).get("hits") or {}).get("hits", []):
        other = norm_name(hit["_source"].get("entity"))
        short, longer = sorted((key, other), key=len)
        if other and len(short) >= 6 and (longer + " ").startswith(short + " ") or (
                len(short) >= 20 and longer.startswith(short)):
            cik = int(hit["_id"])
            break
    conn.execute("INSERT OR REPLACE INTO name_lookups VALUES (?,?,?)", (key, cik, now()))
    return cik


# --- Step 4: shares outstanding and % of company --------------------------------------------

SO_CONCEPTS = (("dei", "EntityCommonStockSharesOutstanding"), ("us-gaap", "CommonStockSharesOutstanding"))
SO_FALLBACK_CONCEPTS = SO_CONCEPTS + (("ifrs-full", "NumberOfSharesOutstanding"),)


def fetch_shares_outstanding(conn, http, refresh_all=False):
    """Issuers never fetched, plus (every SHARES_REFRESH_DAYS) issuers held in the latest two
    quarters - older quarters' share counts don't change."""
    fresh_after = (utcnow() - timedelta(days=SHARES_REFRESH_DAYS)).isoformat()
    recent = [r[0] for r in conn.execute("SELECT DISTINCT period FROM reports ORDER BY period DESC LIMIT 2")]
    ciks = [r[0] for r in conn.execute(
        "SELECT DISTINCT s.issuer_cik FROM securities s"
        " JOIN positions p ON p.cusip = s.cusip AND p.put_call = '' AND p.sh_type = 'SH'"
        " LEFT JOIN issuer_fetches f ON f.issuer_cik = s.issuer_cik"
        " WHERE s.issuer_cik IS NOT NULL AND s.security_type2 IN (?, ?)"
        " AND (? OR f.fetched_at IS NULL OR (f.fetched_at < ? AND p.period IN (%s)))"
        % ",".join("?" * len(recent)),
        EQUITY_TYPES2 + (int(refresh_all), fresh_after) + tuple(recent))]
    if not ciks:
        return
    log("Fetching shares outstanding for %d issuers..." % len(ciks))
    for n, cik in enumerate(ciks, 1):
        facts = []
        for taxonomy, concept in SO_CONCEPTS:
            d = http.json("https://data.sec.gov/api/xbrl/companyconcept/CIK%010d/%s/%s.json"
                          % (cik, taxonomy, concept), allow_404=True)
            facts += [(taxonomy, f) for f in ((d or {}).get("units") or {}).get("shares", [])]
        if not facts:
            # companyconcept is sometimes empty when the full companyfacts document has the data
            d = http.json("https://data.sec.gov/api/xbrl/companyfacts/CIK%010d.json" % cik, allow_404=True)
            for taxonomy, concept in SO_FALLBACK_CONCEPTS:
                units = (((d or {}).get("facts") or {}).get(taxonomy, {}).get(concept) or {}).get("units") or {}
                facts += [(taxonomy, f) for f in units.get("shares", [])]
        conn.executemany("INSERT OR REPLACE INTO shares_outstanding VALUES (?,?,?,?,?,?)",
                         [(cik, f["end"], taxonomy, f["val"], f.get("form"), f.get("filed")) for taxonomy, f in facts])
        conn.execute("INSERT OR REPLACE INTO issuer_fetches VALUES (?,?)", (cik, now()))
        if n % 50 == 0:
            conn.commit()
            log("  %d/%d" % (n, len(ciks)))
    conn.commit()


def compute_pct_company(conn):
    """% of company = shares held / shares outstanding, using the shares-outstanding data point
    closest to the quarter end (balance-sheet value at quarter end, else the 10-Q/10-K cover)."""
    so = defaultdict(list)
    for cik, as_of, source, shares in conn.execute(
            "SELECT issuer_cik, as_of, source, shares FROM shares_outstanding WHERE shares > 0"):
        so[cik].append((date.fromisoformat(as_of), source, shares))

    updates = []
    for r in conn.execute(
            "SELECT p.rowid, p.period, p.shares, s.issuer_cik, s.security_type2 FROM positions p"
            " JOIN securities s ON s.cusip = p.cusip"
            " WHERE p.put_call = '' AND p.sh_type = 'SH' AND s.issuer_cik IS NOT NULL"):
        if r["security_type2"] not in EQUITY_TYPES2 or not so.get(r["issuer_cik"]):
            continue
        period = date.fromisoformat(r["period"])
        as_of, source, shares_out = min(
            so[r["issuer_cik"]], key=lambda x: (abs((x[0] - period).days), x[1] != "us-gaap"))
        days = abs((as_of - period).days)
        if days > 400:
            continue
        notes = []
        if r["security_type2"] == "Depositary Receipt":
            notes.append("ADR: depositary ratio not applied")
        if days > 120:
            notes.append("stale share count")
        updates.append((r["shares"] / shares_out, shares_out, as_of.isoformat(),
                        "; ".join(notes) or None, r["rowid"]))
    conn.execute("UPDATE positions SET pct_co=NULL, so_shares=NULL, so_as_of=NULL, pct_note=NULL")
    conn.executemany("UPDATE positions SET pct_co=?, so_shares=?, so_as_of=?, pct_note=? WHERE rowid=?",
                     updates)
    conn.commit()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="only fetch filings for this manager CIK")
    ap.add_argument("--refresh-shares", action="store_true", help="re-pull shares outstanding for all issuers")
    args = ap.parse_args()

    cfg = load_config()
    user_agent = os.environ.get("SEC_USER_AGENT") or cfg["sec_user_agent"]
    if "example.com" in user_agent:
        log("Note: set sec_user_agent in config.json to your name + email (SEC fair-access policy).")
    http = Http(user_agent)
    conn = connect()
    # One extra quarter beyond the display window so the oldest shown quarter has a comparison.
    since = quarter_ends_back(cfg["quarters"] + 2)[-1].isoformat()

    funds = [f for f in cfg["funds"] if not args.only or f["cik"] == args.only.zfill(10)]
    for fund in funds:
        try:
            fetch_manager(conn, http, fund["cik"], since)
        except Exception as e:  # keep going so one bad filer doesn't block the rest
            log("ERROR fetching %s (%s): %s" % (fund.get("name"), fund["cik"], e))

    derive_positions(conn)
    map_cusips(conn, http, os.environ.get("OPENFIGI_API_KEY") or cfg.get("openfigi_api_key"))
    map_cusips_ftd(conn, http, since)
    map_issuer_ciks(conn, http)
    fetch_shares_outstanding(conn, http, args.refresh_shares)
    compute_pct_company(conn)
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('updated_at', ?)", (now(),))
    conn.commit()
    n_pos, n_rep = conn.execute("SELECT COUNT(*), COUNT(DISTINCT cik || period) FROM positions").fetchone()
    n_exported, size = export(conn, cfg)
    log("Done: %d positions across %d manager-quarters; exported %d to static/data.json (%.1f MB)."
        % (n_pos, n_rep, n_exported, size / 1e6))


if __name__ == "__main__":
    sys.exit(main())
