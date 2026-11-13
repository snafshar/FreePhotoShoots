import {
  addComment, approvedComments, categories, dashboard, deleteStory, maxPhotos, neighbors, pendingFor, photoKeys,
  photosFor, publishedCards, readStory, saveStory, setSettings, settings, storyIdPattern,
} from "./data";
import type { EditPhoto, SavePhoto } from "./data";
import {
  challenge, field, formToken, HttpError, identify, readForm, seconds, turnstile,
  validEmail, validPhone, verifyChallenge, rateLimit,
} from "./security";
import type { Identity } from "./security";
import type { Bindings, Settings, Story, StoryInput } from "./types";
import { media, pendingMedia, uploadPhoto } from "./uploads";
import { dashboardView, editorView, signIn } from "./views/admin";
import { escape, layout } from "./views/layout";
import { archive, contactView, home, storyView } from "./views/public";

type Active = "home" | "journal" | "contact" | "admin" | "";
type State = { request: Request; env: Bindings; identity: Identity; site: Settings; url: URL };
const pages = { stories: "Story saved.", deleted: "Story deleted.", moderated: "Comment updated.", read: "Message updated.", settings: "Contact details saved." };
const originalCsp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'";
const fallbackSite = { name: "Sina Afshar", email: "", phone: "", hide_samples: "0" };

