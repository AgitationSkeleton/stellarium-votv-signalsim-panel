"""Shared outbound HTTP settings.

Python's default TLS context only sees the certificates already present in
the Windows store and, unlike browsers, never asks Windows to download a
missing root. JAXA's chain ends at SECOM roots that a freshly installed
Windows may not have cached yet, so outbound sessions also trust the Mozilla
CA bundle (certifi, already installed alongside aiohttp) in addition to the
Windows store.
"""
from __future__ import annotations

import ssl

import aiohttp

USER_AGENT = "stellarium-votv-signalsim-panel/1.0 (self-hosted LAN console)"


def _build_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    try:
        import certifi
        context.load_verify_locations(cafile=certifi.where())
    except Exception:
        pass
    return context


SSL_CONTEXT = _build_context()


def client_session(timeout: aiohttp.ClientTimeout | None = None, **kwargs) -> aiohttp.ClientSession:
    headers = {"User-Agent": USER_AGENT, **kwargs.pop("headers", {})}
    return aiohttp.ClientSession(timeout=timeout or aiohttp.ClientTimeout(total=30, connect=10),
                                 connector=aiohttp.TCPConnector(ssl=SSL_CONTEXT), headers=headers, **kwargs)
