import {
  categories, dashboard, deleteStory, magazineCatalogue, magazinePage, maxPhotos, pendingFor, photoKeys,
  photosFor, readStory, savePhotoOrder, saveStory, setSettings, settings, storyIdPattern,
} from "./data";
import type { EditPhoto, SavePhoto } from "./data";
import {
  challenge, field, formToken, HttpError, identify, readForm, seconds, turnstile,
  validEmail, validPhone, verifyChallenge, rateLimit, approvedMember, writerAllowed, writerArgs,
} from "./security";
import { memberMagazine, magazineBase, ownerHandle } from "./types";
import { handlePattern, memberBy, reserved } from "./accounts";
import { account, directory, management, personalProfile } from "./people";
import type { Bindings, MagazinePhoto, Settings, Story, StoryInput } from "./types";
import { media, pendingMedia, uploadPhoto } from "./uploads";
import { dashboardView, editorView, orderView, signIn } from "./views/admin";
import { html, redirect, errorPage, fallbackSite, notFound, isFormError, type State } from "./http";
import { contactView, magazineView, storyView } from "./views/public";

const pages = { stories: "Story saved.", deleted: "Story deleted.", read: "Message updated.", settings: "Contact details saved.", order: "Photo order saved." };

async function storyPage(state: State, slug: string, photoId?: string) {
  const { env, site, identity } = state;
  const result = await readStory(env.DB, site, slug, identity.admin || (!!site.owner_id && approvedMember(identity)?.id === site.owner_id));
  if (!result) throw notFound("This story is unavailable.");
  const { post, photos } = result;
  const photo = photoId ? photos.find((photo) => photo.id === photoId) : photos[0];
  if (photoId && !photo) throw notFound("This photograph is unavailable.");
  const entry: MagazinePhoto | undefined = photo ? {
    ...photo, post_id: post.id, slug, title: photo.title || post.title, story: photo.story ?? post.story,
    category: post.category, location: post.location, photo_date: post.photo_date, demo: post.demo,
  } : undefined;
  const sequence = post.published_at !== null ? (await magazineCatalogue(env.DB, site)).entries : photos.map((photo) => ({
    ...photo, post_id: post.id, slug, title: photo.title || post.title,
    category: post.category, location: post.location, photo_date: post.photo_date,
  }));
  const index = photo ? sequence.findIndex((item) => item.id === photo.id) : -1;
  const adjacent = index < 0 ? [null, null] : [sequence[index - 1] ?? null, sequence[index + 1] ?? null];
  return html(state, entry?.title || post.title, "journal", storyView(
    post, entry, adjacent as [MagazinePhoto | null, MagazinePhoto | null], magazineBase(site),
  ));
}

async function magazine(state: State, page: number, journal: boolean) {
  const category = state.url.searchParams.get("category") ?? "";
  if (category && !categories.includes(category)) throw notFound("This category does not exist.");
  const { photos, pageCount, used } = await magazinePage(state.env.DB, state.site, category, page);
  return html(state, journal ? "Journal" : state.site.handle ? state.site.name : "", journal ? "journal" : "home", magazineView({
    photos, site: state.site, page, pageCount, categories: used, category, journal,
  }));
}

async function photoOrderPage(state: State, issue?: HttpError) {
  const { entries, order } = await magazineCatalogue(state.env.DB, state.site);
  const csrf = await formToken(state.request, state.env, state.identity);
  const message = state.url.searchParams.get("saved") === "order" ? "Photo order saved." : "";
  return html(state, "Photo order", "admin", orderView(entries, order.revision, csrf.token, message, issue?.message, state.desk, magazineBase(state.site), state.orderAction),
    { cookie: csrf.cookie, status: issue?.status });
}

