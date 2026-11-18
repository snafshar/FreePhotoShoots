import { samples, sampleBySlug } from "./demo";
import { HttpError, seconds } from "./security";
import type { Bindings, Card, MagazinePhoto, Photo, Settings, Story, StoryInput } from "./types";

export const categories = ["Landscape", "Architecture", "Street", "Portrait", "Seascape", "Other"];
export const maxPhotos = 10;
export const maxPhotoBytes = 6 * 1024 * 1024;
export const maxPhotoSide = 1920;
const pendingHours = 24 * 60 * 60;
export const storyIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const coverSQL = `SELECT p.*, f.id AS photo_id, f.alt, f.caption AS photo_caption, f.width, f.height,
    (SELECT count(*) FROM photos WHERE post_id = p.id) AS photo_count
  FROM posts AS p LEFT JOIN photos AS f ON f.id =
    (SELECT id FROM photos WHERE post_id = p.id ORDER BY position, id LIMIT 1)`;

type CardRow = Story & {
  photo_id: string | null; alt: string; photo_caption: string; width: number; height: number; photo_count: number;
};
type Pending = Photo & { post_id: string; expires: number };
export type EditPhoto = { id: string; alt: string; caption: string; title?: string | null; story?: string | null };
export type SavePhoto = EditPhoto & { isNew: boolean };

function card(row: CardRow): Card {
  const { photo_id, alt, photo_caption, width, height, ...rest } = row;
  return { ...rest, photo: photo_id ? { id: photo_id, alt, caption: photo_caption, width, height } : undefined };
}

export function photoUrl(photo: Photo, small = false) {
  return (small ? photo.small : photo.full) ?? `/media/${photo.id}${small ? "/small" : ""}`;
}

export function photoPageUrl(slug: string, photoId: string) {
  return `/stories/${encodeURIComponent(slug)}/photos/${encodeURIComponent(photoId)}`;
}

export async function settings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key IN ('name','email','phone','hide_samples')")
    .all<{ key: string; value: string }>();
  return Object.assign({ name: "Sina Afshar", email: "", phone: "", hide_samples: "0" }, Object.fromEntries(
    results.map(({ key, value }) => [key, value]),
  ));
}

