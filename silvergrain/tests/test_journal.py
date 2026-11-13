import json
import os
import re
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from PIL import Image
from starlette.testclient import TestClient

from journal.app import app
from journal.security import hash_password
from journal.store import connect

PASSWORD = "silvergrain test password"


def hidden(page, name):
    return re.search(rf'name="{name}" value="([^"]*)"', page.text).group(1)


def image_bytes(color):
    output = BytesIO()
    Image.new("RGB", (96, 64), color).save(output, format="JPEG")
    return output.getvalue()


class JournalTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password_hash = hash_password(PASSWORD)

    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        env = patch.dict(os.environ, {
            "DATA_DIR": temp.name, "SEED_DEMO": "1", "SECURE_COOKIES": "0",
            "TURNSTILE_SITE_KEY": "", "TURNSTILE_SECRET_KEY": "", "TURNSTILE_HOSTNAME": "",
        })
        env.start()
        self.addCleanup(env.stop)
        self.client = self.enterContext(TestClient(app, follow_redirects=False))
        self.db_path = Path(temp.name) / "journal.sqlite3"
        with connect(self.db_path, write=True) as db:
            db.execute("INSERT INTO admin VALUES (1, 'sina', ?)", (self.password_hash,))

    def sign_in(self):
        login = self.client.get("/admin/sign-in")
        response = self.client.post("/admin/sign-in", data={
            "csrf": hidden(login, "csrf"), "username": "sina", "password": PASSWORD,
        })
        self.assertEqual(response.status_code, 303, response.text)
        self.assertEqual(response.headers["location"], "/admin")
        self.assertIn("HttpOnly", response.headers["set-cookie"])

    def editor_data(self):
        return {
            "csrf": hidden(self.client.get("/admin/stories/new"), "csrf"),
            "title": "Morning on the Arno", "caption": "Two views across the river.",
            "story": "First paragraph.\n\nSecond paragraph.", "category": "Landscape",
            "location": "Pisa", "photo_date": "2026-11-12", "intent": "draft",
        }

    def test_home_archive_and_protected_dashboard(self):
        self.assertIn("Where the", self.client.get("/").text)
        self.assertEqual(self.client.get("/static/demo/dolomites.webp").headers["content-type"], "image/webp")
        archive = self.client.get("/journal?category=Architecture")
        self.assertIn("Between the arches", archive.text)
        self.assertNotIn("The shape of water", archive.text)
        self.assertIn('/stories/between-the-arches', self.client.get("/stories/where-the-light-falls").text)
        self.assertEqual(self.client.get("/journal/page/2").status_code, 404)
        self.assertEqual(self.client.get("/admin").headers["location"], "/admin/sign-in")
        self.assertEqual(self.client.post("/admin/stories/new", data={}).status_code, 303)
        self.assertEqual(self.client.post("/admin/sign-in", data={"username": "sina"}).status_code, 403)
        with connect(self.db_path, write=True) as db:
            db.executemany(
                """INSERT INTO posts (slug,title,caption,story,category,location,photo_date,published_at,updated_at)
                   VALUES (?, ?, '', '', 'Landscape', '', '', 100, 100)""",
                ((f"archive-{i}", f"Archive {i}") for i in range(9)),
            )
        page = self.client.get("/journal/page/2?category=Landscape")
        self.assertEqual(page.status_code, 200, page.text)
        self.assertIn("Page 2 of 2", page.text)
        self.assertIn('/journal?category=Landscape', page.text)

    def test_upload_draft_publish_reorder_and_unpublish(self):
        self.sign_in()
        data = self.editor_data()
        data.update(upload_alt_0="The first view", upload_caption_1="The second view")
        files = [
            ("photos", ("one.jpg", image_bytes("red"), "image/jpeg")),
            ("photos", ("two.jpg", image_bytes("blue"), "image/jpeg")),
        ]
        response = self.client.post("/admin/stories/new", data=data, files=files)
        self.assertEqual(response.status_code, 303, response.text)
        url = "/stories/morning-on-the-arno"
        with connect(self.db_path) as db:
            post = db.execute("SELECT id FROM posts WHERE slug = 'morning-on-the-arno'").fetchone()
            photo_ids = [str(photo[0]) for photo in db.execute(
                "SELECT id FROM photos WHERE post_id = ? ORDER BY position", (post["id"],),
            )]
        edit_url = f'/admin/stories/{post["id"]}'
        first_media = f"/media/{photo_ids[0]}"
        self.assertIn("Draft preview", self.client.get(url).text)
        with TestClient(app) as guest:
            self.assertEqual(guest.get(url).status_code, 404)
            self.assertEqual(guest.get(first_media).status_code, 404)
        edit = self.client.get(edit_url)
        data.update(
            csrf=hidden(edit, "csrf"), revision=hidden(edit, "revision"),
            photo_order=list(reversed(photo_ids)), intent="publish",
        )
        data[f"alt_{photo_ids[0]}"] = "The first view"
        data[f"caption_{photo_ids[1]}"] = "The second view"
        self.assertEqual(self.client.post(edit_url, data=data).status_code, 303)
        self.assertEqual(self.client.post(edit_url, data=data).status_code, 409)
        with TestClient(app) as guest:
            public = guest.get(url)
            self.assertEqual(public.status_code, 200)
            self.assertLess(public.text.index("The second view"), public.text.index("The first view"))
            self.assertIn("Second paragraph.", public.text)
            self.assertEqual(guest.get(first_media).headers["content-type"], "image/webp")
        edit = self.client.get(edit_url)
        data.update(csrf=hidden(edit, "csrf"), revision=hidden(edit, "revision"), intent="draft")
        self.assertEqual(self.client.post(edit_url, data=data).status_code, 303)
        with TestClient(app) as guest:
            self.assertEqual(guest.get(url).status_code, 404)
            self.assertEqual(guest.get(first_media).status_code, 404)
        logout = self.client.post("/admin/sign-out", data={"csrf": data["csrf"]})
        self.assertEqual(logout.status_code, 303)
        self.assertEqual(self.client.get("/admin").headers["location"], "/admin/sign-in")

    def test_invalid_upload_does_not_create_story(self):
        self.sign_in()
        data = self.editor_data()
        data["intent"] = "publish"
        missing = self.client.post("/admin/stories/new", data=data)
        self.assertEqual(missing.status_code, 400)
        self.assertIn("Add at least one photo", missing.text)
        files = [
            ("photos", ("valid.jpg", image_bytes("red"), "image/jpeg")),
            ("photos", ("bad.jpg", b"invalid", "image/jpeg")),
        ]
        response = self.client.post("/admin/stories/new", data=data, files=files)
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("Choose a valid JPEG", response.text)
        with connect(self.db_path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM posts WHERE demo = 0").fetchone()[0], 0)

    def test_moderation_and_public_settings(self):
        story = "/stories/where-the-light-falls"
        token = hidden(self.client.get(story), "csrf")
        comment = self.client.post(story + "/comments", data={
            "csrf": token, "name": "Reader", "body": "The light in frame two is beautiful.",
        })
        self.assertEqual(comment.status_code, 303)
        self.assertNotIn("frame two is beautiful", self.client.get(story).text)
        self.sign_in()
        moderation = self.client.get("/admin/comments")
        self.assertIn("frame two is beautiful", moderation.text)
        action = re.search(r'/admin/comments/\d+/action', moderation.text).group()
        self.assertEqual(self.client.post(action, data={
            "csrf": hidden(moderation, "csrf"), "action": "approve",
        }).status_code, 303)
        self.assertIn("frame two is beautiful", self.client.get(story).text)
        settings = self.client.get("/admin/settings")
        saved = self.client.post("/admin/settings", data={
            "csrf": hidden(settings, "csrf"), "name": "Sina", "email": "photo@example.com", "phone": "+39 012 3456",
        })
        self.assertEqual(saved.status_code, 303)
        public = self.client.get("/contact")
        self.assertIn('href="mailto:photo@example.com"', public.text)
        self.assertIn('href="tel:+390123456"', public.text)

    def test_contact_challenge_and_inbox(self):
        contact = self.client.get("/contact")
        first, second = (int(n) for n in re.search(r"What is (\d+) \+ (\d+)\?", contact.text).groups())
        data = {
            "csrf": hidden(contact, "csrf"), "challenge": hidden(contact, "challenge"),
            "answer": str(first + second), "name": "Reader", "email": "reader@example.com", "body": "Hello from Pisa.",
        }
        response = self.client.post("/contact", data=data)
        self.assertEqual(response.status_code, 303, response.text)
        self.assertEqual(self.client.post("/contact", data=data).status_code, 400)
        self.sign_in()
        inbox = self.client.get("/admin/inbox")
        self.assertIn("Hello from Pisa.", inbox.text)
        self.assertIn("1 unread", inbox.text)
        action = re.search(r'/admin/inbox/\d+/action', inbox.text).group()
        self.assertEqual(self.client.post(action, data={
            "csrf": hidden(inbox, "csrf"), "action": "read",
        }).status_code, 303)
        self.assertIn("0 unread", self.client.get("/admin/inbox").text)

    def test_turnstile_accepts_only_matching_action_and_hostname(self):
        env = {"TURNSTILE_SITE_KEY": "fixture-site", "TURNSTILE_SECRET_KEY": "fixture-secret", "TURNSTILE_HOSTNAME": "example.com"}
        with patch.dict(os.environ, env), TestClient(app, follow_redirects=False) as client:
            page = client.get("/contact")
            self.assertIn('data-action="contact"', page.text)
            self.assertIn("frame-src https://challenges.cloudflare.com", page.headers["content-security-policy"])
            data = {
                "csrf": hidden(page, "csrf"), "cf-turnstile-response": "test-token",
                "name": "Reader", "email": "reader@example.com", "body": "A message.",
            }
            for host, action, status in [
                ("elsewhere.example", "contact", 400), ("example.com", "other", 400), ("example.com", "contact", 303),
            ]:
                payload = json.dumps({"success": True, "hostname": host, "action": action}).encode()
                with patch("journal.security.urlopen", return_value=BytesIO(payload)) as verify:
                    response = client.post("/contact", data=data)
                    self.assertEqual(response.status_code, status, response.text)
                    request = verify.call_args.args[0]
                    self.assertEqual(request.full_url, "https://challenges.cloudflare.com/turnstile/v0/siteverify")
