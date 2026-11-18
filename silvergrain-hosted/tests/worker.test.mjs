import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let runtime;
let db;
const guest = {};
const owner = { "oai-authenticated-user-id": "test-owner", "oai-authenticated-user-email": "owner@example.com" };
const member = { "oai-authenticated-user-id": "test-reader", "oai-authenticated-user-email": "reader@example.com" };
const origin = "https://journal.example.com";

function request(path, options = {}) {
  return runtime.dispatchFetch(new URL(path, origin), { redirect: "manual", ...options });
}
function field(markup, name) {
  const result = markup.match(new RegExp(`name="${name}" value="([^"]*)"`));
  assert.ok(result, `Expected form field ${name}`);
  return result[1];
}
async function page(path, who = guest) {
  const response = await request(path, { headers: who });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return {
    text, token: field(text, "csrf"),
    headers: { ...who, Cookie: response.headers.get("Set-Cookie").split(";")[0] },
  };
}
function submit(path, page, fields, options = {}) {
  const data = new URLSearchParams({ csrf: page.token, ...fields });
  for (const id of options.order ?? []) data.append("photo_order", id);
  return request(path, { method: "POST", body: data, headers: page.headers });
}
async function upload(page, id, name) {
  const full = await readFile(new URL(`../public/static/demo/${name}.webp`, import.meta.url));
  const thumb = await readFile(new URL(`../public/static/demo/${name}-small.webp`, import.meta.url));
  const result = await request(`/admin/uploads/${id}`, {
    method: "POST", body: Buffer.concat([full, thumb]),
    headers: {
      ...page.headers, "Content-Type": "application/octet-stream",
      "X-Silvergrain-CSRF": page.token, "X-Silvergrain-Full-Bytes": String(full.length),
    },
  });
  const payload = await result.json();
  assert.equal(result.status, 201, JSON.stringify(payload));
  return payload.id;
}

before(async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: 'import { fetchJournal } from "./worker/journal"; export default { fetch: fetchJournal };',
      resolveDir: process.cwd(),
    },
    bundle: true, platform: "neutral", format: "esm", write: false,
  });
  runtime = new Miniflare({
    modules: [{ type: "ESModule", path: "journal.js", contents: outputFiles[0].text }],
    compatibilityDate: "2026-05-15",
    d1Databases: ["DB"], r2Buckets: ["BUCKET"],
    bindings: { SILVERGRAIN_ADMIN_EMAIL: "owner@example.com", SILVERGRAIN_FORM_SECRET: "test-fixture-key".repeat(5) },
  });
  db = await runtime.getD1Database("DB");
  const migrations = (await readdir("drizzle")).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(migrations.length > 0);
  for (const migration of migrations) {
    const contents = await readFile(`drizzle/${migration}`, "utf8");
    await db.batch(contents.split("--> statement-breakpoint").map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
  }
});
after(async () => runtime?.dispose());

test("public pages are a photo magazine and the dashboard remains owner-only", async () => {
  const homepage = await request("/");
  const markup = await homepage.text();
  assert.match(markup, /<h1>Silvergrain<\/h1>/);
  assert.equal((markup.match(/data-magazine-photo=/g) ?? []).length, 5);
  assert.match(markup, /Where the light falls/);
  assert.match(markup, /At first light/);
  assert.doesNotMatch(markup, /comment-form|Photo comments|data-slider|Featured story/);
  const filtered = await (await request("/journal?category=Architecture")).text();
  assert.equal((filtered.match(/data-magazine-photo=/g) ?? []).length, 1);
  assert.match(filtered, /Between the arches/);
  assert.doesNotMatch(filtered, /The shape of water/);
  assert.match(await (await request("/admin")).text(), /Sign in with ChatGPT/);
  assert.equal((await request("/admin", { headers: member })).status, 403);
  const studio = await request("/admin", { headers: owner });
  assert.equal(studio.status, 200);
  const dashboard = await studio.text();
  assert.match(dashboard, /Photo order/);
  assert.doesNotMatch(dashboard, /Comments|\/admin\/comments/);
  assert.equal((await request("/admin/comments", { headers: owner })).status, 404);
  assert.equal((await request("/admin", { headers: { ...owner, "oai-authenticated-user-id": "different-id" } })).status, 403);
  const edit = await page("/admin/settings", owner);
  assert.equal((await request("/admin/settings", {
    method: "POST", body: new URLSearchParams({ name: "Changed" }), headers: edit.headers,
  })).status, 403);
});

