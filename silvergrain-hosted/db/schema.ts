import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey().notNull(),
  value: text("value").notNull(),
});

export const posts = sqliteTable("posts", {
  id: text("id").primaryKey().notNull(),
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
  index("posts_published").on(post.publishedAt, post.id),
  index("posts_category").on(post.category, post.publishedAt, post.id),
]);

export const photos = sqliteTable("photos", {
  id: text("id").primaryKey().notNull(),
  postId: text("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  alt: text("alt").notNull(),
  caption: text("caption").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
}, (photo) => [index("photos_post").on(photo.postId, photo.position, photo.id)]);

export const uploads = sqliteTable("uploads", {
  id: text("id").primaryKey().notNull(),
  postId: text("post_id").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  expires: integer("expires").notNull(),
}, (upload) => [index("uploads_expiration").on(upload.expires)]);

export const comments = sqliteTable("comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: text("post_id").notNull(),
  name: text("name").notNull(),
  body: text("body").notNull(),
  status: text("status", { enum: ["pending", "approved"] }).notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
}, (comment) => [index("comments_post").on(comment.postId, comment.status, comment.id)]);

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
  readAt: integer("read_at"),
});

export const limits = sqliteTable("rate_limits", {
  key: text("key").notNull(),
  window: integer("window").notNull(),
  count: integer("count").notNull(),
}, (limit) => [uniqueIndex("rate_limits_key_window").on(limit.key, limit.window)]);

export const captchaAttempts = sqliteTable("captcha_attempts", {
  id: text("id").primaryKey().notNull(),
  expires: integer("expires").notNull(),
});