async function changePhotoOrder(state: State) {
  const form = await readForm(state.request, state.env, state.identity, 2 * 1024 * 1024);
  try {
    await savePhotoOrder(state.env.DB, state.site, form, state.identity);
  } catch (issue) {
    if (isFormError(issue) || (issue instanceof HttpError && issue.status === 409)) return photoOrderPage(state, issue);
    throw issue;
  }
  const path = state.orderAction || state.desk + "/order";
  return redirect(path + (path.includes("?") ? "&" : "?") + "saved=order");
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
      const target = state.site.owner_id ?? null;
      const written = await env.DB.prepare("INSERT INTO messages (name,email,body,created_at,owner_id) SELECT ?,?,?,?,? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM contributors WHERE id=? AND status='approved')")
        .bind(name, email, body, seconds(), target, target, target).run();
      if (!written.meta.changes) throw notFound();
    } catch (error) {
      if (isFormError(error)) return contact(state, error, form);
      throw error;
    }
  }
  return redirect(magazineBase(state.site) + "/contact?message=sent#contact-form");
}

async function showDashboard(state: State, section: string, error?: HttpError, site = state.site) {
  const viewParam = state.url.searchParams.get("view") ?? "";
  const view = ["published", "draft"].includes(viewParam) ? viewParam : "all";
  const noticeKey = state.url.searchParams.get("saved") ?? "";
  const message = Object.hasOwn(pages, noticeKey) ? pages[noticeKey as keyof typeof pages] : "";
  const csrf = await formToken(state.request, state.env, state.identity);
  const number = state.url.searchParams.get("page") || "1";
  if (!/^[1-9][0-9]{0,6}$/.test(number)) throw notFound();
  const data = await dashboard(state.env.DB, section, view, site, state.identity.admin && !site.owner_id, Number(number));
  return html(state, "Dashboard", "admin", dashboardView(data, section, view, site, csrf.token, message, error?.message, state.desk),
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
      typeof photo.alt !== "string" || photo.alt.length > 200 || typeof photo.caption !== "string" || photo.caption.length > 300 ||
      (photo.title != null && (typeof photo.title !== "string" || photo.title.length > 100)) ||
      (photo.story != null && (typeof photo.story !== "string" || photo.story.length > 12000))) {
      throw new HttpError(400, "Use up to 200 characters for alt text and 300 for photo captions.");
    }
    return {
      id: photo.id, alt: photo.alt.trim(), caption: photo.caption.trim(),
      title: photo.title?.trim() ?? null, story: photo.story?.trim() ?? null,
    };
  });
}

async function editor(state: State, post: Story | null, id: string, error?: HttpError, form?: URLSearchParams) {
  const db = state.env.DB;
  const photos = post ? await photosFor(db, id) : [];
  let values: StoryInput = post ?? {
    title: "", caption: "", story: "", category: "Landscape", location: "", photo_date: new Date().toISOString().slice(0, 10),
  };
  let uploads: EditPhoto[] = [];
  let edits: Record<string, EditPhoto> = {};
  if (form) {
    values = Object.fromEntries(Object.entries(storyFields).map(([key, max]) => [key, (form.get(key) ?? "").slice(0, max)])) as StoryInput;
    try {
      const items = queuedPhotos(form);
      const available = await pendingFor(db, id, items.map((item) => item.id), state.identity);
      uploads = items.filter((item) => available.has(item.id));
    } catch (issue) {
      if (!isFormError(issue)) throw issue;
    }
    edits = Object.fromEntries(photos.map(({ id }) => [id, {
      id, alt: (form.get(`alt_${id}`) ?? "").slice(0, 200), caption: (form.get(`caption_${id}`) ?? "").slice(0, 300),
      title: form.has(`title_${id}`) ? (form.get(`title_${id}`) ?? "").slice(0, 100) : null,
      story: form.has(`story_${id}`) ? (form.get(`story_${id}`) ?? "").slice(0, 12000) : null,
    }]));
  }
  const csrf = await formToken(state.request, state.env, state.identity);
  return html(state, post ? "Edit story" : "New story", "admin", editorView({
    id, post, photos, values, desk: state.desk, publicBase: magazineBase(state.site), orderAction: state.orderAction, csrf: csrf.token, error: error?.message, queued: JSON.stringify(uploads), edits,
  }), { cookie: csrf.cookie, status: error?.status });
}

