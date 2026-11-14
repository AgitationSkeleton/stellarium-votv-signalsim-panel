"""LAN-only access controls.

Layers (each independent):
1. Windows Firewall rule limited to LocalSubnet (installed by the deploy script).
2. Every request's peer address must be inside ``allowed_networks``.
3. The Host header must be an IP literal or a known name for this machine,
   which defeats DNS-rebinding attacks from web pages on other sites.
4. State-changing requests need a custom header (forces a CORS preflight we
   never grant) and a matching Origin when the browser sends one.
5. Stellarium control additionally needs a PIN-backed session cookie
   (HttpOnly, SameSite=Strict), with failed-PIN rate limiting.
"""
from __future__ import annotations

import hmac
import ipaddress
import secrets
import socket
import time
from collections import defaultdict, deque

from aiohttp import web

SESSION_COOKIE = "sp_session"
SESSION_SECONDS = 12 * 3600
CSRF_HEADER = "X-Panel-Request"

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
       "frame-ancestors 'none'; form-action 'self'")


class Guard:
    def __init__(self, config: dict):
        self.networks = [ipaddress.ip_network(net, strict=False) for net in config.get("allowed_networks", [])]
        hostname = socket.gethostname().lower()
        names = {"localhost", hostname, f"{hostname}.local", f"{hostname}.lan", f"{hostname}.home"}
        try:
            names.add(socket.getfqdn().lower())
        except OSError:
            pass
        names.update(name.lower() for name in config.get("allowed_hosts", []))
        self.host_names = names
        self.pin = str(config.get("control_pin") or "")
        self.sessions: dict[str, float] = {}
        self.failures: dict[str, deque] = defaultdict(deque)

    # -- network checks ------------------------------------------------------
    def peer_allowed(self, remote: str | None) -> bool:
        if not remote:
            return False
        try:
            address = ipaddress.ip_address(remote.split("%", 1)[0])
        except ValueError:
            return False
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        return any(address in network for network in self.networks)

    def host_allowed(self, host_header: str | None) -> bool:
        if not host_header:
            return False
        host = host_header.strip().lower()
        if host.startswith("["):  # [ipv6]:port
            host = host[1:host.find("]")] if "]" in host else host
        elif host.count(":") == 1:
            host = host.split(":", 1)[0]
        try:
            ipaddress.ip_address(host.split("%", 1)[0])
            return True
        except ValueError:
            return host in self.host_names

    # -- sessions ------------------------------------------------------------
    def control_enabled(self) -> bool:
        return len(self.pin) >= 4

    def is_authenticated(self, request: web.Request) -> bool:
        token = request.cookies.get(SESSION_COOKIE)
        expiry = self.sessions.get(token or "")
        if not expiry:
            return False
        if expiry < time.time():
            self.sessions.pop(token, None)
            return False
        return True

    def login(self, remote: str, pin: str) -> str | None:
        window = self.failures[remote]
        now = time.time()
        while window and now - window[0] > 300:
            window.popleft()
        if len(window) >= 5:
            raise web.HTTPTooManyRequests(text="Too many PIN attempts; wait five minutes.")
        if not self.control_enabled() or not hmac.compare_digest(pin.encode(), self.pin.encode()):
            window.append(now)
            return None
        window.clear()
        token = secrets.token_urlsafe(32)
        self.sessions = {k: v for k, v in self.sessions.items() if v > now}
        self.sessions[token] = now + SESSION_SECONDS
        return token

    def logout(self, request: web.Request) -> None:
        self.sessions.pop(request.cookies.get(SESSION_COOKIE, ""), None)


def build_middleware(guard: Guard):
    @web.middleware
    async def lan_only(request: web.Request, handler):
        if not guard.peer_allowed(request.remote):
            return web.Response(status=403, text="This panel only accepts connections from the local network.")
        if not guard.host_allowed(request.headers.get("Host")):
            return web.Response(status=421, text="Unrecognised host name.")
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            if request.headers.get(CSRF_HEADER) != "1":
                return web.json_response({"error": "missing request header"}, status=403)
            origin = request.headers.get("Origin")
            if origin and origin.split("://", 1)[-1].lower() != request.headers.get("Host", "").lower():
                return web.json_response({"error": "cross-origin request refused"}, status=403)
        response = await handler(request)
        if getattr(response, "prepared", False):
            return response   # streamed response: headers already sent
        # gzip larger JSON payloads (lists, sky, schedules); the LAN is Wi-Fi.
        if (isinstance(response, web.Response) and response.content_type == "application/json"
                and response.body is not None and len(response.body) > 2048
                and "gzip" in request.headers.get("Accept-Encoding", "")):
            response.enable_compression(web.ContentCoding.gzip)
        response.headers["Content-Security-Policy"] = CSP
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        path = request.path
        if path.startswith(("/static/fonts/", "/static/icons/")):
            response.headers.setdefault("Cache-Control", "public, max-age=2592000, immutable")
        elif path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        else:
            response.headers.setdefault("Cache-Control", "no-cache")
        return response

    return lan_only