export async function setSettings(db: D1Database, values: Settings) {
  await db.batch(Object.entries(values).map(([key, value]) =>
    db.prepare("INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value),
  ));
}

export const photosPerPage = 10;

type PhotoOrder = { revision: string; ids: string[] };

async function photoOrder(db: D1Database) {
  const raw = await db.prepare("SELECT value FROM settings WHERE key = 'photo_order'").first<string>("value") ?? "";
  const parsed: PhotoOrder = raw ? JSON.parse(raw) : { revision: "", ids: [] };
  return { raw, ...parsed };
}

function samplePhotos(site: Settings): MagazinePhoto[] {
  if (site.hide_samples === "1") return [];
  return samples.flatMap((post) => post.photos.map((photo) => ({
    ...photo, post_id: post.id, slug: post.slug, title: photo.title || post.title,
    story: photo.story ?? post.story, category: post.category, location: post.location,
    photo_date: post.photo_date, demo: true,
  })));
}

export async function magazineCatalogue(db: D1Database, site: Settings) {
  const [result, order] = await Promise.all([
    db.prepare(`SELECT f.id, f.post_id, f.alt, f.caption, f.width, f.height, p.slug,
        COALESCE(NULLIF(f.title, ''), p.title) AS title, p.category, p.location, p.photo_date
      FROM photos AS f JOIN posts AS p ON p.id = f.post_id
      WHERE p.published_at IS NOT NULL ORDER BY p.published_at DESC, p.id DESC, f.position, f.id`).all<MagazinePhoto>(),
    photoOrder(db),
  ]);
  const entries = [...result.results, ...samplePhotos(site)];
  const ranks = new Map(order.ids.map((id, position) => [id, position]));
  entries.sort((a, b) => (ranks.get(a.id) ?? entries.length) - (ranks.get(b.id) ?? entries.length));
  return { entries, order };
}

export async function magazinePage(db: D1Database, site: Settings, category: string, page: number) {
  const { entries } = await magazineCatalogue(db, site);
  const filtered = category ? entries.filter((entry) => entry.category === category) : entries;
  const pageCount = Math.max(1, Math.ceil(filtered.length / photosPerPage));
  if (page > pageCount) throw new HttpError(404, "This page is unavailable.");
  const photos = filtered.slice((page - 1) * photosPerPage, page * photosPerPage);
  const owned = photos.filter((photo) => !photo.demo);
  if (owned.length) {
    const texts = await db.prepare(`SELECT f.id, COALESCE(f.story, p.story) AS story
      FROM photos AS f JOIN posts AS p ON p.id = f.post_id
      WHERE p.published_at IS NOT NULL AND f.id IN (${owned.map(() => "?").join(",")})`)
      .bind(...owned.map((photo) => photo.id)).all<{ id: string; story: string }>();
    const stories = new Map(texts.results.map((item) => [item.id, item.story]));
    photos.forEach((photo) => { if (!photo.demo) photo.story = stories.get(photo.id) ?? ""; });
  }
  const used = new Set(entries.map((photo) => photo.category));
  return { photos, pageCount, used: categories.filter((category) => used.has(category)) };
}

export async function savePhotoOrder(db: D1Database, site: Settings, form: URLSearchParams) {
  const { entries, order } = await magazineCatalogue(db, site);
  if (form.get("order_revision") !== order.revision) {
    throw new HttpError(409, "The photo order changed in another tab. Reload it before saving.");
  }
  const ids = form.getAll("publication_photo");
  const available = new Set(entries.map((photo) => photo.id));
  if (ids.length !== available.size || new Set(ids).size !== available.size || ids.some((id) => !available.has(id))) {
    throw new HttpError(409, "The published photos changed. Reload the order before saving.");
  }
  const positions = ids.map((id) => Number(form.get(`position_${id}`)));
  if (positions.some((position) => !Number.isSafeInteger(position) || position < 1 || position > ids.length) ||
      new Set(positions).size !== positions.length) {
    throw new HttpError(400, `Give each photo a different position from 1 to ${ids.length}.`);
  }
  const ranked = ids.map((id, index) => ({ id, position: positions[index] })).sort((a, b) => a.position - b.position);
  const value = JSON.stringify({
    revision: crypto.randomUUID(),
    ids: [...ranked.map((photo) => photo.id), ...order.ids.filter((id) => !available.has(id))],
  });
  const saved = await db.prepare(`INSERT INTO settings (key, value) VALUES ('photo_order', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value = ?`)
    .bind(value, order.raw).run();
  if (saved.meta.changes !== 1) throw new HttpError(409, "The photo order changed in another tab. Reload it before saving.");
}

export async function photosFor(db: D1Database, id: string) {
  const { results } = await db.prepare("SELECT * FROM photos WHERE post_id = ? ORDER BY position, id").bind(id).all<Photo>();
  return results;
}

export async function readStory(db: D1Database, site: Settings, slug: string, admin: boolean) {
  const sample = site.hide_samples !== "1" ? sampleBySlug.get(slug) : undefined;
  if (sample) return { post: sample as Story, photos: sample.photos };
  const post = await db.prepare("SELECT * FROM posts WHERE slug = ? AND (published_at IS NOT NULL OR ? = 1)")
    .bind(slug, admin ? 1 : 0).first<Story>();
  if (!post) return null;
  return { post, photos: await photosFor(db, post.id) };
}

export async function dashboard(db: D1Database, section: string, view: string, site: Settings) {
  const queries = [
    db.prepare(`SELECT 'published' AS kind, count(*) AS total FROM posts WHERE published_at IS NOT NULL
      UNION ALL SELECT 'draft', count(*) FROM posts WHERE published_at IS NULL
      UNION ALL SELECT 'unread', count(*) FROM messages WHERE read_at IS NULL`),
  ];
  if (section === "stories") {
    const condition = view === "published" ? "WHERE p.published_at IS NOT NULL" : view === "draft" ? "WHERE p.published_at IS NULL" : "";
    queries.push(db.prepare(`${coverSQL} ${condition} ORDER BY p.updated_at DESC, p.id DESC`));
  } else if (section === "inbox") {
    queries.push(db.prepare("SELECT * FROM messages ORDER BY id DESC"));
  }
  const [counts, results] = await db.batch(queries);
  const stats = Object.fromEntries((counts.results as { kind: string; total: number }[]).map((row) => [row.kind, row.total]));
  const shownSamples = site.hide_samples === "1" ? [] : samples;
  return {
    stats: { published: stats.published + shownSamples.length, draft: stats.draft, unread: stats.unread },
    cards: section === "stories" ? [
      ...(results.results as CardRow[]).map(card), ...(view === "draft" ? [] : shownSamples),
    ] : [],
    messages: section === "inbox" ? results.results as import("./types").Message[] : [],
  };
}

export function photoKeys(id: string) {
  return [`photos/${id}.webp`, `photos/${id}-small.webp`] as const;
}

export async function clearExpiredUploads(env: Bindings) {
  // Never delete an object while a pending upload can still be attached.
  const now = seconds();
  const expired = await env.DB.prepare("SELECT id FROM uploads WHERE expires <= ? ORDER BY expires LIMIT 20")
    .bind(now).all<{ id: string }>();
  if (!expired.results.length) return;
  await env.BUCKET.delete(expired.results.flatMap(({ id }) => [...photoKeys(id)]));
  await env.DB.batch(expired.results.map(({ id }) => env.DB.prepare("DELETE FROM uploads WHERE id = ? AND expires <= ?").bind(id, now)));
}

export async function registerUpload(env: Bindings, postId: string, id: string, width: number, height: number) {
  await env.DB.prepare("INSERT INTO uploads (id, post_id, width, height, expires) VALUES (?, ?, ?, ?, ?)")
    .bind(id, postId, width, height, seconds() + pendingHours).run();
}

export async function pendingFor(db: D1Database, postId: string, ids: string[]) {
  if (!ids.length) return new Map<string, Pending>();
  const result = await db.prepare(`SELECT * FROM uploads WHERE post_id = ? AND expires > ?
    AND id IN (${ids.map(() => "?").join(",")})`).bind(postId, seconds(), ...ids).all<Pending>();
  return new Map(result.results.map((row) => [row.id, row]));
}

function slugFor(title: string, id: string) {
  const stem = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 74).replace(/-+$/, "");
  return `${stem || "story"}-${id.slice(0, 8)}`;
}