async function mutateStory(state: State, post: Story | null, id: string, ctx: ExecutionContext) {
  const form = await readForm(state.request, state.env, state.identity, 2 * 1024 * 1024);
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
      title: form.has(`title_${id}`) ? field(form, `title_${id}`, 100, "photo title") : undefined,
      story: form.has(`story_${id}`) ? field(form, `story_${id}`, 12000, "photo story") : undefined,
    }));
    const edits = [...existing, ...queuedPhotos(form).map((photo) => ({ ...photo, isNew: true }))];
    if (edits.length > maxPhotos || new Set(edits.map(({ id }) => id)).size !== edits.length) {
      throw new HttpError(400, "Keep up to ten different photographs in one story.");
    }
    const removed = await saveStory(state.env, postId, post, values, intent, edits, state.identity, state.site.owner_id);
    cleanObjects(state.env, ctx, removed);
  } catch (error) {
    if (isFormError(error)) return editor(state, post, postId, error, form);
    throw error;
  }
  return redirect(state.desk + "?saved=stories");
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
    cleanObjects(state.env, ctx, await deleteStory(db, id, revision, state.identity));
    return redirect(state.desk + "?saved=deleted");
  }
  if (!/^[1-9][0-9]{0,14}$/.test(id)) throw notFound();
  if (section === "inbox" && ["read","unread","delete"].includes(action ?? "")) {
    const scope = `WHERE id=? AND (?=1 OR owner_id=?) AND ${writerAllowed}`;
    const args = [Number(id), Number(state.identity.admin), state.identity.member?.id ?? null, ...writerArgs(state.identity)];
    const result = action === "delete" ? await db.prepare("DELETE FROM messages " + scope).bind(...args).run()
      : await db.prepare("UPDATE messages SET read_at=? " + scope).bind(action === "read" ? seconds() : null, ...args).run();
    if (!result.meta.changes) throw notFound("This message is unavailable.");
    return redirect(state.desk + "/inbox?saved=read");
  }
  throw new HttpError(400,"Choose a valid dashboard action.");
}

async function studio(state: State, ctx: ExecutionContext, path: string, get: boolean) {
  const { request, env, identity, desk } = state;
  const local = path.slice(desk.length) || "/";
  if (desk === "/admin" && !identity.admin) {
    if (local.startsWith("/uploads/")) throw new HttpError(403,"Owner access is required.");
    if (local === "/" || local === "/sign-in") return html(state,"Management","admin",signIn(identity.signedIn),{status: identity.signedIn ? 403 : 200});
    return redirect("/admin");
  }
  if (desk === "/studio") {
    if (identity.admin) return redirect("/admin");
    const member = approvedMember(identity);
    if (!member) {
      if (!get) throw new HttpError(403,"Publishing access is required.");
      return redirect(identity.signedIn ? "/account" : "/login");
    }
    state.site = memberMagazine(state.site, member);
    if (local === "/profile") return personalProfile(state,get);
  } else {
    if (/^\/(users|appearance|email)(?:\/|$)/.test(local)) return management(state, path, get, ctx);
    if (["/", "/order", "/stories/new"].includes(local)) {
      const target = state.url.searchParams.get("author");
      if (target) {
        const person = await memberBy(env.DB, "id", target);
        if (!person) throw notFound();
        state.site = memberMagazine(state.site, person);
        state.orderAction = "/admin/order?author=" + person.id;
      }
    }
  }
  if (get && local === "/sign-in") return redirect(desk);
  if (local === "/" && get) return showDashboard(state,"stories");
  if (local === "/inbox" && get) return showDashboard(state,"inbox");
  if (local === "/settings" && desk === "/admin") return get ? showDashboard(state,"settings") : saveDetails(state);
  if (local === "/order") return get ? photoOrderPage(state) : changePhotoOrder(state);
  const upload = local.match(/^\/uploads\/([a-f0-9-]{36})(?:\/([a-f0-9-]{36}))?$/);
  if (upload && get && upload[2]) return pendingMedia(env,upload[1],upload[2],identity);
  if (upload && !get && !upload[2]) return uploadPhoto(request,env,identity,upload[1]);
  const action = local.match(/^\/(stories|inbox)\/([a-z0-9-]+)\/action$/);
  if (action && !get) return adminAction(state,action[1],action[2],ctx);
  const id = local.match(/^\/stories\/(new|[a-f0-9-]{36})$/)?.[1];
  if (!id) throw notFound();
  if (id === "new") return get ? editor(state,null,crypto.randomUUID()) : mutateStory(state,null,id,ctx);
  if (!storyIdPattern.test(id)) throw notFound();
  const post = await env.DB.prepare("SELECT * FROM posts WHERE id=? AND (?=1 OR owner_id=?)").bind(id,Number(identity.admin),identity.member?.id ?? null).first<Story>();
  if (!post) throw notFound();
  if (identity.admin && post.owner_id) {
    const person = await memberBy(env.DB, "id", post.owner_id);
    if (!person) throw notFound();
    state.site = memberMagazine(state.site, person);
    state.orderAction = "/admin/order?author="+person.id;
  }
  return get ? editor(state,post,id) : mutateStory(state,post,id,ctx);
}

