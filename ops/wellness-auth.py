#!/usr/bin/env python3
"""One-time Wellness Project sign-in, run ON THE WORKSTATION (B8).

OAuth 2.1 + PKCE (S256), dynamic client registration, public client (no secret to store). The server
accepts a plain-http redirect only on localhost/127.0.0.1, which is why this cannot run on the headless
VPS. Writes wellness-tokens.json (mode 600); then:

    scp wellness-tokens.json vps:~/.hermes/.wellness-tokens.json
    ssh vps 'chmod 600 ~/.hermes/.wellness-tokens.json'

After that the bridge refreshes on its own. Token values are never printed.

    python ops/wellness-auth.py [--out wellness-tokens.json]
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import threading
import time
import urllib.parse
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wellness_core as wc  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="wellness-tokens.json")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()

    _s, _h, raw = wc._json_req(wc.AUTH_META_URL)
    meta = json.loads(raw)
    redirect = "http://127.0.0.1:%d/callback" % a.port
    _s, _h, raw = wc._json_req(meta["registration_endpoint"], "POST", {
        "client_name": "Nullsafe Wellness Bridge",
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    })
    client_id = json.loads(raw)["client_id"]

    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    q = urllib.parse.urlencode({
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect,
        "code_challenge": challenge, "code_challenge_method": "S256",
        "scope": "mcp offline_access", "state": state,
    })
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            p = urllib.parse.urlparse(self.path)
            if p.path != "/callback":
                self.send_response(404)
                self.end_headers()
                return
            qs = urllib.parse.parse_qs(p.query)
            got["code"] = (qs.get("code") or [None])[0]
            got["state"] = (qs.get("state") or [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Signed in. You can close this tab.")

        def log_message(self, *args):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", a.port), H)
    t = threading.Thread(target=srv.handle_request, daemon=True)
    t.start()
    url = meta["authorization_endpoint"] + "?" + q
    print("Opening the browser to approve. If it does not open, visit this URL:")
    print(url)
    webbrowser.open(url)
    t.join(timeout=300)
    if not got.get("code") or got.get("state") != state:
        print("No valid callback received.")
        return 1
    _s, _h, raw = wc._json_req(meta["token_endpoint"], "POST", {
        "grant_type": "authorization_code", "code": got["code"], "redirect_uri": redirect,
        "client_id": client_id, "code_verifier": verifier,
    }, form=True)
    r = json.loads(raw)
    if not r.get("refresh_token"):
        print("The server issued no refresh token; the bridge cannot run unattended.")
        return 1
    wc.write_tokens(a.out, {
        "client_id": client_id,
        "token_endpoint": meta["token_endpoint"],
        "access_token": r["access_token"],
        "refresh_token": r["refresh_token"],
        "expires_at": time.time() + int(r.get("expires_in", 3600)),
    })
    print("Wrote %s (mode 600). Copy it to the VPS as described in this file's header." % a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
