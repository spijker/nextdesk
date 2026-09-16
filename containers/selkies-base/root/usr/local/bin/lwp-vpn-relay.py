#!/usr/bin/env python3
"""
lwp-vpn-relay — per-session SOCKS5 switchboard for the per-user VPN gateway.

Apps in this container are pointed at socks5h://127.0.0.1:1081 (this relay)
instead of the gateway directly. Per connection the relay either:

  - DIRECT:  resolves the target locally and dials it straight out, or
  - VPN:     chains the CONNECT to the upstream gateway SOCKS5
             (LWP_VPN_UPSTREAM, e.g. socks5h://vpn:1080) with the hostname
             passed through, so DNS resolves inside the tunnel.

Which one is decided by the per-session toggle in the LWP desktop (shield
button on the window titlebar): the relay polls
GET $LWP_BACKEND_URL/api/sessions/vpn/mode with its session token every 2 s.
Until the first successful poll the mode comes from LWP_VPN_DEFAULT (off
unless set to 1/on/true).

Stdlib only, CONNECT command only (no BIND / UDP ASSOCIATE — ocproxy has no
UDP anyway). Exits 0 immediately when LWP_VPN_UPSTREAM is not set (session
launched without a live gateway).
"""
import asyncio
import ipaddress
import json
import os
import socket
import struct
import sys
import threading
import time
import urllib.request

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("LWP_VPN_RELAY_PORT", "1081"))

UPSTREAM = os.environ.get("LWP_VPN_UPSTREAM", "")
BACKEND = os.environ.get("LWP_BACKEND_URL", "").rstrip("/")
TOKEN = os.environ.get("LWP_SESSION_TOKEN", "")

# Flipped by the poller thread; bool read/write is atomic in CPython.
vpn_on = str(os.environ.get("LWP_VPN_DEFAULT", "")).lower() in ("1", "on", "true")

# Open piped connections, so a mode flip can kill them: browsers keep
# keep-alive/HTTP2 pools open for minutes and would otherwise stay on the old
# path long after the toggle. Closing forces a clean reconnect the new way.
_loop: asyncio.AbstractEventLoop | None = None
_active: set[asyncio.StreamWriter] = set()


def _drop_active() -> None:
    n = len(_active)
    for w in list(_active):
        try:
            w.close()
        except Exception:
            pass
    if n:
        print(f"[lwp-vpn-relay] dropped {n} open connection(s) after mode change",
              flush=True)


def _poll_mode() -> None:
    global vpn_on
    url = f"{BACKEND}/api/sessions/vpn/mode"
    req = urllib.request.Request(url, headers={"X-Session-Token": TOKEN})
    while True:
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                mode = json.loads(r.read().decode())
                enabled = bool(mode.get("enabled"))
                if enabled != vpn_on:
                    print(f"[lwp-vpn-relay] mode -> {'VPN' if enabled else 'DIRECT'}",
                          flush=True)
                    vpn_on = enabled
                    if _loop is not None:
                        _loop.call_soon_threadsafe(_drop_active)
        except Exception:
            pass  # backend briefly unreachable — keep last known mode
        time.sleep(2)


# ── SOCKS5 plumbing ───────────────────────────────────────────────────────────

async def _read_exact(reader: asyncio.StreamReader, n: int) -> bytes:
    return await reader.readexactly(n)


