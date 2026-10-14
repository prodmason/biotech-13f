#!/usr/bin/env python3
"""Serve the tracker locally: the static site in static/ plus a "Refresh data" endpoint that runs
fetch.py in the background. (The published site on GitHub Pages is the same static files.)

    python3 server.py              # http://localhost:8013
    python3 server.py --port 9000 --no-browser
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from common import DATA_DIR, ROOT, load_config

STATIC = os.path.join(ROOT, "static")
FETCH_LOG = os.path.join(DATA_DIR, "fetch.log")

_refresh = {"proc": None}
_refresh_lock = threading.Lock()


def refresh_status():
    p = _refresh["proc"]
    tail = ""
    if os.path.exists(FETCH_LOG):
        with open(FETCH_LOG, errors="replace") as f:
            tail = "".join(f.readlines()[-8:])
    return {"running": bool(p and p.poll() is None), "exit_code": p.poll() if p else None, "log": tail}


def start_refresh():
    with _refresh_lock:
        p = _refresh["proc"]
        if not (p and p.poll() is None):
            os.makedirs(DATA_DIR, exist_ok=True)
            log = open(FETCH_LOG, "w")
            _refresh["proc"] = subprocess.Popen([sys.executable, "-u", os.path.join(ROOT, "fetch.py")],
                                                cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    return refresh_status()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC, **kwargs)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/api/refresh":
            return self.send_json(refresh_status())
        super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path == "/api/refresh":
            return self.send_json(start_refresh())
        self.send_json({"error": "not found"}, 404)


def main():
    cfg = load_config()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=cfg.get("port", 8013))
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = "http://localhost:%d/" % args.port
    print("Biotech 13F tracker running at %s (Ctrl-C to stop)" % url, flush=True)
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
