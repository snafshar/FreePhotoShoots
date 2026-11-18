# Silvergrain

Silvergrain is a photography magazine on cream paper. Every black-and-white photograph has a caption, a story, and a permanent link. Each magazine shows ten photographs per page in the order its photographer chooses. Readers can turn pages with links, horizontal touch swipes, or the arrow keys.

[Visit Silvergrain](https://silvergrain.afsharsn.chatgpt.site)

## Accounts and magazines

| Address | Who can use it | What it does |
| --- | --- | --- |
| `/` and `/sina-afshar` | Anyone | Read Sina’s magazine. Existing owner story and photo addresses continue to work. |
| `/photographers` | Anyone | Browse approved photographers and open their magazines. |
| `/join` | Visitors with a ChatGPT account | Sign in, choose a username and display name, and send a publishing request to the editor. |
| `/login` and `/account` | Visitors and applicants | Sign in, see an application’s status, or enter the appropriate dashboard. Signed-in accounts have a sign-out control. |
| `/<username>` | Anyone | Read an approved photographer’s profile and published work, with a dedicated journal, reading order, and contact page. |
| `/studio` | Approved contributors | Create and edit posts, publish photos, order them, edit a profile, or read contact messages. |
| `/admin` | Site owner | Manage every magazine, post, and inbox. Change site contact details and sample visibility. |
| `/admin/users` | Site owner | Review requests, inspect the decision history, change profiles, manage a photographer’s stories, suspend or restore access, and delete accounts and their content. |
| `/admin/appearance` | Site owner | Set the title, paper color, typeface, and photo spacing. Open or pause contributor requests. |
| `/admin/email` | Site owner | Configure the approval sender, inspect notifications, and retry or reconcile delivery. |

The signup email and application note stay private. Contributors choose what contact information to publish on their profiles. The site editor can see all incoming contact messages. Contact forms use a one-time verification challenge and submission limits.

The studio accepts JPEG, PNG, or WebP, with up to ten photos per post. The browser exports fresh WebP copies at 1,920 and 720 pixels on the long edge. Authors can set a title, caption, story, and alt text for each photo. The owner can hide the five labeled sample photographs. Reader comments are disabled.

## Approval emails

1. Verify a sending domain in Resend and create a sending key for that domain.
2. Open **Management → Email**, enter the sender address and key, and save. The Worker encrypts the saved key with AES-GCM. Hosting environment variables can also supply the sender.
3. Open **People** and choose **Approve and email** on a pending application. The Worker records the decision and notification together, enables publishing, and sends the approved photographer their studio and magazine links.

Without a configured sender, approvals stay in the outbox. Use **Send via provider** for earlier messages once a sender is available. To send one immediately from your own mailbox, choose **Send from my mail app**, send the prepared email, then mark it sent in the dashboard. Provider acceptance records that the sender accepted the message. Inbox delivery is determined by the recipient’s mail service. Retries use a stable idempotency key. If a transmission remains ambiguous beyond the safe retry window, check the provider log before resending.

[Resend domain verification](https://resend.com/docs/dashboard/domains/introduction)

## Hosting and security

This edition runs on ChatGPT Sites behind its managed authentication gateway. The gateway supplies the authenticated, site-scoped account ID and email. Ownership is bound to the account ID. Hosting this Worker elsewhere requires a trusted identity gateway that strips incoming identity headers before setting its own verified values. Directly exposing this Worker to client-supplied identity headers would bypass authentication.

The Worker checks approval and ownership on the server for drafts, uploads, photos, messages, and mutations. Suspension disables the studio and hides the magazine and its hosted photographs. State-changing forms use signed, cookie-bound tokens and origin checks. Queries use bound parameters, and revision checks protect concurrent edits. Private pages and uploaded photo responses use no-store cache controls. D1 stores records, R2 stores photo files, and `drizzle/` contains the schema migrations. The independent Python edition is in `../silvergrain/`.

| Environment variable | Purpose |
| --- | --- |
| `SILVERGRAIN_ADMIN_EMAIL` | Bootstrap email for the owner’s first managed sign-in. The resulting site-specific account ID is pinned. |
| `SILVERGRAIN_ADMIN_ID` | Optional explicit owner account ID. |
| `SILVERGRAIN_FORM_SECRET` | At least 32 random characters for form signing and rate limits. A separate key is derived for sender encryption. Re-enter the sending key after rotating this secret. |
| `RESEND_API_KEY`, `SILVERGRAIN_EMAIL_FROM` | Optional deployment-managed sending key and verified From address. Set both to take precedence over the dashboard. |
| `SILVERGRAIN_PUBLIC_ORIGIN` | Optional HTTPS origin for approval links. Defaults to the hosted Silvergrain address. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_HOSTNAME` | Optional Cloudflare Turnstile configuration for contact forms. Set all three together. |

## Local checks

Use Node.js 22.13 or newer.

```sh
npm ci
npx tsc --noEmit
node --test tests/worker.test.mjs
npm audit
npm run build
```

Integration tests run against disposable D1 and R2 storage and a simulated email provider. They exercise existing journal features, account approval, cross-account permissions, private media, revocation, contact messages, appearance changes, and email retries.

For a local browser preview, copy `.dev.vars.example` to `.dev.vars` and set a development signing secret. After building, apply each SQL migration once to the local database.

```sh
for migration in drizzle/*.sql; do
  node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local \
    --config dist/server/wrangler.json --persist-to .wrangler/state --file "$migration" || exit 1
done
npm run dev
```

Portable local preview uses the starter’s mock account, `seedy@sites.test`. Use that address as the development admin email for owner access. The deployed site uses managed ChatGPT sign-in.

Instrument Serif and Inter are bundled under their SIL Open Font Licenses in `public/static/fonts/`.