test("each uploaded photo has its own story through publishing, editing, and private drafts", async () => {
  const draft = await page("/admin/stories/new", owner);
  const id = field(draft.text, "post_id");
  const left = await upload(draft, id, "dolomites");
  const right = await upload(draft, id, "alpine-lake");
  const entries = [
    { id: left, alt: "Mountain frame", caption: "Before sunrise", title: "The high ridge", story: "A mountain story only." },
    { id: right, alt: "Lake frame", caption: "Still water", title: "The reflecting lake", story: "A lake story only." },
  ];
  const fields = {
    post_id: id, title: "Mountain trip", category: "Landscape", location: "Pisa", photo_date: "2026-11-12",
    caption: "", story: "Earlier shared text.", intent: "draft", uploads: JSON.stringify(entries),
  };
  assert.equal((await submit("/admin/stories/new", draft, fields)).status, 303);
  const story = `/stories/mountain-trip-${id.slice(0, 8)}`;
  const editPath = `/admin/stories/${id}`;
  assert.equal((await request(story)).status, 404);
  assert.equal((await request(`/media/${left}`, { headers: member })).status, 404);
  const preview = await request(`${story}/photos/${left}`, { headers: owner });
  const previewHtml = await preview.text();
  assert.match(previewHtml, /Draft preview|A mountain story only/);
  assert.doesNotMatch(previewHtml, /A lake story only/);
  assert.equal((await request(`/media/${left}`, { headers: owner })).headers.get("content-type"), "image/webp");
  let edit = await page(editPath, owner);
  const order = [right, left];
  const publish = { ...fields, intent: "publish", revision: field(edit.text, "revision"), uploads: "[]",
    [`alt_${left}`]: "Mountain frame", [`alt_${right}`]: "Lake frame",
    [`caption_${left}`]: "Before sunrise", [`caption_${right}`]: "Still water",
  };
  assert.equal((await submit(editPath, edit, publish, { order })).status, 303);
  assert.equal((await submit(editPath, edit, publish, { order })).status, 409);
  const magazine = await (await request("/")).text();
  assert.match(magazine, /A mountain story only/);
  assert.match(magazine, /A lake story only/);
  const mountain = await (await request(`${story}/photos/${left}`)).text();
  assert.match(mountain, /<h1>The high ridge<\/h1>/);
  assert.match(mountain, /A mountain story only/);
  assert.doesNotMatch(mountain, /A lake story only|Earlier shared text/);
  const lake = await (await request(story)).text();
  assert.match(lake, /<h1>The reflecting lake<\/h1>/);
  assert.match(lake, /A lake story only/);
  assert.equal((await request(`${story}/photos/dolomites`)).status, 404);
  assert.equal((await request(`${story}/photos/${left}/comments`, { method: "POST" })).status, 404);

  edit = await page(editPath, owner);
  const update = {
    ...publish, intent: "save", revision: field(edit.text, "revision"),
    [`title_${left}`]: "The ridgeline", [`story_${left}`]: "The revised mountain story.",
  };
  assert.equal((await submit(editPath, edit, update, { order })).status, 303);
  const revised = await (await request(`${story}/photos/${left}`)).text();
  assert.match(revised, /The revised mountain story/);
  assert.doesNotMatch(await (await request(`${story}/photos/${right}`)).text(), /revised mountain/);

  edit = await page(editPath, owner);
  assert.equal((await submit(editPath, edit, { ...update, intent: "draft", revision: field(edit.text, "revision") }, { order })).status, 303);
  assert.equal((await request(story)).status, 404);
  assert.equal((await request(`/media/${right}`)).status, 404);
  edit = await page(editPath, owner);
  assert.equal((await submit(`${editPath}/action`, edit, {
    revision: field(edit.text, "revision"), action: "delete", confirm: "yes",
  })).status, 303);
  assert.equal((await request(story, { headers: owner })).status, 404);
});

