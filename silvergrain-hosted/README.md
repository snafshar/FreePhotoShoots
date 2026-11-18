# Silvergrain · hosted journal

[Open Silvergrain](https://silvergrain.afsharsn.chatgpt.site). Sign in with the ChatGPT account that owns the site, then choose **Studio** in the header. The site opens with five labeled sample photographs and is initially owner-only.

- **Stories** creates drafts and publishes groups of up to ten photos. Each photo has its own title, caption, story, and permanent page. Location, category, and date apply to the group. Older photos inherit the group's title and text until you edit their individual stories.
- **Photo order** sets the reading order across all published photos. Move photos with the arrows or enter their positions, then save. The magazine and journal show ten photos per page, with the remaining photos on the final page. Page links, horizontal touch swipes, and keyboard arrows navigate the sequence.
- **Inbox** keeps contact form messages and a reply-by-email link.
- **Settings** controls the name, public email and phone, and whether to show the sample stories.

The magazine uses a white background, black-and-white photographs, and simple photo-and-text spreads. Each photograph opens full screen. Comments and comment submission routes are disabled.

The editor accepts JPEG, PNG, or WebP photos. It makes two WebP copies in the browser, with maximum long edges of 1,920 and 720 pixels, and leaves camera metadata out. The first photo represents the group in Studio. The magazine and full-screen gallery display all photographs in black and white.

## Source and deployment

This version targets ChatGPT Sites. The Worker renders pages and uses D1 for records and R2 for photo files. The migration SQL and metadata are in `drizzle/`. The existing Python version in `../silvergrain/` runs independently with SQLite.

Production variables are managed in the hosting environment:

| Variable | Purpose |
| --- | --- |
| `SILVERGRAIN_ADMIN_EMAIL` | The owner’s ChatGPT sign-in address. The app records the verified account’s site-scoped ID on first sign-in. |
| `SILVERGRAIN_FORM_SECRET` | A random signing key of at least 32 characters for forms and rate limits. |
| `SILVERGRAIN_ADMIN_ID` | Optional explicit override for the site-scoped admin ID. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_HOSTNAME` | Optional Cloudflare Turnstile settings. Set all three together. |

The default contact form uses a one-use arithmetic check and limits repeated submissions. With Turnstile configured, the server verifies the token, action, and hostname before saving a message. [Turnstile setup](https://developers.cloudflare.com/turnstile/get-started/)

## Local checks

Use Node.js 22.13 or newer.

```sh
npm ci
npx tsc --noEmit
node --test tests/worker.test.mjs
npm run build
```

The integration suite uses a disposable local D1 and R2. It exercises guest and owner access, draft photo privacy, independent photo stories, publishing, global photo order, ten-photo pagination, stale-order protection, removed comment routes, contact verification, and inbox delivery.

For a browser preview, copy `.dev.vars.example` to `.dev.vars` and set a development signing key. After building, apply each migration to your local database once:

```sh
for migration in drizzle/*.sql; do
  node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local \
    --config dist/server/wrangler.json --persist-to .wrangler/state --file "$migration"
done
npm run dev
```

In a portable checkout, the Sites starter’s local sign-in uses `seedy@sites.test`. Set the development admin email to that address if you want to use that mock sign-in. The hosted deployment uses the real ChatGPT sign-in.

Instrument Serif and Inter are bundled under their SIL Open Font Licenses in `public/static/fonts/`.
