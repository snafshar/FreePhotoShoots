import { samples, sampleBySlug } from "./demo";
import { HttpError, seconds } from "./security";
import type { Bindings, Card, Comment, Photo, Settings, Story, StoryInput } from "./types";

export const categories = ["Landscape", "Architecture", "Street", "Portrait", "Seascape", "Other"];
export const maxPhotos = 10;
export const maxPhotoBytes = 6 * 1024 * 1024;
export const maxPhotoSide = 1920;
const pendingHours = 24 * 60 * 60;
const SAMPLE_ID_PREFIX = "sample-";
export const storyIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const coverSQL = `SELECT p.*, f.id AS photo_id, f.alt, f.caption AS photo_caption, f.width, f.height,
    (SELECT count(*) FROM photos WHERE post_id = p.id) AS photo_count
  FROM posts AS p LEFT JOIN photos AS f ON f.id =
    (SELECT id FROM photos WHERE post_id = p.id ORDER BY position, id LIMIT 1)`;

type CardRow = Story & {
  photo_id: string | null; alt: string; photo_caption: string; width: number; height: number; photo_count: number;
};
type Pending = Photo & { post_id: string; expires: number };
export type EditPhoto = { id: string; alt: string; caption: string };
export type SavePhoto = EditPhoto & { isNew: boolean };

function card(row: CardRow): Card {
  const { photo_id, alt, photo_caption, width, height, ...rest } = row;
  return { ...rest, photo: photo_id ? { id: photo_id, alt, caption: photo_caption, width, height } : undefined };
}