test("custom photo order is saved across pages with ten photos per page", async () => {
  const ids = [];
  const posts = [];
  for (let index = 0; index < 12; index++) {
    const postId = crypto.randomUUID();
    const photoId = crypto.randomUUID();
    ids.push(photoId);
    posts.push(postId);
    await db.batch([
      db.prepare(`INSERT INTO posts (id, slug, title, caption, story, category, location, photo_date, published_at, updated_at)
        VALUES (?, ?, ?, '', ?, 'Landscape', '', '', ?, ?)`)
        .bind(postId, `test-photo-${index}`, `Photo ${index + 1}`, `Independent story ${index + 1}.`, 1000 + index, 1000 + index),
      db.prepare(`INSERT INTO photos (id, post_id, position, alt, caption, width, height)
        VALUES (?, ?, 0, 'Test photograph', '', 120, 80)`).bind(photoId, postId),
    ]);
  }
  const orderPage = await page("/admin/order", owner);
  const allIds = [...orderPage.text.matchAll(/name="publication_photo" value="([^"]+)"/g)].map((entry) => entry[1]);
  assert.equal(allIds.length, 17);
  const desired = allIds.slice().reverse();
  const data = new URLSearchParams({ csrf: orderPage.token, order_revision: field(orderPage.text, "order_revision") });
  desired.forEach((id, index) => {
    data.append("publication_photo", id);
    data.set(`position_${id}`, String(index + 1));
  });
  assert.equal((await request("/admin/order", { method: "POST", body: data, headers: orderPage.headers })).status, 303);
  assert.equal((await request("/admin/order", { method: "POST", body: data, headers: orderPage.headers })).status, 409);

  const photoIds = (html) => [...html.matchAll(/data-magazine-photo="([^"]+)"/g)].map((entry) => entry[1]);
  const first = await (await request("/")).text();
  const second = await (await request("/page/2")).text();
  assert.deepEqual(photoIds(first), desired.slice(0, 10));
  assert.deepEqual(photoIds(second), desired.slice(10));
  assert.match(first, /Page 1 of 2/);
  assert.match(second, /Page 2 of 2/);
  assert.equal((await request("/page/3")).status, 404);
  const journal = await (await request("/journal")).text();
  const journalTwo = await (await request("/journal/page/2")).text();
  assert.deepEqual(photoIds(journal), desired.slice(0, 10));
  assert.deepEqual(photoIds(journalTwo), desired.slice(10));
  const ownerOnly = await request("/admin/order", { method: "POST", body: data, headers: member });
  assert.equal(ownerOnly.status, 303);
  const current = await page("/admin/order", owner);
  const invalid = new URLSearchParams({ csrf: current.token, order_revision: field(current.text, "order_revision") });
  desired.forEach((id) => { invalid.append("publication_photo", id); invalid.set(`position_${id}`, "1"); });
  assert.equal((await request("/admin/order", { method: "POST", body: invalid, headers: current.headers })).status, 400);
  assert.deepEqual(photoIds(await (await request("/")).text()), desired.slice(0, 10));

  // Rows from earlier versions inherit their original story until edited.
  assert.match(second, /Independent story/);
  await db.batch(posts.map((id) => db.prepare("DELETE FROM posts WHERE id = ?").bind(id)));
});

test("comment sections and submission routes are removed", async () => {
  for (const path of ["/", "/journal", "/stories/where-the-light-falls", "/stories/where-the-light-falls/photos/alpine-lake"]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /Photo comments|Post comment|discussion-link|comment-form/);
  }
  assert.equal((await request("/stories/where-the-light-falls/comments", { method: "POST" })).status, 404);
  assert.equal((await request("/admin/comments", { headers: owner })).status, 404);
});

test("the contact form still delivers messages once", async () => {
  const contact = await page("/contact");
  const [, a, b] = contact.text.match(/What is (\d+) \+ (\d+)\?/);
  const fields = { name: "A reader", email: "reader@example.com", body: "Hello from Pisa.",
    challenge: field(contact.text, "challenge"), answer: String(Number(a) + Number(b)) };
  assert.equal((await submit("/contact", contact, fields)).status, 303);
  assert.equal((await submit("/contact", contact, fields)).status, 400);
  const inbox = await page("/admin/inbox", owner);
  assert.match(inbox.text, /Hello from Pisa\./);
  assert.match(inbox.text, /1 unread/);
  assert.equal((await request("/admin/inbox", { headers: member })).status, 303);
});

test("the owner controls public contact details and sample visibility", async () => {
  const settings = await page("/admin/settings", owner);
  assert.equal((await submit("/admin/settings", settings, {
    name: "Sina", email: "public@example.com", phone: "+39 0123 4567", hide_samples: "1",
  })).status, 303);
  const contact = await (await request("/contact")).text();
  assert.match(contact, /mailto:public@example\.com/);
  assert.match(contact, /tel:\+3901234567/);
  assert.equal((await request("/stories/where-the-light-falls")).status, 404);
  assert.match(await (await request("/")).text(), /Published photographs will appear here/);
});