function html(state: State, title: string, active: Active, body: string, options: { status?: number; cookie?: string; turnstile?: boolean } = {}) {
  let csp = originalCsp;
  let head = "";
  if (options.turnstile) {
    csp = csp.replace("script-src 'self'", "script-src 'self' https://challenges.cloudflare.com") + "; frame-src https://challenges.cloudflare.com";
    head = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';
  }
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  if (active === "admin" || state.url.pathname.startsWith("/admin")) {
    headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  if (options.cookie) headers.append("Set-Cookie", options.cookie);
  const content = state.request.method === "HEAD" ? null : layout(state.site, title, active, state.identity.admin, body, head);
  return new Response(content, { status: options.status ?? 200, headers });
}

function redirect(location: string) {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}
function errorPage(state: State, error: HttpError) {
  if (state.request.method === "POST" && state.url.pathname.startsWith("/admin/uploads/")) {
    return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  return html(state, String(error.status), "", `<section class="shell narrow-page"><p class="eyebrow">${error.status}</p>
    <h1>${escape(error.message)}</h1><a class="small-link" href="/">← Back to the home page</a></section>`, { status: error.status });
}
const notFound = (message = "This page is unavailable.") => new HttpError(404, message);
const isFormError = (error: unknown): error is HttpError => error instanceof HttpError && error.status === 400;

async function storyPage(state: State, slug: string, issue?: HttpError, form?: URLSearchParams) {
  const result = await readStory(state.env.DB, state.site, slug, state.identity.admin);
  if (!result) throw notFound("This story is unavailable.");
  const { post, photos } = result;
  const pageString = state.url.searchParams.get("comments") ?? "1";
  if (!/^[1-9][0-9]{0,6}$/.test(pageString)) throw notFound("This comments page does not exist.");
  const page = Number(pageString);
  const [adjacent, feedback, csrf] = await Promise.all([
    neighbors(state.env.DB, post, state.site), approvedComments(state.env.DB, post.id, page),
    post.published_at !== null ? formToken(state.request, state.env, state.identity) : { token: "", cookie: "" },
  ]);
  if (page > feedback.pages) throw notFound("This comments page does not exist.");
  return html(state, post.title, "journal", storyView({
    post, photos, adjacent, comments: feedback.comments, commentCount: feedback.total, page,
    pages: feedback.pages, csrf: csrf.token, sent: state.url.searchParams.get("comment") === "sent", error: issue?.message, form,
  }), { cookie: csrf.cookie, status: issue?.status });
}

async function postComment(state: State, slug: string) {
  const { request, env, site, identity } = state;
  const post = (await readStory(env.DB, site, slug, false))?.post;
  if (!post) throw notFound("This story is unavailable.");
  const form = await readForm(request, env, identity);
  await rateLimit(request, env, "comment", 8);
  if (form.get("company")) return redirect(`/stories/${slug}?comment=sent#comments`);
  try {
    const name = field(form, "name", 60), body = field(form, "body", 1500, "comment");
    if (!name || !body) throw new HttpError(400, "Enter your name and comment.");
    await addComment(env.DB, post, name, body);
  } catch (error) {
    if (isFormError(error)) return storyPage(state, slug, error, form);
    throw error;
  }
  return redirect(`/stories/${slug}?comment=sent#comments`);
}

async function contact(state: State, issue?: HttpError, form?: URLSearchParams) {
  const csrf = await formToken(state.request, state.env, state.identity);
  const key = turnstile(state.env);
  return html(state, "Contact", "contact", contactView(state.site, {
    csrf: csrf.token, key, challenge: key ? undefined : await challenge(state.env, csrf.token),
    sent: state.url.searchParams.get("message") === "sent", error: issue?.message, form,
  }), { cookie: csrf.cookie, status: issue?.status, turnstile: !!key });
}

async function sendMessage(state: State) {
  const { request, env, identity } = state;
  const form = await readForm(request, env, identity);
  await rateLimit(request, env, "contact", 8);
  if (!form.get("company")) {
    try {
      const name = field(form, "name", 60), email = field(form, "email", 254), body = field(form, "body", 3000, "message");
      if (!name || !validEmail(email) || !body) throw new HttpError(400, "Enter your name, a valid email, and a message.");
      if (!await verifyChallenge(env, form)) throw new HttpError(400, "The verification did not pass. Try the new challenge.");
      await env.DB.prepare("INSERT INTO messages (name, email, body, created_at) VALUES (?, ?, ?, ?)")
        .bind(name, email, body, seconds()).run();
    } catch (error) {
      if (isFormError(error)) return contact(state, error, form);
      throw error;
    }
  }
  return redirect("/contact?message=sent#contact-form");
}

async function showDashboard(state: State, section: string, error?: HttpError, site = state.site) {
  const viewParam = state.url.searchParams.get("view") ?? "";
  const view = ["published", "draft"].includes(viewParam) ? viewParam : "all";
  const noticeKey = state.url.searchParams.get("saved") ?? "";
  const message = Object.hasOwn(pages, noticeKey) ? pages[noticeKey as keyof typeof pages] : "";
  const csrf = await formToken(state.request, state.env, state.identity);
  const data = await dashboard(state.env.DB, section, view, site);
  return html(state, "Dashboard", "admin", dashboardView(data, section, view, site, csrf.token, message, error?.message),
    { cookie: csrf.cookie, status: error?.status });
}

const storyFields = {
  title: 100, caption: 300, story: 12000, category: 20, location: 100, photo_date: 10,
};

function validatedStory(form: URLSearchParams): StoryInput {
  const values = Object.fromEntries(Object.entries(storyFields).map(([key, max]) =>
    [key, field(form, key, max, key.replace("_", " "))],
  )) as StoryInput;
  if (!values.title || !categories.includes(values.category)) throw new HttpError(400, "Enter a title and choose a category.");
  const date = values.photo_date;
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000-") ||
    !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) {
    throw new HttpError(400, "Enter a valid date for the photographs.");
  }
  return values;
}

function queuedPhotos(form: URLSearchParams): EditPhoto[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(form.get("uploads") ?? "[]");
  } catch {
    throw new HttpError(400, "The uploaded photos could not be read.");
  }
  if (!Array.isArray(parsed) || parsed.length > maxPhotos) throw new HttpError(400, "Select up to ten photographs.");
  return parsed.map((photo) => {
    if (!photo || typeof photo.id !== "string" || !storyIdPattern.test(photo.id) ||
      typeof photo.alt !== "string" || photo.alt.length > 200 || typeof photo.caption !== "string" || photo.caption.length > 300) {
      throw new HttpError(400, "Use up to 200 characters for alt text and 300 for photo captions.");
    }
    return { id: photo.id, alt: photo.alt.trim(), caption: photo.caption.trim() };
  });
}

async function editor(state: State, post: Story | null, id: string, error?: HttpError, form?: URLSearchParams) {
  const db = state.env.DB;
  const photos = post ? await photosFor(db, id) : [];
  let values: StoryInput = post ?? {
    title: "", caption: "", story: "", category: "Landscape", location: "", photo_date: new Date().toISOString().slice(0, 10),
  };
  let uploads: EditPhoto[] = [];
  let edits: Record<string, { alt: string; caption: string }> = {};
  if (form) {
    values = Object.fromEntries(Object.entries(storyFields).map(([key, max]) => [key, (form.get(key) ?? "").slice(0, max)])) as StoryInput;
    try {
      const items = queuedPhotos(form);
      const available = await pendingFor(db, id, items.map((item) => item.id));
      uploads = items.filter((item) => available.has(item.id));
    } catch (issue) {
      if (!isFormError(issue)) throw issue;
    }
    edits = Object.fromEntries(photos.map(({ id }) => [id, {
      alt: (form.get(`alt_${id}`) ?? "").slice(0, 200), caption: (form.get(`caption_${id}`) ?? "").slice(0, 300),
    }]));
  }
  const csrf = await formToken(state.request, state.env, state.identity);
  return html(state, post ? "Edit story" : "New story", "admin", editorView({
    id, post, photos, values, csrf: csrf.token, error: error?.message, queued: JSON.stringify(uploads), edits,
  }), { cookie: csrf.cookie, status: error?.status });
}

