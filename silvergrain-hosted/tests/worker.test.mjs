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

test("public journal, signed-in owner, and dashboard boundary", async () => {
  const homepage = await request("/");
  assert.match(await homepage.text(), /Where the<br><em>light falls/);
  const journal = await request("/journal?category=Architecture");
  const filtered = await journal.text();
  assert.match(filtered, /Between the arches/);
  assert.doesNotMatch(filtered, /The shape of water/);
  assert.match(await (await request("/admin")).text(), /Sign in with ChatGPT/);
  assert.equal((await request("/admin", { headers: member })).status, 403);
  const studio = await request("/admin", { headers: owner });
  assert.equal(studio.status, 200);
  assert.match(await studio.text(), /Dashboard/);
  assert.equal((await request("/admin", { headers: { ...owner, "oai-authenticated-user-id": "different-id" } })).status, 403);
  assert.equal((await request("/admin/settings", { method: "POST", body: new URLSearchParams(), headers: member })).status, 303);
  const edit = await page("/admin/settings", owner);
  const noToken = await request("/admin/settings", { method: "POST", body: new URLSearchParams({ name: "Changed" }), headers: edit.headers });
  assert.equal(noToken.status, 403);
});

test("two photos stay private in a draft, then publish, reorder, unpublish, and delete", async () => {
  const newPath = "/admin/stories/new";
  const draft = await page(newPath, owner);
  const id = field(draft.text, "post_id");
  const left = await upload(draft, id, "dolomites");
  const right = await upload(draft, id, "alpine-lake");
  assert.equal((await request(`/admin/uploads/${id}/${right}`, { headers: member })).status, 403);
  assert.equal((await request(`/admin/uploads/${id}/${right}`, { headers: owner })).status, 200);
  const fields = {
    post_id: id, title: "Morning on the Arno", category: "Landscape", location: "Pisa", photo_date: "2026-11-12",
    caption: "Two views from the bridge", story: "First paragraph.\n\nSecond paragraph.",
    intent: "draft", uploads: JSON.stringify([{ id: left, alt: "First frame", caption: "" }, { id: right, alt: "Second frame", caption: "Reflections" }]),
  };
  let response = await submit(newPath, draft, fields);
  assert.equal(response.status, 303, await response.text());
  const story = `/stories/morning-on-the-arno-${id.slice(0, 8)}`;
  const editPath = `/admin/stories/${id}`;
  const cover = `/media/${right}`;
  assert.equal((await request(story)).status, 404);
  assert.equal((await request(cover, { headers: member })).status, 404);
  const preview = await request(story, { headers: owner });
  assert.match(await preview.text(), /Draft preview/);
  assert.equal((await request(cover, { headers: owner })).headers.get("content-type"), "image/webp");
  let edit = await page(editPath, owner);
  let revision = field(edit.text, "revision");
  const order = [right, left];
  const publish = { ...fields, intent: "publish", revision, uploads: "[]", [`alt_${left}`]: "First frame", [`alt_${right}`]: "Second frame" };
  response = await submit(editPath, edit, publish, { order });
  assert.equal(response.status, 303, await response.text());
  assert.equal((await submit(editPath, edit, publish, { order })).status, 409);
  const publicStory = await request(story);
  const storyHtml = await publicStory.text();
  assert.equal(publicStory.status, 200, storyHtml);
  assert.ok(storyHtml.indexOf('alt="Second frame"') < storyHtml.indexOf('alt="First frame"'));
  assert.match(storyHtml, /Second paragraph/);
  assert.equal((await request(cover)).status, 200);
  edit = await page(editPath, owner);
  revision = field(edit.text, "revision");
  assert.equal((await submit(editPath, edit, { ...publish, intent: "draft", revision }, { order })).status, 303);
  assert.equal((await request(story)).status, 404);
  assert.equal((await request(cover)).status, 404);
  edit = await page(editPath, owner);
  assert.equal((await submit(`${editPath}/action`, edit, {
    revision: field(edit.text, "revision"), action: "delete", confirm: "yes",
  })).status, 303);
  assert.equal((await request(story, { headers: owner })).status, 404);
});

test("comments need approval and the contact form delivers messages once", async () => {
  const path = "/stories/where-the-light-falls";
  const reader = await page(path);
  const comment = "Silver light on the ridgeline.";
  assert.equal((await submit(`${path}/comments`, reader, { name: "A reader", body: comment })).status, 303);
  assert.doesNotMatch(await (await request(path)).text(), /Silver light on the ridgeline/);
  const moderation = await page("/admin/comments", owner);
  const action = moderation.text.match(/\/admin\/comments\/\d+\/action/)[0];
  assert.equal((await submit(action, moderation, { action: "approve" })).status, 303);
  assert.match(await (await request(path)).text(), /Silver light on the ridgeline/);

  const contact = await page("/contact");
  const [, a, b] = contact.text.match(/What is (\d+) \+ (\d+)\?/);
  const fields = {
    name: "A reader", email: "reader@example.com", body: "Hello from Pisa.",
    challenge: field(contact.text, "challenge"), answer: String(Number(a) + Number(b)),
  };
  assert.equal((await submit("/contact", contact, fields)).status, 303);
  assert.equal((await submit("/contact", contact, fields)).status, 400);
  const inbox = await page("/admin/inbox", owner);
  assert.match(inbox.text, /Hello from Pisa\./);
  assert.match(inbox.text, /1 unread/);
  assert.equal((await request("/admin/inbox", { headers: member })).status, 303);
});

test("contact details and sample visibility are controlled by the owner", async () => {
  const settings = await page("/admin/settings", owner);
  const response = await submit("/admin/settings", settings, {
    name: "Sina", email: "public@example.com", phone: "+39 0123 4567", hide_samples: "1",
  });
  assert.equal(response.status, 303);
  const contact = await request("/contact");
  const html = await contact.text();
  assert.match(html, /mailto:public@example\.com/);
  assert.match(html, /tel:\+3901234567/);
  assert.equal((await request("/stories/where-the-light-falls")).status, 404);
  assert.match(await (await request("/")).text(), /Stories will appear here when/);
});
