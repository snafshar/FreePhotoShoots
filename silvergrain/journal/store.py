"""SQLite data and photo derivatives for the journal."""

from contextlib import contextmanager
from datetime import date, datetime, timezone
from io import BytesIO
from pathlib import Path
from secrets import token_hex
import sqlite3
import warnings

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

MAX_PHOTOS = 10
MAX_PHOTO_BYTES = 16 * 1024 * 1024
MAX_PHOTO_PIXELS = 65_000_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    caption TEXT NOT NULL,
    story TEXT NOT NULL,
    category TEXT NOT NULL,
    location TEXT NOT NULL,
    photo_date TEXT NOT NULL,
    published_at INTEGER,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1))
);
CREATE INDEX IF NOT EXISTS posts_published ON posts(published_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    alt TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    demo_key TEXT,
    full BLOB,
    thumb BLOB
);
CREATE INDEX IF NOT EXISTS photos_post ON photos(post_id, position, id);
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id, status, id);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
);
CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT NOT NULL,
    window INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (key, window)
);
CREATE TABLE IF NOT EXISTS captcha_attempts (
    id TEXT PRIMARY KEY,
    expires INTEGER NOT NULL
);
"""

CARD_FIELDS = """
    p.id, p.slug, p.title, p.caption, p.category, p.location, p.photo_date,
    p.published_at, p.demo, f.id AS photo_id, f.demo_key, f.alt, f.width, f.height,
    (SELECT count(*) FROM photos AS x WHERE x.post_id = p.id) AS photo_count
"""
CARD_FROM = """
    FROM posts AS p
    LEFT JOIN photos AS f ON f.id = (
        SELECT id FROM photos WHERE post_id = p.id ORDER BY position, id LIMIT 1
    )
"""

DEMO = (
    (
        "where-the-light-falls", "Where the light falls",
        "Before sunrise in the Dolomites, when the valley belongs to the fog.",
        "The ridgeline appeared first. For a few minutes it was the only shape above the valley, "
        "and the low cloud turned everything beneath it a soft, even gray.\n\n"
        "By the lake, the same mountains almost disappeared into their reflection. These two "
        "frames hold that small change in light.",
        "Landscape", "Dolomites, Italy", "2026-10-18",
        (
            ("dolomites", "Jagged alpine peaks rising above a dark valley filled with fog", "The ridgeline before sunrise."),
            ("alpine-lake", "A foggy alpine lake reflecting the mountains", "The still water at first light."),
        ),
    ),
    (
        "between-the-arches", "Between the arches",
        "A long shadow, a quiet arcade, and a figure at the far end.",
        "The arches made a rhythm out of an otherwise quiet afternoon. I waited until a figure "
        "entered the far arch and the pavement held just enough light to trace the way through.",
        "Architecture", "Bologna, Italy", "2026-10-04",
        (("arcade", "A solitary figure at the end of a row of stone arches", "Late light across the arcade."),),
    ),
    (
        "the-shape-of-water", "The shape of water",
        "White surf against the dark edge of the Ligurian coast.",
        "The swell kept changing the outline of the rock. From a low vantage point, each wave "
        "drew a different white edge against the stone.",
        "Seascape", "Liguria, Italy", "2026-09-21",
        (("coast", "White surf curls around a dark rocky headland", "Looking out from the rocks."),),
    ),
    (
        "a-street-in-silence", "A street in silence",
        "A bicycle, shuttered windows, and the last strip of daylight.",
        "A narrow street held the day's last light long after the square had gone gray. The "
        "bicycle beside the wall was the only thing that suggested someone would be back.",
        "Street", "Tuscany, Italy", "2026-09-09",
        (("street", "A bicycle against the wall of a narrow Italian street", "Daylight at the far end of the street."),),
    ),
)


@contextmanager
def connect(path, *, write=False):
    db = sqlite3.connect(path, timeout=8)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys = ON")
        if write:
            db.execute("BEGIN IMMEDIATE")
        yield db
        if write:
            db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def initialize(directory: Path, *, demo: bool) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "journal.sqlite3"
    with connect(path) as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.executescript(SCHEMA)
    with connect(path, write=True) as db:
        db.executemany(
            "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
            (("secret", token_hex(32)), ("name", "Sina Afshar"), ("email", ""), ("phone", "")),
        )
        if db.execute("SELECT 1 FROM settings WHERE key = 'initialized'").fetchone() is None:
            if demo:
                seed_demo(db)
            db.execute("INSERT INTO settings VALUES ('initialized', '1')")
    return path


def seed_demo(db):
    for slug, title, caption, story, category, location, day, photos in DEMO:
        timestamp = int(datetime.combine(date.fromisoformat(day), datetime.min.time(), timezone.utc).timestamp())
        post_id = db.execute(
            """INSERT INTO posts
               (slug, title, caption, story, category, location, photo_date, published_at, updated_at, demo)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
            (slug, title, caption, story, category, location, day, timestamp, timestamp),
        ).lastrowid
        db.executemany(
            """INSERT INTO photos (post_id, position, alt, caption, width, height, demo_key)
               VALUES (?, ?, ?, ?, 1536, 1024, ?)""",
            ((post_id, position, alt, caption, key) for position, (key, alt, caption) in enumerate(photos)),
        )


def public_settings(db):
    return dict(db.execute("SELECT key, value FROM settings WHERE key IN ('name', 'email', 'phone')"))


def photos_for(db, post_id):
    return db.execute(
        """SELECT id AS photo_id, position, alt, caption, width, height, demo_key
           FROM photos WHERE post_id = ? ORDER BY position, id""",
        (post_id,),
    ).fetchall()


def photo_url(photo, small=False):
    if photo["demo_key"]:
        suffix = "-small" if small else ""
        return f"/static/demo/{photo['demo_key']}{suffix}.webp"
    suffix = "/small" if small else ""
    return f"/media/{photo['photo_id']}{suffix}"


def _encode(image, size, quality):
    photo = image.copy()
    photo.thumbnail((size, size), Image.Resampling.LANCZOS)
    photo.info.clear()
    output = BytesIO()
    photo.save(output, "WEBP", quality=quality, method=4)
    return output.getvalue(), photo.width, photo.height


def prepare_photo(data):
    """Decode a supported still image and build two metadata-free WebP files."""
    if not data or len(data) > MAX_PHOTO_BYTES:
        raise ValueError("Each image must be between 1 byte and 16 MB.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data), formats=("JPEG", "PNG", "WEBP")) as source:
                if source.width * source.height > MAX_PHOTO_PIXELS:
                    raise ValueError("Choose images under 65 megapixels.")
                if getattr(source, "n_frames", 1) != 1:
                    raise ValueError("Choose still images for a story.")
                image = ImageOps.exif_transpose(source)
                mode = "RGBA" if image.has_transparency_data else "RGB"
                profile = image.info.get("icc_profile")
                if profile:
                    try:
                        image = ImageCms.profileToProfile(
                            image, BytesIO(profile), ImageCms.createProfile("sRGB"), outputMode=mode,
                        )
                    except (ImageCms.PyCMSError, OSError, ValueError):
                        image = image.convert(mode)
                else:
                    image = image.convert(mode)
                full, width, height = _encode(image, 1920, 87)
                thumb, _, _ = _encode(image, 720, 81)
                return full, thumb, width, height
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("Choose images under 65 megapixels.") from exc
    except (UnidentifiedImageError, OSError, SyntaxError) as exc:
        raise ValueError("Choose a valid JPEG, PNG, or WebP image.") from exc