async function mutateStory(state: State, post: Story | null, id: string, ctx: ExecutionContext) {
  const form = await readForm(state.request, state.env, state.identity);
  const postId = post ? id : (form.get("post_id") ?? "");
  if (!storyIdPattern.test(postId) || (post && form.get("post_id") !== postId)) throw new HttpError(400, "Reload the story editor.");
  if (post && form.get("revision") !== String(post.revision)) {
    return editor(state, post, postId, new HttpError(409, "This story changed in another tab. Review the current version."));
  }
  try {
    const values = validatedStory(form);
    const intent = form.get("intent") ?? "";
    if (!["draft", "publish", "save"].includes(intent)) throw new HttpError(400, "Choose how to save the story.");
    const order = form.getAll("photo_order");
    const remove = new Set(form.getAll("remove_photo"));
    if (order.length > maxPhotos || order.some((id) => !storyIdPattern.test(id))) throw new HttpError(400, "Reload the story editor.");
    const existing: SavePhoto[] = order.filter((id) => !remove.has(id)).map((id) => ({
      id, isNew: false, alt: field(form, `alt_${id}`, 200, "alt text"), caption: field(form, `caption_${id}`, 300, "photo caption"),
    }));
    const edits = [...existing, ...queuedPhotos(form).map((photo) => ({ ...photo, isNew: true }))];
    if (edits.length > maxPhotos || new Set(edits.map(({ id }) => id)).size !== edits.length) {
      throw new HttpError(400, "Keep up to ten different photographs in one story.");
    }
    const removed = await saveStory(state.env, postId, post, values, intent, edits);
    cleanObjects(state.env, ctx, removed);
  } catch (error) {
    if (isFormError(error)) return editor(state, post, postId, error, form);
    throw error;
  }
  return redirect("/admin?saved=stories");
}

function cleanObjects(env: Bindings, ctx: ExecutionContext, ids: string[]) {
  if (ids.length) ctx.waitUntil(env.BUCKET.delete(ids.flatMap((id) => [...photoKeys(id)])).catch((error) => {
    console.error("Could not remove photo objects", error instanceof Error ? error.name : "storage error");
  }));
}

async function saveDetails(state: State) {
  const form = await readForm(state.request, state.env, state.identity);
  try {
    const name = field(form, "name", 100);
    const email = field(form, "email", 254), phone = field(form, "phone", 30);
    if (!name || (email && !validEmail(email)) || (phone && !validPhone(phone))) {
      throw new HttpError(400, "Enter a display name and valid contact details.");
    }
    await setSettings(state.env.DB, { name, email, phone, hide_samples: form.get("hide_samples") === "1" ? "1" : "0" });
  } catch (error) {
    if (isFormError(error)) return showDashboard(state, "settings", error, {
      name: (form.get("name") ?? "").slice(0, 100), email: (form.get("email") ?? "").slice(0, 254),
      phone: (form.get("phone") ?? "").slice(0, 30), hide_samples: form.get("hide_samples") === "1" ? "1" : "0",
    });
    throw error;
  }
  return redirect("/admin/settings?saved=settings");
}

async function adminAction(state: State, section: string, id: string, ctx: ExecutionContext) {
  const form = await readForm(state.request, state.env, state.identity);
  const db = state.env.DB;
  const action = form.get("action");
  if (section === "stories" && storyIdPattern.test(id) && action === "delete" && form.get("confirm") === "yes") {
    const revision = Number(form.get("revision"));
    if (!Number.isSafeInteger(revision) || revision <= 0) throw new HttpError(400, "Reload the story editor.");
    cleanObjects(state.env, ctx, await deleteStory(db, id, revision));
    return redirect("/admin?saved=deleted");
  }
  if (!/^[1-9][0-9]{0,14}$/.test(id)) throw notFound();
  if (section === "comments" && (action === "approve" || action === "hide" || action === "delete")) {
    if (action === "delete") await db.prepare("DELETE FROM comments WHERE id = ?").bind(Number(id)).run();
    else await db.prepare("UPDATE comments SET status = ? WHERE id = ?").bind(action === "approve" ? "approved" : "pending", Number(id)).run();
    return redirect("/admin/comments?saved=moderated");
  }
  if (section === "inbox" && (action === "read" || action === "unread" || action === "delete")) {
    if (action === "delete") await db.prepare("DELETE FROM messages WHERE id = ?").bind(Number(id)).run();
    else await db.prepare("UPDATE messages SET read_at = ? WHERE id = ?").bind(action === "read" ? seconds() : null, Number(id)).run();
    return redirect("/admin/inbox?saved=read");
  }
  throw new HttpError(400, "Choose a valid dashboard action.");
}