async def _read_request(reader, writer):
    """Greeting + request. Returns (host, port) or None (error already sent)."""
    ver, nmethods = struct.unpack("!BB", await _read_exact(reader, 2))
    await _read_exact(reader, nmethods)  # discard offered methods
    if ver != 5:
        return None
    writer.write(b"\x05\x00")  # no-auth
    await writer.drain()

    ver, cmd, _rsv, atyp = struct.unpack("!BBBB", await _read_exact(reader, 4))
    if ver != 5 or cmd != 1:  # CONNECT only
        writer.write(b"\x05\x07\x00\x01" + b"\x00" * 6)  # command not supported
        await writer.drain()
        return None
    if atyp == 1:  # IPv4
        host = socket.inet_ntoa(await _read_exact(reader, 4))
    elif atyp == 3:  # domain
        ln = (await _read_exact(reader, 1))[0]
        # keep bytes 1:1 — clients send ASCII (IDN is pre-encoded by the app)
        host = (await _read_exact(reader, ln)).decode("latin-1")
    elif atyp == 4:  # IPv6
        host = socket.inet_ntop(socket.AF_INET6, await _read_exact(reader, 16))
    else:
        writer.write(b"\x05\x08\x00\x01" + b"\x00" * 6)  # address type not supported
        await writer.drain()
        return None
    port = struct.unpack("!H", await _read_exact(reader, 2))[0]
    return host, port


def _reply(code: int) -> bytes:
    return struct.pack("!BBBB", 5, code, 0, 1) + b"\x00\x00\x00\x00\x00\x00"


async def _connect_upstream(host: str, port: int):
    """CONNECT via the gateway SOCKS5, hostname passed through (tunnel DNS)."""
    up_host, _, up_port = UPSTREAM.split("://", 1)[-1].partition(":")
    r, w = await asyncio.open_connection(up_host, int(up_port or 1080))
    try:
        w.write(b"\x05\x01\x00")
        await w.drain()
        if (await _read_exact(r, 2))[1] != 0:
            raise ConnectionError("upstream refused no-auth")
        try:
            addr = ipaddress.ip_address(host)
            if addr.version == 4:
                dst = b"\x01" + socket.inet_aton(host)
            else:
                dst = b"\x04" + socket.inet_pton(socket.AF_INET6, host)
        except ValueError:
            raw = host.encode("latin-1")
            dst = b"\x03" + bytes([len(raw)]) + raw
        w.write(b"\x05\x01\x00" + dst + struct.pack("!H", port))
        await w.drain()
        resp = await _read_exact(r, 4)
        if resp[1] != 0:
            raise ConnectionError(f"upstream reply {resp[1]}")
        # swallow the bound address
        if resp[3] == 1:
            await _read_exact(r, 4 + 2)
        elif resp[3] == 3:
            ln = (await _read_exact(r, 1))[0]
            await _read_exact(r, ln + 2)
        elif resp[3] == 4:
            await _read_exact(r, 16 + 2)
        return r, w
    except BaseException:
        w.close()
        raise


async def _pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def _handle(reader, writer):
    remote_w = None
    try:
        req = await _read_request(reader, writer)
        if req is None:
            return
        host, port = req
        try:
            if vpn_on:
                remote_r, remote_w = await asyncio.wait_for(
                    _connect_upstream(host, port), 20)
            else:
                remote_r, remote_w = await asyncio.wait_for(
                    asyncio.open_connection(host, port), 20)
        except Exception:
            writer.write(_reply(5))  # connection refused
            await writer.drain()
            return
        writer.write(_reply(0))
        await writer.drain()
        _active.add(writer)
        _active.add(remote_w)
        await asyncio.gather(_pipe(reader, remote_w), _pipe(remote_r, writer))
    except (asyncio.IncompleteReadError, ConnectionError, OSError):
        pass
    finally:
        for w in (writer, remote_w):
            _active.discard(w)
            try:
                if w is not None:
                    w.close()
            except Exception:
                pass


async def main():
    global _loop
    _loop = asyncio.get_running_loop()
    server = await asyncio.start_server(_handle, LISTEN_HOST, LISTEN_PORT)
    print(f"[lwp-vpn-relay] listening on {LISTEN_HOST}:{LISTEN_PORT} "
          f"upstream={UPSTREAM} default={'VPN' if vpn_on else 'DIRECT'}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    if not UPSTREAM:
        # No live gateway at launch — nothing to relay, don't hold the port.
        sys.exit(0)
    if BACKEND and TOKEN:
        threading.Thread(target=_poll_mode, daemon=True).start()
    asyncio.run(main())