export function isJournalPath(path: string) {
  const section = path.split("/")[1];
  return path === "/" || ["admin","studio","login","join","account","photographers","journal","page","stories","contact","media",ownerHandle].includes(section)
    || (handlePattern.test(section) && !reserved.has(section));
}

export async function fetchJournal(request: Request, env: Bindings, ctx: ExecutionContext) {
  const url = new URL(request.url);
  const state: State = { request, env, url, desk: "/admin", site: fallbackSite, identity: { admin: false, signedIn: false, id: "" } };
  let path = url.pathname.replace(/\/$/, "") || "/";
  const get = request.method === "GET" || request.method === "HEAD";
  try {
    if (!get && request.method !== "POST") throw new HttpError(405, "This request method is unavailable.");
    state.identity = await identify(request, env);
    const image = path.match(/^\/media\/([a-f0-9-]{36})(\/small)?$/);
    if (get && image && storyIdPattern.test(image[1])) return await media(env, state.identity, image[1], !!image[2], request.method === "HEAD");
    state.site = await settings(env.DB);
    if (/^\/(admin|studio)(?:\/|$)/.test(path)) {
      state.desk = path.split("/")[1] === "admin" ? "/admin" : "/studio";
      return await studio(state,ctx,path,get);
    }
    if (["/join","/account","/login"].includes(path)) return await account(state,path,get);
    if (get && path === "/photographers") return await directory(state);
    const handle = path.split("/")[1];
    if (handle === ownerHandle) {
      state.site = {...state.site,handle};
      path = path.slice(handle.length+1) || "/";
    } else if (handlePattern.test(handle) && !reserved.has(handle)) {
      const person = await memberBy(env.DB, "handle", handle);
      if (!person || (person.status !== "approved" && !state.identity.admin)) throw notFound("This magazine is unavailable.");
      state.site = memberMagazine(state.site, person);
      path = path.slice(handle.length+1) || "/";
    }
    if (get && path === "/") return await magazine(state, 1, false);
    const page = path.match(/^(?:\/journal(?:\/page\/([1-9][0-9]{0,6}))?|\/page\/([1-9][0-9]{0,6}))$/);
    if (get && page) return await magazine(state, Number(page[1] ?? page[2] ?? 1), path.startsWith("/journal"));
    if (path === "/contact") return get ? await contact(state) : await sendMessage(state);
    const story = path.match(/^\/stories\/([a-z0-9-]{1,90})(?:\/photos\/([a-z0-9-]{1,64}))?$/);
    if (story && get) return await storyPage(state, story[1], story[2]);
    throw notFound();
  } catch (error) {
    if (error instanceof HttpError) return errorPage(state, error);
    console.error("Silvergrain request failed", error instanceof Error ? error.name : "unknown");
    return errorPage(state, new HttpError(503, "Silvergrain is temporarily unavailable. Try again shortly."));
  }
}