async function admin(state: State, ctx: ExecutionContext, path: string, get: boolean) {
  const { request, env, identity } = state;
  if (!identity.admin) {
    if (path.startsWith("/admin/uploads/")) throw new HttpError(403, "Sign in to upload photographs.");
    if (get && (path === "/admin" || path === "/admin/sign-in")) {
      return html(state, "Admin", "admin", signIn(identity.signedIn), { status: identity.signedIn ? 403 : 200 });
    }
    return redirect("/admin");
  }
  if (get && path === "/admin/sign-in") return redirect("/admin");
  if (get && path === "/admin") return showDashboard(state, "stories");
  const section = path.match(/^\/admin\/(comments|inbox|settings)$/)?.[1];
  if (get && section) return showDashboard(state, section);
  if (!get && path === "/admin/settings") return saveDetails(state);
  const upload = path.match(/^\/admin\/uploads\/([a-f0-9-]{36})(?:\/([a-f0-9-]{36}))?$/);
  if (upload && get && upload[2]) return pendingMedia(env, upload[1], upload[2]);
  if (upload && !get && !upload[2]) return uploadPhoto(request, env, identity, upload[1]);
  const action = path.match(/^\/admin\/(stories|comments|inbox)\/([a-z0-9-]+)\/action$/);
  if (action && !get) return adminAction(state, action[1], action[2], ctx);
  const id = path.match(/^\/admin\/stories\/(new|[a-f0-9-]{36})$/)?.[1];
  if (!id) throw notFound();
  if (id === "new") {
    return get ? editor(state, null, crypto.randomUUID()) : mutateStory(state, null, id, ctx);
  }
  if (!storyIdPattern.test(id)) throw notFound();
  const post = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<Story>();
  if (!post) throw notFound();
  return get ? editor(state, post, id) : mutateStory(state, post, id, ctx);
}

export function isJournalPath(path: string) {
  return path === "/" || /^\/(?:journal|stories|contact|admin|media)(?:\/|$)/.test(path);
}

export async function fetchJournal(request: Request, env: Bindings, ctx: ExecutionContext) {
  const url = new URL(request.url);
  const state: State = { request, env, url, site: fallbackSite, identity: { admin: false, signedIn: false, id: "" } };
  const path = url.pathname.replace(/\/$/, "") || "/";
  const get = request.method === "GET" || request.method === "HEAD";
  try {
    if (!get && request.method !== "POST") throw new HttpError(405, "This request method is unavailable.");
    state.identity = await identify(request, env);
    const image = path.match(/^\/media\/([a-f0-9-]{36})(\/small)?$/);
    if (get && image && storyIdPattern.test(image[1])) return await media(env, state.identity, image[1], !!image[2], request.method === "HEAD");
    state.site = await settings(env.DB);
    if (path.startsWith("/admin")) return await admin(state, ctx, path, get);
    if (get && path === "/") return html(state, "", "home", home((await publishedCards(env.DB, state.site, "", 1, 4)).cards, state.site));
    const page = path.match(/^\/journal(?:\/page\/([1-9][0-9]{0,6}))?$/);
    if (get && page) {
      const category = url.searchParams.get("category") ?? "";
      if (category && !categories.includes(category)) throw notFound("This category does not exist.");
      const n = Number(page[1] ?? 1);
      const { cards, pageCount, used } = await publishedCards(env.DB, state.site, category, n, 9);
      if (n > pageCount) throw notFound("This journal page does not exist.");
      return html(state, "Journal", "journal", archive(cards, used, category, n, pageCount));
    }
    if (path === "/contact") return get ? await contact(state) : await sendMessage(state);
    const story = path.match(/^\/stories\/([a-z0-9-]{1,90})(\/comments)?$/);
    if (story && get && !story[2]) return await storyPage(state, story[1]);
    if (story && !get && story[2]) return await postComment(state, story[1]);
    throw notFound();
  } catch (error) {
    if (error instanceof HttpError) return errorPage(state, error);
    console.error("Silvergrain request failed", path.split("/").slice(0, 3).join("/"), error instanceof Error ? error.message : error);
    return errorPage(state, new HttpError(503, "Silvergrain is temporarily unavailable. Try again shortly."));
  }
}
