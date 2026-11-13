"""Public journal pages and the authenticated publishing dashboard."""

from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from time import time
from urllib.parse import quote, urlencode
import os
import re
import unicodedata

from dotenv import load_dotenv
from jinja2 import Environment, FileSystemLoader, select_autoescape
from python_multipart.exceptions import MultipartParseError
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import ClientDisconnect
from starlette.responses import HTMLResponse, RedirectResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import store
from .security import CSRF_AGE, PHONE, Protection, field, matches_password, valid_email

load_dotenv()
ROOT = Path(__file__).resolve().parent.parent
CATEGORIES = ("Landscape", "Architecture", "Street", "Portrait", "Seascape", "Other")
PAGE_SIZE = 9
COMMENTS_PER_PAGE = 25
MAX_REQUEST = (store.MAX_PHOTOS * store.MAX_PHOTO_BYTES) + 1024 * 1024
BASE_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; "
    "font-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'"
)
TURNSTILE_CSP = BASE_CSP.replace("script-src 'self'", "script-src 'self' https://challenges.cloudflare.com")
TURNSTILE_CSP += "; frame-src https://challenges.cloudflare.com"
templates = Environment(loader=FileSystemLoader(ROOT / "journal/templates"), autoescape=select_autoescape())


def display_date(value):
    try:
        day = datetime.fromtimestamp(value, timezone.utc).date() if isinstance(value, int) else date.fromisoformat(value)
    except (TypeError, ValueError):
        return ""
    return f"{day.strftime('%b')} {day.day}, {day.year}"


templates.filters["display_date"] = display_date
templates.globals.update(photo_url=store.photo_url, categories=CATEGORIES, current_year=lambda: date.today().year)


@asynccontextmanager
async def lifespan(app):
    directory = Path(os.getenv("DATA_DIR", "data")).expanduser().resolve()
    app.state.db = store.initialize(directory, demo=os.getenv("SEED_DEMO", "1") == "1")
    app.state.protection = Protection.from_environment(app.state.db)
    yield


def protection(request):
    return request.app.state.protection


def render(request, template, status=200, **values):
    with store.connect(request.app.state.db) as db:
        site = store.public_settings(db)
        admin_exists = db.execute("SELECT 1 FROM admin").fetchone() is not None if template == "login.html" else None
    context = {
        "request": request, "site": site, "active": "", "title": "Silvergrain",
        "csrf": protection(request).csrf(request) if values.get("form", False) else "",
        "is_admin": protection(request).active_admin(request), "admin_exists": admin_exists,
        **values,
    }
    response = HTMLResponse(templates.get_template(template).render(**context), status_code=status)
    response.headers["Cache-Control"] = "no-store"
    csrf_cookie = getattr(request.state, "csrf_cookie", None)
    if csrf_cookie:
        protection(request).set_cookie(response, protection(request).csrf_cookie, csrf_cookie, CSRF_AGE)
    return response


def read_cards(db, *, limit, offset=0, category=""):
    return db.execute(
        f"""SELECT {store.CARD_FIELDS} {store.CARD_FROM}
            WHERE p.published_at IS NOT NULL AND (? = '' OR p.category = ?)
            ORDER BY p.published_at DESC, p.id DESC LIMIT ? OFFSET ?""",
        (category, category, limit, offset),
    ).fetchall()


def home(request):
    with store.connect(request.app.state.db) as db:
        cards = read_cards(db, limit=4)
    return render(request, "home.html", active="home", cards=cards)


