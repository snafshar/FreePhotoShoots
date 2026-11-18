import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let runtime;
let db;
const mailRequests = [];
let mailResponse = 200;
const guest = {};
const owner = { "oai-authenticated-user-id": "test-owner", "oai-authenticated-user-email": "owner@example.com" };
const member = { "oai-authenticated-user-id": "test-reader", "oai-authenticated-user-email": "reader@example.com" };
const origin = "https://journal.example.com";

function request(path, options = {}) {
  return runtime.dispatchFetch(new URL(path, origin), { redirect: "manual", ...options });
}
async function markup(path, who = {}) {
  const response = await request(path,{headers:who});
  assert.equal(response.status,200);
  return response.text();
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
async function upload(page, id, name, desk = "/admin") {
  const full = await readFile(new URL(`../public/static/demo/${name}.webp`, import.meta.url));
  const thumb = await readFile(new URL(`../public/static/demo/${name}-small.webp`, import.meta.url));
  const result = await request(`${desk}/uploads/${id}`, {
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
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: [{ type: "ESModule", path: "journal.js", contents: outputFiles[0].text }],
    outboundService: async request => {
      if (request.url !== "https://api.resend.com/emails") return new Response(null,{status:404});
      mailRequests.push({key:request.headers.get("Idempotency-Key"), body:await request.json()});
      return Response.json(mailResponse === 200 ? {id:"fixture-"+mailRequests.length} : {message:"Rejected"}, {status:mailResponse});
    },
    compatibilityDate: "2026-05-15",
    d1Databases: ["DB"], r2Buckets: ["BUCKET"],
    bindings: { SILVERGRAIN_ADMIN_EMAIL: "owner@example.com", SILVERGRAIN_FORM_SECRET: "test-fixture-key".repeat(5) },
  }));
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
  const ownerMagazine = await (await request("/sina-afshar")).text();
  assert.match(ownerMagazine, /@sina-afshar/);
  assert.deepEqual(ownerMagazine.match(/data-magazine-photo="[^"]+"/g),markup.match(/data-magazine-photo="[^"]+"/g));
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

const principal = name => ({ "oai-authenticated-user-id":"user-"+name, "oai-authenticated-user-email":name+"@example.org" });
async function apply(name, handle = name) {
  const who = principal(name), form = await page("/join",who);
  const result = await submit("/join",form,{name,handle,note:"Photography request",email:"ignored@example.org"});
  assert.equal(result.status,303);
  return db.prepare("SELECT * FROM contributors WHERE site_user_id=?").bind(who["oai-authenticated-user-id"]).first();
}
async function review(person,action) {
  const path = "/admin/users/"+person.id;
  const form = await page(path,owner);
  return submit(path+"/decision",form,{revision:field(form.text,"revision"),action});
}

test("applications, owner approval, and automatic email with a durable outbox", async () => {
  assert.match(await (await request("/join")).text(),/signin-with-chatgpt\?return_to=%2Fjoin/);
  assert.match(await (await request("/login")).text(),/signin-with-chatgpt\?return_to=%2Faccount/);
  const ada = principal("ada"), lee = principal("lee"), initial = await page("/join",ada);
  assert.equal((await submit("/join",initial,{name:"Ada",handle:"admin"})).status,400);
  const person = await apply("ada","ada-magazine");
  assert.equal(person.email,"ada@example.org");
  assert.equal(person.status,"pending");
  assert.match(await (await request("/account",{headers:ada})).headers.get("location"),/join/);
  assert.match(await (await request("/join",{headers:ada})).text(),/Request received/);
  assert.equal((await request("/ada-magazine")).status,404);
  assert.equal((await request("/studio/stories/new",{method:"POST",headers:ada})).status,403);
  assert.equal((await request("/admin/users",{headers:ada})).status,303);
  const other = await page("/join",lee);
  assert.equal((await submit("/join",other,{name:"Lee",handle:"ada-magazine"})).status,409);
  assert.match(await markup("/admin/users?status=pending",owner),/ada-magazine/);
  const path = "/admin/users/"+person.id, decision = await page(path,owner);
  const accepted = {action:"approve", revision:field(decision.text,"revision")};
  assert.equal((await submit(path+"/decision",decision,accepted)).headers.get("location"),path+"?saved=queued");
  assert.equal((await submit(path+"/decision",decision,accepted)).status,409);
  const queued = await db.prepare("SELECT * FROM approval_emails WHERE member_id=?").bind(person.id).first();
  assert.equal(queued.recipient,"ada@example.org");
  assert.equal(queued.state,"queued");
  assert.equal(mailRequests.length,0);
  assert.match(await markup("/studio",ada),/Sign out/);
  assert.match(await (await request("/ada-magazine")).text(),/@ada-magazine/);
  const emailPage = await page("/admin/email",owner);
  assert.match(emailPage.text,/Compose approval email/);
  const testKey = "re_fixture_local_delivery_only";
  assert.equal((await submit("/admin/email",emailPage,{from:"editor@example.org",api_key:testKey})).status,303);
  assert.ok(!(await db.prepare("SELECT value FROM settings WHERE key='mail_sender'").first("value")).includes(testKey));
  assert.ok(!(await (await request("/admin/email",{headers:owner})).text()).includes(testKey));
  const endpoint = "/admin/email/"+queued.id;
  mailResponse = 422;
  assert.equal((await submit(endpoint,emailPage,{action:"send"})).status,303);
  assert.equal(await db.prepare("SELECT state FROM approval_emails WHERE id=?").bind(queued.id).first("state"),"failed");
  mailResponse = 200;
  assert.equal((await submit(endpoint,emailPage,{action:"send"})).status,303);
  assert.equal((await submit(endpoint,emailPage,{action:"send"})).status,303);
  assert.equal(mailRequests.length,2);
  assert.equal(mailRequests[0].key,mailRequests[1].key);
  assert.deepEqual(mailRequests[1].body.to,["ada@example.org"]);
  assert.match(mailRequests[1].body.text,/\/studio/);
  assert.equal(await db.prepare("SELECT state FROM approval_emails WHERE id=?").bind(queued.id).first("state"),"accepted");

  const second = await apply("lee","lee-magazine");
  assert.equal((await review(second,"decline")).status,303);
  assert.equal((await request("/lee-magazine")).status,404);
  assert.equal((await review(second,"approve")).status,303);
  assert.equal(mailRequests.length,3);
  assert.deepEqual(mailRequests[2].body.to,["lee@example.org"]);
  assert.match((await page("/admin/users/"+second.id,owner)).text,/Account history/);
  for (const url of ["/photographers","/ada-magazine","/lee-magazine/contact"]) {
    assert.doesNotMatch(await (await request(url)).text(),/ada@example\.org|lee@example\.org|Photography request/);
  }
});

test("two photographers have separate posts, draft photos, ordering, profiles, and inboxes", async () => {
  const alice = await apply("coast-author"), bob = await apply("city-author");
  await review(alice,"approve"); await review(bob,"approve");
  const a = principal("coast-author"), b = principal("city-author");
  const mine = await page("/studio/stories/new",a), theirs = await page("/studio/stories/new",b);
  assert.match(mine.text,/data-upload-base="\/studio\/uploads"/);
  const id = field(mine.text,"post_id"), photo = await upload(mine,id,"coast","/studio");
  const thumb = "/studio/uploads/"+id+"/"+photo;
  assert.equal((await request(thumb,{headers:a})).status,200);
  assert.equal((await request(thumb,{headers:b})).status,404);
  const base = {post_id:id,title:"Tide notes",category:"Seascape",location:"Pisa",photo_date:"",intent:"draft",
    uploads:JSON.stringify([{id:photo,alt:"A wave",caption:"Morning tide",title:"Incoming water",story:"The sea rose."}])};
  assert.equal((await submit("/studio/stories/new",theirs,base)).status,409);
  assert.equal((await submit("/studio/stories/new",mine,base)).status,303);
  const editPath = "/studio/stories/"+id, edit = await page(editPath,a);
  const detail = "/coast-author/stories/tide-notes-"+id.slice(0,8)+"/photos/"+photo;
  assert.equal((await request(editPath,{headers:b})).status,404);
  assert.equal((await request(detail)).status,404);
  assert.equal((await request(detail,{headers:a})).status,200);
  assert.equal((await request("/media/"+photo,{headers:b})).status,404);
  const publish={...base,revision:field(edit.text,"revision"),intent:"publish",uploads:"[]",["caption_"+photo]:"Morning tide"};
  assert.equal((await submit(editPath,edit,publish,{order:[photo]})).status,303);
  assert.match(await (await request(detail)).text(),/The sea rose/);
  assert.match(await (await request("/coast-author")).text(),/Incoming water/);
  assert.doesNotMatch(await (await request("/city-author")).text(),/Incoming water/);
  assert.doesNotMatch(await (await request("/")).text(),/Incoming water/);
  const order = await page("/studio/order",a);
  assert.match(order.text,new RegExp(photo));
  assert.doesNotMatch(await markup("/studio/order",b),new RegExp(photo));
  const reorder = {order_revision:field(order.text,"order_revision"),publication_photo:photo,["position_"+photo]:"1"};
  assert.equal((await submit("/studio/order",order,reorder)).status,303);
  assert.equal((await db.prepare("SELECT value FROM settings WHERE key=?").bind("photo_order:"+alice.id).first("value")).includes(photo),true);

  const profileForm = await page("/studio/profile",a);
  const profile = {name:"Coast Author",bio:"Quiet places",location:"Pisa",public_email:"printshop@example.org",public_phone:"",revision:field(profileForm.text,"revision")};
  const cross = await request("/studio/profile",{method:"POST",headers:{...profileForm.headers,Origin:"https://another.example"},body:new URLSearchParams({csrf:profileForm.token,...profile})});
  assert.equal(cross.status,403);
  assert.equal((await submit("/studio/profile",profileForm,profile)).status,303);
  assert.match(await (await request("/coast-author")).text(),/Quiet places/);
  const contact = await page("/coast-author/contact");
  assert.match(contact.text,/printshop@example\.org/);
  const [,left,right] = contact.text.match(/What is (\d+) \+ (\d+)\?/);
  assert.equal((await submit("/coast-author/contact",contact,{name:"Reader",email:"reader@example.org",body:"For the coast author",
    challenge:field(contact.text,"challenge"),answer:String(Number(left)+Number(right))})).status,303);
  assert.match((await page("/studio/inbox",a)).text,/For the coast author/);
  assert.doesNotMatch(await markup("/studio/inbox",b),/For the coast author/);
  const msg = await db.prepare("SELECT id FROM messages WHERE owner_id=?").bind(alice.id).first("id");
  assert.equal((await submit("/studio/inbox/"+msg+"/action",theirs,{action:"delete"})).status,404);
  assert.match(await markup("/admin?author="+alice.id,owner),/Tide notes/);
  assert.equal((await request("/admin/stories/"+id,{headers:owner})).status,200);

  await review(alice,"suspend");
  for (const url of ["/coast-author",detail,"/media/"+photo]) assert.equal((await request(url)).status,404);
  assert.equal((await request("/media/"+photo,{headers:a})).status,404);
  assert.equal((await submit(editPath,edit,publish,{order:[photo]})).status,403);
  await review(alice,"restore");
  assert.equal((await request(detail)).status,200);
  const path = "/admin/users/"+alice.id, row = await page(path,owner);
  assert.equal((await submit(path+"/delete",row,{revision:field(row.text,"revision"),confirm_handle:alice.handle})).status,303);
  assert.equal((await request(detail)).status,404);
  assert.equal((await request("/media/"+photo)).status,404);
  assert.equal(await db.prepare("SELECT count(*) AS n FROM posts WHERE owner_id=?").bind(alice.id).first("n"),0);
});

test("manual approval delivery cannot also be sent automatically", async () => {
  mailResponse=422;
  try {
    const person=await apply("manual-sender");
    await review(person,"approve");
    const notification=await db.prepare("SELECT id FROM approval_emails WHERE member_id=?").bind(person.id).first("id");
    const path="/admin/email/"+notification, outbox=await page("/admin/email",owner), count=mailRequests.length;
    assert.equal((await submit(path,outbox,{action:"manual"})).status,400);
    assert.equal((await submit(path,outbox,{action:"manual",sent_by_editor:"yes"})).status,303);
    assert.equal((await submit(path,outbox,{action:"send"})).status,303);
    assert.equal(await db.prepare("SELECT state FROM approval_emails WHERE id=?").bind(notification).first("state"),"manual");
    assert.equal(mailRequests.length,count);
  } finally { mailResponse=200; }
});

test("only the editor can change global appearance and pause new applications", async () => {
  const theme = await page("/admin/appearance",owner);
  const values = {magazine_title:"Field Journal",paper:"linen",spacing:"compact",typeface:"classic"};
  assert.equal((await submit("/admin/appearance",theme,values)).status,303);
  for (const url of ["/","/sina-afshar","/photographers"]) {
    const markup=await (await request(url)).text();
    assert.match(markup,/data-paper="linen" data-typeface="classic" data-spacing="compact"/);
    assert.match(markup,/Field Journal/);
  }
  const applicant=principal("new-applicant");
  assert.match(await (await request("/join",{headers:applicant})).text(),/currently closed/);
  const signed=await page("/contact",applicant);
  await submit("/admin/appearance",signed,{...values,paper:"white"});
  assert.match(await (await request("/")).text(),/data-paper="linen"/);
});