export async function saveStory(
  env: Bindings, id: string, existing: Story | null, values: StoryInput, intent: string, edits: SavePhoto[],
) {
  const db = env.DB;
  const now = seconds();
  const originals = existing ? await photosFor(db, id) : [];
  const oldPhotos = new Map(originals.map((photo) => [photo.id, photo]));
  const oldIds = new Set(oldPhotos.keys());
  const retained = new Set(edits.filter((edit) => !edit.isNew).map((photo) => photo.id));
  if ([...retained].some((photoId) => !oldIds.has(photoId))) throw new HttpError(409, "Reload the editor to see the current photos.");
  const newIds = edits.filter((edit) => edit.isNew).map((photo) => photo.id);
  const pending = await pendingFor(db, id, newIds);
  if (pending.size !== newIds.length) throw new HttpError(409, "Select any expired or missing uploads again.");
  let published = existing?.published_at ?? null;
  if (intent === "draft") published = null;
  if (intent === "publish") published ??= now;
  if (published !== null && !edits.length) throw new HttpError(400, "Add at least one photo before publishing.");

  const key = crypto.randomUUID();
  const fields = [values.title, values.caption, values.story, values.category, values.location, values.photo_date, published, now];
  // Recheck pending rows in the transaction. Each metadata mutation is scoped to
  // the request that actually won the revision check.
  const validPending = newIds.length ? ` AND (SELECT count(*) FROM uploads WHERE post_id = ? AND expires > ?
    AND id IN (${newIds.map(() => "?").join(",")})) = ?` : "";
  const pendingArgs = newIds.length ? [id, now, ...newIds, newIds.length] : [];
  const start = existing
    ? db.prepare(`UPDATE posts SET title=?, caption=?, story=?, category=?, location=?, photo_date=?, published_at=?,
        updated_at=?, write_token=?, revision=revision+1 WHERE id=? AND revision=?${validPending}`)
      .bind(...fields, key, id, existing.revision, ...pendingArgs)
    : db.prepare(`INSERT INTO posts (id, slug, title, caption, story, category, location, photo_date, published_at, updated_at, write_token)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE 1=1${validPending} ON CONFLICT(id) DO NOTHING`)
      .bind(id, slugFor(values.title, id), ...fields, key, ...pendingArgs);
  const scope = "EXISTS (SELECT 1 FROM posts WHERE id = ? AND write_token = ?)";
  const removed = originals.filter((photo) => !retained.has(photo.id)).map((photo) => photo.id);
  const statements = [start];
  if (removed.length) {
    statements.push(db.prepare(`DELETE FROM comments WHERE post_id = ? AND photo_id IN
      (${removed.map(() => "?").join(",")}) AND ${scope}`).bind(id, ...removed, id, key));
  }
  statements.push(
    ...removed.map((photoId) => db.prepare(`DELETE FROM photos WHERE id = ? AND post_id = ? AND ${scope}`).bind(photoId, id, id, key)),
    ...edits.map((photo, position) => {
      if (!photo.isNew) {
        const previous = oldPhotos.get(photo.id)!;
        const title = photo.title === undefined ? previous.title : photo.title;
        const story = photo.story === undefined ? previous.story : photo.story;
        return db.prepare(`UPDATE photos SET position=?, alt=?, caption=?, title=?, story=? WHERE id=? AND post_id=? AND ${scope}`)
          .bind(position, photo.alt, photo.caption, title ?? null, story ?? null, photo.id, id, id, key);
      }
      const upload = pending.get(photo.id)!;
      return db.prepare(`INSERT INTO photos (id, post_id, position, alt, caption, title, story, width, height)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${scope}`).bind(photo.id, id, position, photo.alt, photo.caption,
          photo.title ?? null, photo.story ?? null, upload.width, upload.height, id, key);
    }),
    ...newIds.map((photoId) => db.prepare(`DELETE FROM uploads WHERE id = ? AND ${scope}`).bind(photoId, id, key)),
  );
  const [result] = await db.batch(statements);
  if (result.meta.changes !== 1) throw new HttpError(409, "This story changed or an upload expired. Reload before saving.");
  return removed;
}

export async function deleteStory(db: D1Database, id: string, revision: number) {
  const originals = await photosFor(db, id);
  const [, deleted] = await db.batch([
    db.prepare(`DELETE FROM comments WHERE post_id = ? AND EXISTS
      (SELECT 1 FROM posts WHERE id = ? AND revision = ?)`).bind(id, id, revision),
    db.prepare("DELETE FROM posts WHERE id = ? AND revision = ?").bind(id, revision),
  ]);
  if (!deleted.meta.changes) throw new HttpError(409, "This story changed before it could be deleted.");
  return originals.map((photo) => photo.id);
}
