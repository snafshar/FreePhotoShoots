"""Server-side sessions, request protection, and form verification."""

from dataclasses import dataclass
from hashlib import sha256, scrypt
from hmac import compare_digest, digest
from pathlib import Path
import json
import os
import re
from secrets import randbelow, token_urlsafe
from time import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from starlette.exceptions import HTTPException

from .store import connect

SESSION_COOKIE = "silvergrain_session"
CSRF_COOKIE = "silvergrain_csrf"
SESSION_AGE = 12 * 60 * 60
CSRF_AGE = 12 * 60 * 60
CAPTCHA_AGE = 12 * 60
TOKEN = re.compile(r"[\w-]{32,128}", re.ASCII)
EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
PHONE = re.compile(r"\+?[0-9(). -]{3,30}")


@dataclass(frozen=True)
class Protection:
    db_path: Path
    secret: bytes
    secure_cookies: bool
    site_key: str
    captcha_key: str
    captcha_host: str

    @classmethod
    def from_environment(cls, db_path):
        with connect(db_path) as db:
            secret = bytes.fromhex(db.execute("SELECT value FROM settings WHERE key = 'secret'").fetchone()[0])
        site_key = os.getenv("TURNSTILE_SITE_KEY", "").strip()
        captcha_key = os.getenv("TURNSTILE_SECRET_KEY", "").strip()
        captcha_host = os.getenv("TURNSTILE_HOSTNAME", "").strip().lower()
        if any((site_key, captcha_key, captcha_host)) and not all((site_key, captcha_key, captcha_host)):
            raise RuntimeError("Set all three TURNSTILE variables to enable Turnstile.")
        secure = os.getenv("SECURE_COOKIES", "").lower() in ("true", "1")
        return cls(db_path, secret, secure, site_key, captcha_key, captcha_host)

    @property
    def csrf_cookie(self):
        return "__Host-" + CSRF_COOKIE if self.secure_cookies else CSRF_COOKIE

    @property
    def session_cookie(self):
        return "__Host-" + SESSION_COOKIE if self.secure_cookies else SESSION_COOKIE

    def sign(self, purpose, text):
        return digest(self.secret, f"{purpose}:{text}".encode(), "sha256").hex()

    def csrf(self, request):
        previous = getattr(request.state, "csrf_cookie", None) or request.cookies.get(self.csrf_cookie, "")
        if self.valid_csrf(previous):
            return previous
        payload = f"{int(time())}.{token_urlsafe(32)}"
        request.state.csrf_cookie = f"{payload}.{self.sign('csrf', payload)}"
        return request.state.csrf_cookie

    def valid_csrf(self, token):
        if not isinstance(token, str) or not re.fullmatch(r"[0-9]{1,12}\.[\w-]{43}\.[0-9a-f]{64}", token, re.ASCII):
            return False
        stamp, nonce, signature = token.split(".")
        age = int(time()) - int(stamp)
        return 0 <= age <= CSRF_AGE and compare_digest(signature, self.sign("csrf", f"{stamp}.{nonce}"))

    def protect_form(self, request, form):
        cookie = request.cookies.get(self.csrf_cookie, "")
        value = form.get("csrf", "")
        if (
            request.headers.get("sec-fetch-site") == "cross-site"
            or not self.valid_csrf(cookie)
            or not isinstance(value, str)
            or not value.isascii()
            or not compare_digest(cookie, value)
        ):
            raise HTTPException(403, "This form expired. Reload the page and try again.")

    def set_cookie(self, response, name, value, age):
        response.set_cookie(name, value, max_age=age, secure=self.secure_cookies, httponly=True, samesite="lax")

    def active_admin(self, request):
        token = request.cookies.get(self.session_cookie, "")
        if not TOKEN.fullmatch(token):
            return False
        with connect(self.db_path) as db:
            return db.execute(
                "SELECT 1 FROM sessions WHERE token_hash = ? AND expires > ?",
                (hash_token(token), int(time())),
            ).fetchone() is not None

    def new_session(self, response):
        token = token_urlsafe(32)
        now = int(time())
        with connect(self.db_path, write=True) as db:
            db.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
            db.execute("INSERT INTO sessions VALUES (?, ?)", (hash_token(token), now + SESSION_AGE))
        self.set_cookie(response, self.session_cookie, token, SESSION_AGE)

    def end_session(self, request, response):
        token = request.cookies.get(self.session_cookie, "")
        if TOKEN.fullmatch(token):
            with connect(self.db_path, write=True) as db:
                db.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))
        response.delete_cookie(self.session_cookie, secure=self.secure_cookies, httponly=True, samesite="lax")

    def allow(self, request, scope, limit, seconds):
        now = int(time())
        address = request.client.host if request.client else "unknown"
        key = self.sign("rate-limit", f"{scope}:{address}")
        window = now - now % seconds
        with connect(self.db_path, write=True) as db:
            db.execute("DELETE FROM rate_limits WHERE window < ?", (now - 86_400,))
            count = db.execute(
                """INSERT INTO rate_limits VALUES (?, ?, 1)
                   ON CONFLICT(key, window) DO UPDATE SET count = count + 1
                   RETURNING count""",
                (key, window),
            ).fetchone()[0]
        return count <= limit

    def contact_challenge(self, request):
        if self.site_key:
            return None
        first, second = randbelow(8) + 2, randbelow(8) + 2
        payload = f"{int(time())}.{token_urlsafe(24)}.{first}.{second}"
        signature = self.sign("contact-challenge", f"{self.csrf(request)}:{payload}")
        return (f"What is {first} + {second}?", f"{payload}.{signature}")

    def verify_contact(self, request, form):
        if self.site_key:
            return self.verify_turnstile(form.get("cf-turnstile-response", ""))
        token = form.get("challenge", "")
        answer = form.get("answer", "")
        if not isinstance(token, str) or not re.fullmatch(
            r"[0-9]{1,12}\.[\w-]{32}\.[2-9]\.[2-9]\.[0-9a-f]{64}", token, re.ASCII
        ):
            return False
        stamp, nonce, first, second, signature = token.split(".")
        now = int(time())
        payload = token.rsplit(".", 1)[0]
        expected = self.sign("contact-challenge", f"{self.csrf(request)}:{payload}")
        if not 0 <= now - int(stamp) <= CAPTCHA_AGE or not compare_digest(expected, signature):
            return False
        with connect(self.db_path, write=True) as db:
            db.execute("DELETE FROM captcha_attempts WHERE expires <= ?", (now,))
            used = db.execute(
                "INSERT OR IGNORE INTO captcha_attempts VALUES (?, ?)",
                (nonce, int(stamp) + CAPTCHA_AGE + 1),
            ).rowcount
        return bool(used and isinstance(answer, str) and answer.strip() == str(int(first) + int(second)))

    def verify_turnstile(self, token):
        if not isinstance(token, str) or not 1 <= len(token) <= 2048:
            return False
        body = urlencode({"secret": self.captcha_key, "response": token}).encode()
        request = Request("https://challenges.cloudflare.com/turnstile/v0/siteverify", data=body)
        try:
            with urlopen(request, timeout=5) as response:
                result = json.load(response)
        except (OSError, ValueError) as exc:
            raise HTTPException(503, "Verification is temporarily unavailable. Try again shortly.") from exc
        return (
            isinstance(result, dict)
            and result.get("success") is True
            and result.get("action") == "contact"
            and result.get("hostname") == self.captcha_host
        )


def hash_token(token):
    return sha256(token.encode()).hexdigest()


def _derive(password, salt):
    return scrypt(password.encode(), salt=salt, n=2**15, r=8, p=3, maxmem=64 * 1024 * 1024).hex()


def hash_password(password):
    salt = os.urandom(16)
    return f"{salt.hex()}.{_derive(password, salt)}"


def matches_password(password, stored):
    if not 1 <= len(password) <= 256:
        return False
    salt, expected = stored.split(".")
    return compare_digest(_derive(password, bytes.fromhex(salt)), expected)


def field(form, key, limit):
    value = form.get(key, "")
    if not isinstance(value, str):
        raise ValueError("Use text in this field.")
    value = value.strip()
    if len(value) > limit or "\x00" in value:
        label = key.replace("_", " ").capitalize()
        raise ValueError(f"{label} must be at most {limit} characters.")
    return value


def valid_email(value):
    return bool(len(value) <= 254 and EMAIL.fullmatch(value))
