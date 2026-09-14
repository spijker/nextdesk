import pytest
from fastapi import Request
from httpx import AsyncClient

from app.routers.auth import _is_secure, _nextcloud_origin, _safe_next_path


def _make_request(headers: dict[str, str] | None = None, scheme: str = "http") -> Request:
    raw_headers = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    scope = {
        "type": "http", "method": "GET", "path": "/", "query_string": b"",
        "headers": raw_headers, "scheme": scheme, "server": ("test", 80),
    }
    return Request(scope)


# ── _safe_next_path — post-login redirect target validation ────────────────

def test_safe_next_path_allows_relative_path():
    assert _safe_next_path("/?open=/Docs/f.docx") == "/?open=/Docs/f.docx"


@pytest.mark.parametrize("bad", [
    None, "", "not-a-path",
    "//evil.com", "https://evil.com", "/\\evil.com", "/a/\\b",
])
def test_safe_next_path_rejects_unsafe_targets(bad):
    assert _safe_next_path(bad) is None


# ── _nextcloud_origin — embed-return-URL origin resolution ──────────────────

def test_nextcloud_origin_prefers_configured_url():
    assert _nextcloud_origin("https://cloud.example.com/") == "https://cloud.example.com"


def test_nextcloud_origin_falls_back_to_oidc_issuer(monkeypatch):
    monkeypatch.setattr("app.routers.auth.settings.oidc_issuer", "https://idp.example.com/oidc")
    assert _nextcloud_origin("") == "https://idp.example.com"


def test_nextcloud_origin_empty_when_nothing_configured(monkeypatch):
    monkeypatch.setattr("app.routers.auth.settings.oidc_issuer", "")
    assert _nextcloud_origin("") == ""


# ── _is_secure — cookie Secure/SameSite basis (see nginx X-Forwarded-Proto) ──

def test_is_secure_true_behind_https_proxy():
    assert _is_secure(_make_request({"x-forwarded-proto": "https"})) is True


def test_is_secure_true_for_direct_https():
    assert _is_secure(_make_request(scheme="https")) is True


def test_is_secure_false_for_plain_http():
    assert _is_secure(_make_request()) is False


# ── /api/auth/methods — footer_text is exposed for the login page ──────────

@pytest.mark.asyncio
async def test_auth_methods_includes_footer_text(client: AsyncClient):
    r = await client.get("/api/auth/methods")
    assert r.status_code == 200
    assert "footer_text" in r.json()
