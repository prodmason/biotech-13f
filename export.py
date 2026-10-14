#!/usr/bin/env python3
"""Write static/data.json - everything the frontend needs - from data/13f.db.

fetch.py runs this automatically. Run it by hand after editing the fund list in config.json to
re-export without hitting SEC (funds must already have been fetched).
"""
import json
import os

from common import ROOT, connect, load_config

OUT_PATH = os.path.join(ROOT, "static", "data.json")
POSITION_FIELDS = ["cik", "period", "cusip", "put_call", "sh_type", "issuer", "title_class", "shares",
                   "value", "pct_port", "pct_co", "so_shares", "so_as_of", "pct_note"]


def export(conn, cfg):
    ciks = [f["cik"] for f in cfg["funds"]]
    marks = ",".join("?" * len(ciks))
    # One extra quarter beyond the display window so the oldest shown quarter has a comparison.
    periods = [r[0] for r in conn.execute(
        "SELECT DISTINCT period FROM reports WHERE cik IN (%s) ORDER BY period DESC LIMIT ?" % marks,
        ciks + [cfg["quarters"] + 1])]
    pmarks = ",".join("?" * len(periods)) or "''"

    managers = {r["cik"]: r for r in conn.execute("SELECT * FROM managers")}
    funds = [dict(f, sec_name=managers[f["cik"]]["name"], city=managers[f["cik"]]["city"],
                  state=managers[f["cik"]]["state"]) if f["cik"] in managers else dict(f)
             for f in cfg["funds"]]
    reports = [[r["cik"], r["period"], r["value"], r["n_positions"], r["filed"], json.loads(r["filings"])]
               for r in conn.execute("SELECT * FROM reports WHERE cik IN (%s) AND period IN (%s)"
                                     % (marks, pmarks), ciks + periods)]
    rows = conn.execute("SELECT %s FROM positions WHERE cik IN (%s) AND period IN (%s)"
                        " ORDER BY cik, period, value DESC" % (", ".join(POSITION_FIELDS), marks, pmarks),
                        ciks + periods).fetchall()
    positions = [[round(v, 7) if isinstance(v, float) else v for v in r] for r in rows]

    cusips = {r["cusip"] for r in rows}
    securities = {s["cusip"]: [s["ticker"], s["security_type"], s["issuer_cik"]]
                  for s in conn.execute("SELECT cusip, ticker, security_type, issuer_cik FROM securities")
                  if s["cusip"] in cusips}
    issuers = {v[2] for v in securities.values() if v[2]}
    shares_out = {}
    for cik, as_of, shares in conn.execute(
            "SELECT issuer_cik, as_of, shares FROM shares_outstanding ORDER BY issuer_cik, as_of"):
        if cik in issuers:
            shares_out[cik] = [as_of, shares]  # ordered by date, so the latest wins

    updated = conn.execute("SELECT value FROM meta WHERE key='updated_at'").fetchone()
    data = {
        "updated_at": updated[0] if updated else None,
        "quarters": cfg["quarters"],
        "funds": funds,
        "reports": reports,
        "position_fields": POSITION_FIELDS,
        "positions": positions,
        "securities": securities,
        "shares_outstanding": shares_out,
    }
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, OUT_PATH)
    return len(positions), os.path.getsize(OUT_PATH)


def main():
    n, size = export(connect(), load_config())
    print("Wrote %s: %d positions, %.1f MB" % (os.path.relpath(OUT_PATH, ROOT), n, size / 1e6))


if __name__ == "__main__":
    main()
