# Silvergrain

Silvergrain is a black-and-white photography journal with a private publishing studio. The homepage features a swipeable selection. Each story has a permanent link, its own photo gallery, a caption, and a moderated discussion. The journal can be filtered by category and moves between pages with swipe, arrow buttons, or keyboard controls. The dashboard manages drafts, published stories, photo order and captions, comments, contact details, and incoming messages.

## Run locally

Use Python 3.12 or later. From this directory on macOS or Linux, run:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
python -m journal.cli set-admin --username sina
python -m uvicorn journal.app:app --reload
```

Open [the local journal](http://127.0.0.1:8000/) or [admin sign-in](http://127.0.0.1:8000/admin). The setup command prompts for a password privately. Run it again to reset the admin account and revoke its existing sessions.

1. In **Studio → Settings**, enter the email and phone number you want to display publicly. Either field can be left blank.
2. Select **New story** and add your title, caption, and photographs. The optional story text, location, and photo date appear on the story page. Save a draft to preview it, or publish immediately.
3. Use **Comments** to approve or hide reader comments. Messages sent from the contact page appear in the **Inbox** with a link to reply by email.

A story accepts up to ten still JPEG, PNG, or WebP photographs at up to 16 MB and 65 megapixels each. Uploaded photos are oriented using their EXIF data and converted to WebP without the original metadata. The browser uses a thumbnail and a display copy with a maximum edge of 1,920 pixels. The first photo is the cover. Published galleries display the uploaded photo colors, while covers use a monochrome treatment.

## Sample stories

Four labeled sample stories show the design with AI-generated images. Set `SEED_DEMO=0` before the first run to start with an empty journal. To remove only the sample stories from an existing journal, run:

```sh
python -m journal.cli remove-samples
```

## Contact verification

The contact form includes a short, one-use arithmetic challenge, a hidden anti-spam field, and a submission rate limit by default. The arithmetic check provides basic screening. For stronger bot protection, create a Cloudflare Turnstile widget for your domain and set `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, and `TURNSTILE_HOSTNAME` in your runtime environment. Silvergrain renders the widget, validates the returned token with Siteverify, and checks its hostname and action before storing the message.

See [Cloudflare’s Turnstile setup](https://developers.cloudflare.com/turnstile/get-started/) and [server-side verification documentation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

## Hosting and data

Serve the app with Uvicorn on a Python-capable host with persistent storage and HTTPS. Set `SECURE_COOKIES=1` and place `DATA_DIR` on a persistent local volume. When a reverse proxy sits in front of Uvicorn, allow proxy headers only from that trusted proxy so the form and sign-in rate limits can distinguish visitors. For a proxy that caps request bodies, configure a 161 MB cap if you want to support all ten 16 MB uploads in one request.

The SQLite database holds the stories, resized photos, comments, inbox, settings, and admin account. For backups from a live process, use SQLite's backup operation:

```sh
sqlite3 data/journal.sqlite3 ".backup 'silvergrain-backup.sqlite3'"
```

Keep backups and `.env` private. This GitHub folder contains source code and sample assets. Running the dashboard and storing submissions requires the Python server.

## Verification

```sh
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
```

The integration tests cover admin sign-in, private drafts and their photos, multiple uploads, publishing and unpublishing, category pagination, comment moderation, public contact details, and the contact inbox. The Turnstile test uses a simulated Siteverify response.

Instrument Serif and Inter are distributed under their SIL Open Font Licenses in `static/fonts/`.