export function photoUrl(photo: Photo, small = false) {
  return (small ? photo.small : photo.full) ?? `/media/${photo.id}${small ? "/small" : ""}`;
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

export async function publishedCards(db: D1Database, site: Settings, category: string, page: number, pageSize: number) {
  const visibleSamples = site.hide_samples === "1" ? [] : samples.filter((entry) => !category || entry.category === category);
  const offset = (page - 1) * pageSize;
  const [counts, entries, used] = await db.batch([
    db.prepare("SELECT count(*) AS total FROM posts WHERE published_at IS NOT NULL AND (? = '' OR category = ?)").bind(category, category),
    db.prepare(`${coverSQL} WHERE p.published_at IS NOT NULL AND (? = '' OR p.category = ?)
      ORDER BY p.published_at DESC, p.id DESC LIMIT ? OFFSET ?`).bind(category, category, pageSize, offset),
    db.prepare("SELECT DISTINCT category FROM posts WHERE published_at IS NOT NULL"),
  ]);
  const count = Number((counts.results[0] as { total: number }).total);
  const cards = (entries.results as CardRow[]).map(card);
  const sampleOffset = Math.max(offset - count, 0);
  cards.push(...visibleSamples.slice(sampleOffset, sampleOffset + pageSize - cards.length));
  const set = new Set((used.results as { category: string }[]).map((row) => row.category));
  if (site.hide_samples !== "1") samples.forEach((sample) => set.add(sample.category));
  return { cards, pageCount: Math.max(1, Math.ceil((count + visibleSamples.length) / pageSize)), used: categories.filter((item) => set.has(item)) };
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

type Neighbor = Pick<Story, "slug" | "title">;
export async function neighbors(db: D1Database, post: Story, site: Settings): Promise<[Neighbor | null, Neighbor | null]> {
  const visibleSamples = site.hide_samples === "1" ? [] : samples;
  if (post.published_at === null) return [null, null];
  if (post.demo) {
    const index = visibleSamples.findIndex((sample) => sample.id === post.id);
    const newer = index > 0 ? visibleSamples[index - 1] : await db.prepare(
      "SELECT slug, title FROM posts WHERE published_at IS NOT NULL ORDER BY published_at, id LIMIT 1",
    ).first<Neighbor>();
    return [newer, visibleSamples[index + 1] ?? null];
  }
  const [newer, older] = await db.batch<Neighbor>([
    db.prepare(`SELECT slug, title FROM posts WHERE published_at IS NOT NULL AND (published_at, id) > (?, ?)
      ORDER BY published_at, id LIMIT 1`).bind(post.published_at, post.id),
    db.prepare(`SELECT slug, title FROM posts WHERE published_at IS NOT NULL AND (published_at, id) < (?, ?)
      ORDER BY published_at DESC, id DESC LIMIT 1`).bind(post.published_at, post.id),
  ]);
  return [newer.results[0] ?? null, older.results[0] ?? visibleSamples[0] ?? null];
}

export async function approvedComments(db: D1Database, id: string, page: number) {
  const pageSize = 25;
  const [count, comments] = await db.batch([
    db.prepare("SELECT count(*) AS total FROM comments WHERE post_id = ? AND status = 'approved'").bind(id),
    db.prepare(`SELECT * FROM comments WHERE post_id = ? AND status = 'approved'
      ORDER BY id DESC LIMIT ? OFFSET ?`).bind(id, pageSize, (page - 1) * pageSize),
  ]);
  const total = Number((count.results[0] as { total: number }).total);
  return { total, comments: comments.results as Comment[], pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function addComment(db: D1Database, post: Story, name: string, body: string) {
  const now = seconds();
  const query = post.demo
    ? db.prepare(`INSERT INTO comments (post_id, name, body, created_at) SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'hide_samples' AND value = '1')`)
    : db.prepare(`INSERT INTO comments (post_id, name, body, created_at) SELECT id, ?, ?, ?
        FROM posts WHERE id = ? AND published_at IS NOT NULL`);
  const result = await (post.demo ? query.bind(post.id, name, body, now) : query.bind(name, body, now, post.id)).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "This story is unavailable.");
}

export async function dashboard(db: D1Database, section: string, view: string, site: Settings) {
  const queries = [
    db.prepare(`SELECT 'published' AS kind, count(*) AS total FROM posts WHERE published_at IS NOT NULL
      UNION ALL SELECT 'draft', count(*) FROM posts WHERE published_at IS NULL
      UNION ALL SELECT 'pending', count(*) FROM comments WHERE status = 'pending'
      UNION ALL SELECT 'unread', count(*) FROM messages WHERE read_at IS NULL`),
  ];
  if (section === "stories") {
    const condition = view === "published" ? "WHERE p.published_at IS NOT NULL" : view === "draft" ? "WHERE p.published_at IS NULL" : "";
    queries.push(db.prepare(`${coverSQL} ${condition} ORDER BY p.updated_at DESC, p.id DESC`));
  } else if (section === "comments") {
    queries.push(db.prepare(`SELECT c.*, p.slug, p.title FROM comments AS c LEFT JOIN posts AS p ON p.id = c.post_id
      ORDER BY (c.status = 'pending') DESC, c.id DESC`));
  } else if (section === "inbox") {
    queries.push(db.prepare("SELECT * FROM messages ORDER BY id DESC"));
  }
  const [counts, results] = await db.batch(queries);
  const stats = Object.fromEntries((counts.results as { kind: string; total: number }[]).map((row) => [row.kind, row.total]));
  const shownSamples = site.hide_samples === "1" ? [] : samples;
  return {
    stats: { published: stats.published + shownSamples.length, draft: stats.draft, pending: stats.pending, unread: stats.unread },
    cards: section === "stories" ? [
      ...(results.results as CardRow[]).map(card), ...(view === "draft" ? [] : shownSamples),
    ] : [],
    comments: section === "comments" ? (results.results as (Comment & { slug: string | null; title: string | null })[]).map((item) => {
      const sample = sampleBySlug.get(item.post_id.replace(SAMPLE_ID_PREFIX, ""));
      return { ...item, slug: item.slug ?? sample?.slug ?? "", title: item.title ?? sample?.title ?? "Sample story" };
    }) : [],
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
  const oldIds = new Set(originals.map((photo) => photo.id));
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
  const statements = [
    start,
    ...removed.map((photoId) => db.prepare(`DELETE FROM photos WHERE id = ? AND post_id = ? AND ${scope}`).bind(photoId, id, id, key)),
    ...edits.map((photo, position) => {
      if (!photo.isNew) return db.prepare(`UPDATE photos SET position=?, alt=?, caption=? WHERE id=? AND post_id=? AND ${scope}`)
        .bind(position, photo.alt, photo.caption, photo.id, id, id, key);
      const upload = pending.get(photo.id)!;
      return db.prepare(`INSERT INTO photos (id, post_id, position, alt, caption, width, height)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${scope}`).bind(photo.id, id, position, photo.alt, photo.caption, upload.width, upload.height, id, key);
    }),
    ...newIds.map((photoId) => db.prepare(`DELETE FROM uploads WHERE id = ? AND ${scope}`).bind(photoId, id, key)),
  ];
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