def journal(request):
    category = request.query_params.get("category", "")
    if category and category not in CATEGORIES:
        raise HTTPException(404, "This category does not exist.")
    page = request.path_params.get("page", 1)
    with store.connect(request.app.state.db) as db:
        count = db.execute(
            """SELECT count(*) FROM posts WHERE published_at IS NOT NULL
               AND (? = '' OR category = ?)""", (category, category),
        ).fetchone()[0]
        page_count = max(1, (count + PAGE_SIZE - 1) // PAGE_SIZE)
        if not 1 <= page <= page_count:
            raise HTTPException(404, "This journal page does not exist.")
        cards = read_cards(db, limit=PAGE_SIZE, offset=(page - 1) * PAGE_SIZE, category=category)
        used = {row[0] for row in db.execute("SELECT DISTINCT category FROM posts WHERE published_at IS NOT NULL")}
    return render(
        request, "journal.html", active="journal", title="Journal", cards=cards, page=page,
        page_count=page_count, category=category, used_categories=[name for name in CATEGORIES if name in used],
        query=f"?{urlencode({'category': category})}" if category else "",
    )


def show_post(request, *, error="", submitted=None, status=200):
    slug = request.path_params["slug"]
    page_text = request.query_params.get("comments", "1")
    if not re.fullmatch(r"[1-9][0-9]{0,7}", page_text):
        raise HTTPException(404, "This comments page does not exist.")
    comment_page = int(page_text)
    with store.connect(request.app.state.db) as db:
        post = db.execute("SELECT * FROM posts WHERE slug = ?", (slug,)).fetchone()
        if post is None or (post["published_at"] is None and not protection(request).active_admin(request)):
            raise HTTPException(404, "This story is unavailable.")
        photos = store.photos_for(db, post["id"])
        comment_count = db.execute(
            "SELECT count(*) FROM comments WHERE post_id = ? AND status = 'approved'", (post["id"],),
        ).fetchone()[0]
        comment_pages = max(1, (comment_count + COMMENTS_PER_PAGE - 1) // COMMENTS_PER_PAGE)
        if comment_page > comment_pages:
            raise HTTPException(404, "This comments page does not exist.")
        comments = db.execute(
            """SELECT * FROM comments WHERE post_id = ? AND status = 'approved'
               ORDER BY id DESC LIMIT ? OFFSET ?""",
            (post["id"], COMMENTS_PER_PAGE, (comment_page - 1) * COMMENTS_PER_PAGE),
        ).fetchall()
        neighbors = (None, None)
        if post["published_at"] is not None:
            where = "WHERE published_at IS NOT NULL AND (published_at, id)"
            key = (post["published_at"], post["id"])
            newer = db.execute(
                f"SELECT slug, title FROM posts {where} > (?, ?) ORDER BY published_at, id LIMIT 1", key,
            ).fetchone()
            older = db.execute(
                f"SELECT slug, title FROM posts {where} < (?, ?) ORDER BY published_at DESC, id DESC LIMIT 1", key,
            ).fetchone()
            neighbors = (newer, older)
    return render(
        request, "post.html", status, title=post["title"], active="journal", form=post["published_at"] is not None,
        post=post, photos=photos, comments=comments, comment_count=comment_count, comment_page=comment_page,
        comment_pages=comment_pages, neighbors=neighbors, error=error,
        submitted=submitted or {}, sent=request.query_params.get("comment") == "sent",
    )


def media(request):
    variant = request.path_params.get("variant", "")
    if variant not in ("", "small"):
        raise HTTPException(404)
    column = "thumb" if variant == "small" else "full"
    with store.connect(request.app.state.db) as db:
        photo = db.execute(
            f"""SELECT f.{column} AS content, p.published_at FROM photos AS f
                JOIN posts AS p ON p.id = f.post_id WHERE f.id = ?""",
            (request.path_params["photo_id"],),
        ).fetchone()
    if not photo or photo["content"] is None or (photo["published_at"] is None and not protection(request).active_admin(request)):
        raise HTTPException(404)
    return Response(photo["content"], media_type="image/webp", headers={"Cache-Control": "private, no-store"})


@asynccontextmanager
async def read_form(request, *, uploads=False):
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "Reload the page to submit the form.")
    content_type = request.headers.get("content-type", "").split(";", 1)[0]
    if content_type not in ("application/x-www-form-urlencoded", "multipart/form-data"):
        raise HTTPException(415, "Use the journal's form to submit your information.")
    limit = MAX_REQUEST if uploads else 65_536
    content_length = request.headers.get("content-length")
    if content_length and (not content_length.isdecimal() or len(content_length) > 12 or int(content_length) > limit):
        raise HTTPException(413, "This submission is too large.")
    # Limit streamed bodies as well, so uploads need no trusted Content-Length.
    total = 0

    async def receive():
        nonlocal total
        message = await request.receive()
        total += len(message.get("body", b""))
        if total > limit:
            raise HTTPException(413, "This submission is too large.")
        return message

    limited_request = type(request)(request.scope, receive)
    try:
        async with limited_request.form(max_files=store.MAX_PHOTOS if uploads else 0, max_fields=110, max_part_size=65_536) as form:
            protection(request).protect_form(request, form)
            yield form
    except ClientDisconnect as exc:
        raise HTTPException(400, "The upload was interrupted. Try again.") from exc
    except MultipartParseError as exc:
        raise HTTPException(400, "The upload could not be read. Try again.") from exc


def _add_comment(request, form):
    slug = request.path_params["slug"]
    with store.connect(request.app.state.db) as db:
        post = db.execute("SELECT id FROM posts WHERE slug = ? AND published_at IS NOT NULL", (slug,)).fetchone()
    if post is None:
        raise HTTPException(404)
    if not protection(request).allow(request, "comment", 8, 900):
        raise HTTPException(429, "Please wait a few minutes before commenting again.")
    if form.get("company"):
        return RedirectResponse(f"/stories/{slug}?comment=sent#comments", 303)
    try:
        name, body = field(form, "name", 60), field(form, "body", 1500)
        if not (name and body):
            raise ValueError("Enter your name and comment.")
    except ValueError as exc:
        return show_post(request, error=str(exc), submitted=form, status=400)
    with store.connect(request.app.state.db, write=True) as db:
        result = db.execute(
            """INSERT INTO comments (post_id, name, body, created_at)
               SELECT id, ?, ?, ? FROM posts WHERE id = ? AND published_at IS NOT NULL""",
            (name, body, int(time()), post["id"]),
        )
        if result.rowcount != 1:
            raise HTTPException(404)
    return RedirectResponse(f"/stories/{slug}?comment=sent#comments", 303)


async def comment(request):
    async with read_form(request) as form:
        return await run_in_threadpool(_add_comment, request, form)


def contact(request, *, error="", submitted=None, status=200):
    shield = protection(request)
    return render(
        request, "contact.html", status, title="Contact", active="contact", form=True, error=error,
        submitted=submitted or {}, sent=request.query_params.get("message") == "sent",
        site_key=shield.site_key, challenge=shield.contact_challenge(request),
    )


def _add_message(request, form):
    shield = protection(request)
    if not shield.allow(request, "contact", 8, 900):
        raise HTTPException(429, "Please wait a few minutes before sending another message.")
    if form.get("company"):
        return RedirectResponse("/contact?message=sent#contact-form", 303)
    try:
        name, email, body = field(form, "name", 60), field(form, "email", 254), field(form, "body", 3000)
        if not name or not body or not valid_email(email):
            raise ValueError("Enter your name, a valid email, and a message.")
        if not shield.verify_contact(request, form):
            raise ValueError("The verification did not pass. Try the new challenge.")
    except ValueError as exc:
        return contact(request, error=str(exc), submitted=form, status=400)
    with store.connect(request.app.state.db, write=True) as db:
        db.execute(
            "INSERT INTO messages (name, email, body, created_at) VALUES (?, ?, ?, ?)",
            (name, email, body, int(time())),
        )
    return RedirectResponse("/contact?message=sent#contact-form", 303)


async def send_contact(request):
    async with read_form(request) as form:
        return await run_in_threadpool(_add_message, request, form)


def require_admin(request):
    if not protection(request).active_admin(request):
        raise HTTPException(303, headers={"Location": "/admin/sign-in"})


def login_page(request, *, error="", status=200):
    if protection(request).active_admin(request):
        return RedirectResponse("/admin", 303)
    return render(request, "login.html", status, title="Admin sign in", form=True, error=error)


def _sign_in(request, form):
    shield = protection(request)
    if not shield.allow(request, "sign-in", 7, 900):
        return login_page(request, error="Too many attempts. Try again in a few minutes.", status=429)
    with store.connect(request.app.state.db) as db:
        admin = db.execute("SELECT username, password_hash FROM admin").fetchone()
    username, password = form.get("username", ""), form.get("password", "")
    if (
        not admin or not isinstance(username, str) or not isinstance(password, str)
        or len(username) > 60 or not matches_password(password, admin["password_hash"])
        or username.casefold() != admin["username"].casefold()
    ):
        return login_page(request, error="The username or password was incorrect.", status=400)
    response = RedirectResponse("/admin", 303)
    shield.new_session(response)
    return response


async def sign_in(request):
    async with read_form(request) as form:
        return await run_in_threadpool(_sign_in, request, form)


async def sign_out(request):
    require_admin(request)
    async with read_form(request):
        response = RedirectResponse("/admin/sign-in", 303)
        await run_in_threadpool(protection(request).end_session, request, response)
    return response


def admin_page(request, *, error="", status=200):
    require_admin(request)
    section = request.path_params.get("section", "stories")
    if section not in ("stories", "comments", "inbox", "settings"):
        raise HTTPException(404)
    tab = request.query_params.get("view", "all")
    if tab not in ("all", "published", "draft"):
        tab = "all"
    with store.connect(request.app.state.db) as db:
        counts = dict(db.execute(
            """SELECT 'published', count(*) FROM posts WHERE published_at IS NOT NULL
               UNION ALL SELECT 'draft', count(*) FROM posts WHERE published_at IS NULL
               UNION ALL SELECT 'pending', count(*) FROM comments WHERE status = 'pending'
               UNION ALL SELECT 'unread', count(*) FROM messages WHERE read_at IS NULL"""
        ))
        entries = []
        if section == "stories":
            condition = {"published": "WHERE p.published_at IS NOT NULL", "draft": "WHERE p.published_at IS NULL"}.get(tab, "")
            entries = db.execute(
                f"SELECT {store.CARD_FIELDS} {store.CARD_FROM} {condition} ORDER BY p.updated_at DESC, p.id DESC"
            ).fetchall()
        elif section == "comments":
            entries = db.execute(
                """SELECT c.*, p.slug, p.title FROM comments AS c JOIN posts AS p ON p.id = c.post_id
                   ORDER BY CASE WHEN c.status = 'pending' THEN 0 ELSE 1 END, c.id DESC"""
            ).fetchall()
        elif section == "inbox":
            entries = db.execute("SELECT * FROM messages ORDER BY id DESC").fetchall()
    return render(
        request, "admin.html", status, title="Dashboard", active="admin", section=section, form=True,
        entries=entries, counts=counts, tab=tab, error=error,
        notice={
            "saved": "Story saved.", "deleted": "Story deleted.", "moderated": "Comment updated.",
            "read": "Message updated.", "settings": "Contact details saved.",
        }.get(request.query_params.get("saved")),
    )


def get_post(db, post_id):
    post = db.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone() if post_id is not None else None
    if post_id is not None and post is None:
        raise HTTPException(404)
    return post


def editor(request, *, error="", submitted=None, status=200):
    require_admin(request)
    post_id = request.path_params.get("post_id")
    with store.connect(request.app.state.db) as db:
        post = get_post(db, post_id)
        photos = store.photos_for(db, post_id) if post else []
    values = {
        "title": "", "caption": "", "story": "", "category": "Landscape", "location": "",
        "photo_date": date.today().isoformat(),
        **(dict(post) if post else {}),
    }
    if submitted is not None:
        for key in ("title", "caption", "story", "category", "location", "photo_date"):
            value = submitted.get(key, "")
            if isinstance(value, str):
                values[key] = value
    return render(
        request, "editor.html", status, title="Edit story" if post else "New story", active="admin",
        post=post, values=values, photos=photos, form=True, error=error,
        reselect=submitted is not None and any(
            isinstance(item, UploadFile) and item.filename for item in submitted.getlist("photos")
        ),
    )


def slug_for(db, title):
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    base = re.sub(r"[^a-z0-9]+", "-", ascii_title).strip("-")[:75].strip("-") or "story"
    slug, suffix = base, 2
    while db.execute("SELECT 1 FROM posts WHERE slug = ?", (slug,)).fetchone():
        slug = f"{base}-{suffix}"
        suffix += 1
    return slug


def _story_fields(form):
    values = {key: field(form, key, limit) for key, limit in (
        ("title", 100), ("caption", 300), ("story", 12_000), ("location", 100), ("photo_date", 10), ("category", 20),
    )}
    if not values["title"] or values["category"] not in CATEGORIES:
        raise ValueError("Enter a title and choose a category.")
    try:
        if values["photo_date"]:
            values["photo_date"] = date.fromisoformat(values["photo_date"]).isoformat()
    except ValueError as exc:
        raise ValueError("Enter a valid date for the photographs.") from exc
    return values


def _photo_edits(form, existing):
    ids = {str(photo["photo_id"]) for photo in existing}
    requested = form.getlist("photo_order")
    if not all(isinstance(photo_id, str) and photo_id in ids for photo_id in requested):
        raise ValueError("Reload the editor to see the current photos.")
    if set(requested) != ids or len(requested) != len(ids):
        raise ValueError("Reload the editor to see the current photos.")
    removed = set(form.getlist("remove_photo"))
    return [
        (photo_id, field(form, f"alt_{photo_id}", 200), field(form, f"caption_{photo_id}", 300))
        for photo_id in requested if photo_id not in removed
    ]


class StaleStory(Exception):
    """Another editor changed the story during a save."""


def _save_story(request, form):
    post_id = request.path_params.get("post_id")
    with store.connect(request.app.state.db) as db:
        post = get_post(db, post_id)
        existing = store.photos_for(db, post_id)
    if post and form.get("revision") != str(post["revision"]):
        return editor(request, error="This story changed in another tab. Review the current version before saving.", status=409)
    try:
        values = _story_fields(form)
        intent = form.get("intent", "")
        if intent not in ("draft", "publish", "save"):
            raise ValueError("Choose how to save the story.")
        edits = _photo_edits(form, existing)
        uploads = [item for item in form.getlist("photos") if isinstance(item, UploadFile) and item.filename]
        if len(edits) + len(uploads) > store.MAX_PHOTOS:
            raise ValueError(f"A story can hold up to {store.MAX_PHOTOS} photos.")
        now = int(time())
        published = post["published_at"] if post else None
        if intent == "publish" and published is None:
            published = now
        elif intent == "draft":
            published = None
        if published is not None and not (edits or uploads):
            raise ValueError("Add at least one photo before publishing.")
        processed = []
        for index, upload in enumerate(uploads):
            alt = field(form, f"upload_alt_{index}", 200)
            caption = field(form, f"upload_caption_{index}", 300)
            full, thumb, width, height = store.prepare_photo(upload.file.read(store.MAX_PHOTO_BYTES + 1))
            processed.append((alt, caption, width, height, full, thumb))
    except ValueError as exc:
        return editor(request, error=str(exc), submitted=form, status=400)

    try:
        with store.connect(request.app.state.db, write=True) as db:
            if post is None:
                post_id = db.execute(
                    """INSERT INTO posts
                       (slug, title, caption, story, category, location, photo_date, published_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (slug_for(db, values["title"]), *values.values(), published, now),
                ).lastrowid
            else:
                updated = db.execute(
                    """UPDATE posts SET title=?, caption=?, story=?, location=?, photo_date=?, category=?,
                       published_at=?, updated_at=?, revision=revision+1 WHERE id=? AND revision=?""",
                    (*values.values(), published, now, post_id, post["revision"]),
                )
                if updated.rowcount != 1:
                    raise StaleStory
            retained = {str(photo_id) for photo_id, _, _ in edits}
            db.executemany(
                "DELETE FROM photos WHERE id = ? AND post_id = ?",
                ((photo["photo_id"], post_id) for photo in existing if str(photo["photo_id"]) not in retained),
            )
            db.executemany(
                "UPDATE photos SET position = ?, alt = ?, caption = ? WHERE id = ? AND post_id = ?",
                ((position, alt, caption, photo_id, post_id) for position, (photo_id, alt, caption) in enumerate(edits)),
            )
            db.executemany(
                """INSERT INTO photos (post_id, position, alt, caption, width, height, full, thumb)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                ((post_id, position, *photo) for position, photo in enumerate(processed, len(edits))),
            )
    except StaleStory:
        return editor(request, error="This story changed in another tab. Review the current version before saving.", status=409)
    return RedirectResponse("/admin?saved=saved", 303)


async def save_story(request):
    require_admin(request)
    async with read_form(request, uploads=True) as form:
        return await run_in_threadpool(_save_story, request, form)


def _admin_action(request, form):
    kind = request.path_params["kind"]
    entry_id = request.path_params["entry_id"]
    action = form.get("action", "")
    with store.connect(request.app.state.db, write=True) as db:
        if kind == "stories" and action == "delete" and form.get("confirm") == "yes":
            result = db.execute("DELETE FROM posts WHERE id = ? AND CAST(revision AS TEXT) = ?",
                                (entry_id, form.get("revision", "")))
            if not result.rowcount:
                raise HTTPException(409, "This story changed before it could be deleted. Reload the editor.")
            return RedirectResponse("/admin?saved=deleted", 303)
        if kind == "comments" and action in ("approve", "hide", "delete"):
            if action == "delete":
                db.execute("DELETE FROM comments WHERE id = ?", (entry_id,))
            else:
                db.execute("UPDATE comments SET status = ? WHERE id = ?",
                           ("approved" if action == "approve" else "pending", entry_id))
            return RedirectResponse("/admin/comments?saved=moderated", 303)
        if kind == "inbox" and action in ("read", "unread", "delete"):
            if action == "delete":
                db.execute("DELETE FROM messages WHERE id = ?", (entry_id,))
            else:
                db.execute("UPDATE messages SET read_at = ? WHERE id = ?",
                           (int(time()) if action == "read" else None, entry_id))
            return RedirectResponse("/admin/inbox?saved=read", 303)
    raise HTTPException(400, "Choose a valid dashboard action.")


async def admin_action(request):
    require_admin(request)
    async with read_form(request) as form:
        return await run_in_threadpool(_admin_action, request, form)


def _save_settings(request, form):
    try:
        name, email, phone = field(form, "name", 100), field(form, "email", 254), field(form, "phone", 32)
        if not name or (email and not valid_email(email)) or (phone and not PHONE.fullmatch(phone)):
            raise ValueError("Enter a name and, when provided, a valid public email and phone number.")
    except ValueError as exc:
        return admin_page(request, error=str(exc), status=400)
    if phone and sum(char.isdigit() for char in phone) < 3:
        return admin_page(request, error="Enter a valid phone number.", status=400)
    with store.connect(request.app.state.db, write=True) as db:
        db.executemany("INSERT OR REPLACE INTO settings VALUES (?, ?)", (("name", name), ("email", email), ("phone", phone)))
    return RedirectResponse("/admin/settings?saved=settings", 303)


async def save_settings(request):
    require_admin(request)
    async with read_form(request) as form:
        return await run_in_threadpool(_save_settings, request, form)


def error_page(request, exc):
    if exc.status_code == 303:
        return RedirectResponse(exc.headers["Location"], 303)
    if request.url.path.startswith(("/media/", "/static/")):
        return Response(status_code=exc.status_code)
    message = "This page is unavailable." if exc.status_code == 404 and exc.detail == "Not Found" else exc.detail
    return render(request, "error.html", exc.status_code, title=str(exc.status_code), message=message, code=exc.status_code)


async def headers_middleware(request, call_next):
    response = await call_next(request)
    csp = TURNSTILE_CSP if request.url.path == "/contact" and protection(request).site_key else BASE_CSP
    response.headers["Content-Security-Policy"] = csp
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.url.path.startswith("/admin"):
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        response.headers["Cache-Control"] = "no-store"
    return response


templates.filters["mailto"] = lambda address: "mailto:" + quote(address, safe="@.+-_")
templates.filters["tel"] = lambda number: "tel:" + ("+" if number.startswith("+") else "") + "".join(
    char for char in number if char.isascii() and char.isdigit()
)

app = Starlette(
    lifespan=lifespan,
    routes=[
        Route("/", home),
        Route("/journal", journal),
        Route("/journal/page/{page:int}", journal),
        Route("/stories/{slug}", show_post),
        Route("/stories/{slug}/comments", comment, methods=["POST"]),
        Route("/contact", contact),
        Route("/contact", send_contact, methods=["POST"]),
        Route("/media/{photo_id:int}", media),
        Route("/media/{photo_id:int}/{variant}", media),
        Route("/admin", admin_page),
        Route("/admin/sign-in", login_page),
        Route("/admin/sign-in", sign_in, methods=["POST"]),
        Route("/admin/sign-out", sign_out, methods=["POST"]),
        Route("/admin/stories/new", editor),
        Route("/admin/stories/new", save_story, methods=["POST"]),
        Route("/admin/stories/{post_id:int}", editor),
        Route("/admin/stories/{post_id:int}", save_story, methods=["POST"]),
        Route("/admin/{kind}/{entry_id:int}/action", admin_action, methods=["POST"]),
        Route("/admin/settings", save_settings, methods=["POST"]),
        Route("/admin/{section}", admin_page),
        Mount("/static", StaticFiles(directory=ROOT / "static"), name="static"),
    ],
    exception_handlers={HTTPException: error_page},
)
app.add_middleware(BaseHTTPMiddleware, dispatch=headers_middleware)
