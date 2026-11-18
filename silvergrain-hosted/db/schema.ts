import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey().notNull(),
  value: text("value").notNull(),
});

export const contributors = sqliteTable("contributors", {
  id: text("id").primaryKey().notNull(),
  siteUserId: text("site_user_id").notNull().unique(),
  email: text("email").notNull(),
  handle: text("handle").notNull().unique(),
  name: text("name").notNull(),
  bio: text("bio").notNull().default(""),
  location: text("location").notNull().default(""),
  publicEmail: text("public_email").notNull().default(""),
  publicPhone: text("public_phone").notNull().default(""),
  note: text("note").notNull().default(""),
  status: text("status", { enum: ["pending", "approved", "suspended", "declined"] }).notNull().default("pending"),
  revision: integer("revision").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (c) => [index("contributors_status").on(c.status, c.createdAt)]);

export const approvalEmails = sqliteTable("approval_emails", {
  id: text("id").primaryKey().notNull(),
  memberId: text("member_id").notNull().references(() => contributors.id, { onDelete: "cascade" }),
  recipient: text("recipient").notNull(),
  body: text("body").notNull(),
  state: text("state").notNull().default("queued"),
  sender: text("sender"),
  claim: text("claim"),
  firstAttempt: integer("first_attempt"),
  attemptedAt: integer("attempted_at"),
  createdAt: integer("created_at").notNull(),
  providerId: text("provider_id"),
}, (e) => [index("approval_email_state").on(e.state, e.createdAt)]);

export const accountEvents = sqliteTable("account_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  memberId: text("member_id").notNull().references(() => contributors.id, { onDelete: "cascade" }),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  createdAt: integer("created_at").notNull(),
}, (e) => [index("account_events_member").on(e.memberId, e.id)]);

export const posts = sqliteTable("posts", {
  id: text("id").primaryKey().notNull(),
  ownerId: text("owner_id").references(() => contributors.id),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  caption: text("caption").notNull(),
  story: text("story").notNull(),
  category: text("category").notNull(),
  location: text("location").notNull(),
  photoDate: text("photo_date").notNull(),
  publishedAt: integer("published_at"),
  updatedAt: integer("updated_at").notNull(),
  revision: integer("revision").notNull().default(1),
  writeToken: text("write_token"),
}, (post) => [
  index("posts_owner").on(post.ownerId, post.publishedAt, post.id),
  index("posts_published").on(post.publishedAt, post.id),
  index("posts_category").on(post.category, post.publishedAt, post.id),
]);

export const photos = sqliteTable("photos", {
  id: text("id").primaryKey().notNull(),
  postId: text("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  alt: text("alt").notNull(),
  caption: text("caption").notNull(),
  title: text("title"),
  story: text("story"),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
}, (photo) => [index("photos_post").on(photo.postId, photo.position, photo.id)]);

export const uploads = sqliteTable("uploads", {
  id: text("id").primaryKey().notNull(),
  postId: text("post_id").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  expires: integer("expires").notNull(),
  uploaderId: text("uploader_id"),
}, (upload) => [index("uploads_expiration").on(upload.expires), index("uploads_uploader").on(upload.uploaderId, upload.expires)]);

export const comments = sqliteTable("comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: text("post_id").notNull(),
  photoId: text("photo_id"),
  name: text("name").notNull(),
  body: text("body").notNull(),
  status: text("status", { enum: ["pending", "approved"] }).notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
}, (comment) => [
  index("comments_post").on(comment.postId, comment.status, comment.id),
  index("comments_photo").on(comment.postId, comment.photoId, comment.status, comment.id),
]);

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
  readAt: integer("read_at"),
  ownerId: text("owner_id").references(() => contributors.id),
}, (m) => [index("messages_owner").on(m.ownerId, m.id)]);

export const limits = sqliteTable("rate_limits", {
  key: text("key").notNull(),
  window: integer("window").notNull(),
  count: integer("count").notNull(),
}, (limit) => [uniqueIndex("rate_limits_key_window").on(limit.key, limit.window)]);

export const captchaAttempts = sqliteTable("captcha_attempts", {
  id: text("id").primaryKey().notNull(),
  expires: integer("expires").notNull(),
});
