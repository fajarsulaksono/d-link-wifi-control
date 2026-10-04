#!/usr/bin/env python3
"""Mock API WL-Router untuk menguji wlmac.sh tanpa perangkat nyata.

Meniru kontrak endpoint yang ter-reverse-engineer dari /routerweb/js/index.js:
  POST /cgi-bin/luci/admin/routerweb/login        -> {"result":0} / {"result":1,"err":1}
  GET  /cgi-bin/luci/admin/routerweb/deny_dev_list-> {"list":[{"mac":...}]}
  POST /cgi-bin/luci/admin/routerweb/deny_dev     -> {"result":0}

State awal (seed) bisa diatur lewat seed.json di direktori yang sama.
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORD = os.environ.get("MOCK_PASSWORD", "test123")
SEED = os.environ.get("MOCK_SEED", "")
# Menahan setiap respons. Dipakai test locking: proses yang memegang lock
# harus terlihat "masih bekerja" saat proses kedua mencoba acquiring.
DELAY = float(os.environ.get("MOCK_DELAY_MS", "0")) / 1000.0

# EXPIRE_AFTER: berapa kali request terautentikasi yang boleh berhasil, sebelum
# sesi berikutnya dibalas 500 text/plain ala sauth.lua. Meniru sesi yang
# kedaluwarsa di tengah proses yang sedang jalan.
EXPIRE_AFTER = int(os.environ.get("MOCK_EXPIRE_AFTER", "0"))
# Kalau 1, SETIAP request terautentikasi dibalas 500 sauth.lua: simulasi AP
# yang menolak semua sesi, untuk menguji jalur error yang tidak bisa dipulihkan.
ALWAYS_SESSION_ERROR = bool(os.environ.get("MOCK_ALWAYS_SESSION_ERROR"))

state = {"authed": False, "deny": [], "hits": 0, "expired": False}
if SEED:
    with open(SEED) as fh:
        state["deny"] = json.load(fh)

BASE = "/cgi-bin/luci/admin/routerweb"
log_lock = threading.Lock()


def log(msg):
    with log_lock:
        sys.stderr.write(f"[mock] {msg}\n")
        sys.stderr.flush()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if state["authed"]:
            self.send_header("Set-Cookie", "sysauth=MOCKSESSION; Path=/")
        self.end_headers()
        self.wfile.write(body)

    def _login_page(self):
        """Persis seperti perangkat: tanpa sesi -> HTML, bukan JSON."""
        body = b"<!DOCTYPE html><html><head><title>WL-Router</title></head></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sauth_error(self):
        """Persis seperti firmware asli: 500 text/plain + traceback Lua.

        Cookie ada tapi isinya tidak valid/ kedaluwarsa -> sauth.lua meledak
        dengan Security Exception, bukan 401 dan bukan halaman login HTML.
        Dikonfirmasi di 192.168.10.1 dengan cookie sysauth=abc.
        """
        body = (
            b"/usr/lib/lua/luci/sauth.lua:76: Security Exception: "
            b"Session ID is invalid!\nstack traceback:\n"
            b"\t[C]: in function 'assert'\n"
            b"\t/usr/lib/lua/luci/sauth.lua:76: in function 'read'\n"
            b"\t./lua/dispatcher.lua:476: in function 'dispatch'\n"
        )
        self.send_response(500)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _route(self):
        path = self.path.split("?")[0]
        if not path.startswith(BASE):
            return self._login_page()
        return path[len(BASE):]

    def _read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except Exception:
            return {}

    def _stall(self):
        """Tahan respons biar test punya jendela waktu yang bisa diprediksi."""
        if DELAY:
            time.sleep(DELAY)

    def _guard(self):
        if not state["authed"]:
            self._login_page()
            return False
        state["hits"] += 1
        if ALWAYS_SESSION_ERROR:
            self._sauth_error()
            return False
        # Sekali per sesi: request ke-n meledak, sesudahnya (setelah client
        # login ulang) normal lagi. Persis seperti sesi yang kedaluwarsa.
        if EXPIRE_AFTER and state["hits"] >= EXPIRE_AFTER and not state["expired"]:
            state["authed"] = False
            state["expired"] = True
            self._sauth_error()
            return False
        return True

    def do_GET(self):
        self._stall()
        route = self._route()
        if route == "/deny_dev_list":
            if not self._guard():
                return
            log(f"GET deny_dev_list -> {state['deny']}")
            # Mode purposefully-malformed untuk menguji guard di wlmac.sh:
            # .list sengaja mengembalikan string, bukan array.
            if os.environ.get("MOCK_MALFORMED"):
                return self._json({"result": 0, "list": "bukan-array"})
            # Firmware asli mengirim {"list":{}} — objek kosong — saat tidak ada
            # MAC yang diblokir (dikonfirmasi di 192.168.10.1). Terapkan quirk
            # ini supaya test tidak cepat menyimpulkan "harus selalu array".
            if not state["deny"] and not os.environ.get("MOCK_ALWAYS_ARRAY"):
                return self._json({"result": 0, "list": {}})
            return self._json({"result": 0, "list": state["deny"]})
        if route == "/associated_devs":
            if not self._guard():
                return
            return self._json({"result": 0, "list": [
                {"mac": "aa:bb:cc:dd:ee:01", "ip": "192.168.10.50",
                 "hostname": "LAPTOP-1", "time": "3600"},
                {"mac": "aa:bb:cc:dd:ee:02", "ip": "192.168.10.51",
                 "hostname": "PHONE-2", "time": "120"},
            ]})
        if route == "/sysinfo":
            if not self._guard():
                return
            return self._json({"result": 0, "model": "DIR-612F", "fw_ver": "1.01"})
        return self._login_page()

    def do_POST(self):
        self._stall()
        route = self._route()
        data = self._read_json()

        if route == "/login":
            if data.get("username") == "CMCCAdmin" and data.get("password") == PASSWORD:
                state["authed"] = True
                state["hits"] = 0
                # "expired" sengaja TIDAK direset: kedaluwarsa terjadi sekali
                # per lifetime mock, jadi retry client pasti berhasil.
                log("login OK")
                return self._json({"result": 0})
            log(f"login FAIL {data}")
            return self._json({"result": 1, "err": 1, "msg": "password error."})

        if route == "/deny_dev":
            if not self._guard():
                return
            mac = (data.get("mac") or "").lower()
            disabled = data.get("disabled")
            if not mac or disabled not in (0, 1):
                return self._json({"result": 2, "msg": "bad request"})
            # Devices asli selalu menyimpan list of objects {"mac": ...},
            # bukan string. Jaga bentuknya konsisten.
            if disabled == 1:
                if not any(e.get("mac") == mac for e in state["deny"]):
                    state["deny"].append({"mac": mac})
                log(f"BLOCK   {mac}")
            else:
                state["deny"] = [e for e in state["deny"] if e.get("mac") != mac]
                log(f"UNBLOCK {mac}")
            return self._json({"result": 0})

        return self._login_page()


if __name__ == "__main__":
    # Port 0 = minta port bebas dari OS, lalu tulis nomor aslinya ke file.
    # Ini menghindari balapan reuse-port antar test case.
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    srv = HTTPServer(("127.0.0.1", port), Handler)
    real_port = srv.server_address[1]

    port_file = os.environ.get("MOCK_PORT_FILE")
    if port_file:
        with open(port_file, "w") as fh:
            fh.write(str(real_port))

    log(f"listening on 127.0.0.1:{real_port} pass={PASSWORD} seed={state['deny']}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass