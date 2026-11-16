import { categories, maxPhotos, photoPageUrl, photoUrl, storyDiscussionUrl } from "../data";
import type { dashboard } from "../data";
import type { Photo, Settings, Story, StoryInput } from "../types";
import { arrow, dateLabel, emailLink, escape as e, hidden, notice } from "./layout";

export function signIn(signedIn: boolean) {
  return `<section class="shell narrow-page">
    <p class="eyebrow">Silvergrain Studio</p><h1>${signedIn ? "Studio access" : "Sign in"}</h1>
    ${signedIn
      ? '<p class="notice">The studio is available to the account that owns Silvergrain.</p><a class="button" href="/signout-with-chatgpt?return_to=%2Fadmin" target="_top">Switch account</a>'
      : '<a class="button button-light" href="/signin-with-chatgpt?return_to=%2Fadmin" target="_top">Sign in with ChatGPT ↗</a>'}
  </section>`;
}

const sections = [
  ["stories", "/admin", "Stories"], ["comments", "/admin/comments", "Comments"],
  ["inbox", "/admin/inbox", "Inbox"], ["settings", "/admin/settings", "Settings"],
];

export function dashboardView(
  state: Awaited<ReturnType<typeof dashboard>>, section: string, view: string, site: Settings,
  csrf: string, message: string, error = "",
) {
  const { stats, cards, comments, messages } = state;
  const nav = sections.map(([key, url, label]) => {
    const count = key === "comments" ? stats.pending : key === "inbox" ? stats.unread : 0;
    return `<a href="${url}"${key === section ? ' aria-current="page"' : ""}>${label}${count ? ` <span>${count}</span>` : ""}</a>`;
  }).join("");
  const filters = [["all", "All"], ["published", `Published ${stats.published}`], ["draft", `Drafts ${stats.draft}`]];
  let content = "";
  if (section === "stories") {
    content = `<div class="dashboard-content">
      <div class="section-heading studio-section-heading"><h2>Stories</h2>
        <nav class="filters" aria-label="Filter your stories">
          ${filters.map(([filter, label]) => `<a class="filter" href="/admin${filter === "all" ? "" : `?view=${filter}`}"${filter === view ? ' aria-current="true"' : ""}>${label}</a>`).join("")}
        </nav>
      </div>
      <ul class="studio-list">
        ${cards.length ? cards.map((entry) => {
          const href = entry.demo ? `/stories/${entry.slug}` : `/admin/stories/${entry.id}`;
          const label = entry.demo ? "View" : "Edit";
          return `<li class="studio-row">
            <div class="studio-thumb">${entry.photo ? `<img src="${photoUrl(entry.photo, true)}" alt="" loading="lazy">` : ""}</div>
            <div class="studio-entry"><a href="${href}">${e(entry.title)}</a><p>${e(entry.category)} / ${entry.photo_count} ${entry.photo_count === 1 ? "photo" : "photos"}</p></div>
            <span class="entry-state${entry.published_at !== null ? " published" : ""}">${entry.demo ? "Sample" : entry.published_at !== null ? "Published" : "Draft"}</span>
            <a class="button compact" href="${href}" aria-label="${label} ${e(entry.title)}">${label} ${arrow}</a>
          </li>`;
        }).join("") : '<li class="empty">There are no stories in this view.</li>'}
      </ul>
    </div>`;
  } else if (section === "comments") {
    content = `<section class="dashboard-content">
      <div class="section-heading"><h2>Comments</h2><span class="muted">${stats.pending} pending</span></div>
      ${comments.length ? comments.map((item) => {
        const href = item.photo_id ? photoPageUrl(item.slug, item.photo_id) : storyDiscussionUrl(item.slug);
        const subject = item.position !== null ? `Photo ${item.position + 1}` : "Story discussion";
        return `<article class="inbox-item">
        <div class="entry-meta"><strong>${e(item.name)}</strong><time>${dateLabel(item.created_at)}</time></div>
        ${item.slug ? `<a class="small-link" href="${href}#comments">${e(item.title)} · ${subject} ↗</a>` : ""}
        ${item.photo_caption ? `<p class="muted moderation-caption">${e(item.photo_caption)}</p>` : ""}
        <p class="prose">${e(item.body)}</p>
        <div class="item-actions"><span class="entry-state">${e(item.status)}</span>
          <form method="post" action="/admin/comments/${item.id}/action">
            ${hidden("csrf", csrf)}
            ${item.status === "pending" ? '<button class="button compact" name="action" value="approve">Approve</button>' : '<button class="button compact" name="action" value="hide">Hide</button>'}
            <button class="button compact" name="action" value="delete">Delete</button>
          </form>
        </div>
      </article>`;
      }).join("") : '<p class="empty">Comments on your photographs will appear here.</p>'}
    </section>`;
  } else if (section === "inbox") {
    content = `<section class="dashboard-content">
      <div class="section-heading"><h2>Inbox</h2><span class="muted">${stats.unread} unread</span></div>
      ${messages.length ? messages.map((item) => `<article class="inbox-item">
        <div class="entry-meta"><strong>${e(item.name)}</strong><time>${dateLabel(item.created_at)}</time></div>
        <a class="small-link" href="${emailLink(item.email)}">${e(item.email)} ↗</a>
        <p class="prose">${e(item.body)}</p>
        <div class="item-actions"><span class="entry-state">${item.read_at ? "Read" : "Unread"}</span>
          <form method="post" action="/admin/inbox/${item.id}/action">
            ${hidden("csrf", csrf)}
            <button class="button compact" name="action" value="${item.read_at ? "unread" : "read"}">${item.read_at ? "Mark unread" : "Mark read"}</button>
            <button class="button compact" name="action" value="delete">Delete</button>
          </form>
        </div>
      </article>`).join("") : '<p class="empty">Messages from the contact page will appear here.</p>'}
    </section>`;
  } else {
    content = `<section class="dashboard-content settings-panel">
      <div class="section-heading"><h2>Public details</h2></div>
      <form class="form" method="post" action="/admin/settings">
        ${hidden("csrf", csrf)}
        <label class="field">Display name <input name="name" value="${e(site.name)}" maxlength="100" required></label>
        <label class="field">Public email <input name="email" value="${e(site.email)}" type="email" maxlength="254" autocomplete="email"></label>
        <label class="field">Public phone <input name="phone" value="${e(site.phone)}" type="tel" maxlength="30" autocomplete="tel"></label>
        <label class="check"><input type="checkbox" name="hide_samples" value="1"${site.hide_samples === "1" ? " checked" : ""}> Hide sample stories</label>
        <button class="button button-light" type="submit">Save details ${arrow}</button>
      </form>
    </section>`;
  }
  return `<div class="shell studio">
    <header class="studio-heading">
      <div><p class="eyebrow">Silvergrain Studio</p><h1>Dashboard</h1></div>
      <div class="studio-actions">
        <a class="button button-light" href="/admin/stories/new">New story <span aria-hidden="true">+</span></a>
        <a class="button" href="/signout-with-chatgpt?return_to=%2F" target="_top">Sign out</a>
      </div>
    </header>
    <nav class="studio-nav" aria-label="Dashboard">${nav}</nav>
    ${notice(message)}${notice(error, true)}${content}
  </div>`;
}

type Editor = {
  id: string; post: Story | null; photos: Photo[]; values: StoryInput; csrf: string;
  error?: string; queued?: string; edits?: Record<string, {alt: string; caption: string}>;
};

export function editorView(input: Editor) {
  const { id, post, photos, values, csrf, error, queued, edits } = input;
  const isPublished = post && post.published_at !== null;
  const save = isPublished
    ? '<button class="button button-light" type="submit" name="intent" value="save">Save changes</button><button class="button" type="submit" name="intent" value="draft">Unpublish</button>'
    : `<button class="button button-light" type="submit" name="intent" value="draft">Save draft</button><button class="button" type="submit" name="intent" value="publish">Publish story ${arrow}</button>`;
  return `<div class="shell studio editor">
    <a class="small-link back-link" href="/admin"><span aria-hidden="true">←</span> Dashboard</a>
    <div class="studio-heading editor-heading">
      <h1>${post ? "Edit story" : "New story"}</h1>
      ${post ? `<a class="button" href="/stories/${post.slug}">${isPublished ? "View story" : "Preview draft"} ${arrow}</a>` : ""}
    </div>
    ${notice(error ?? "", true)}
    <form class="form editor-form" method="post" data-hosted-editor>
      ${hidden("csrf", csrf)}${hidden("post_id", id)}${hidden("uploads", queued ?? "[]")}${post ? hidden("revision", post.revision) : ""}
      <div class="editor-grid">
        <section class="form editor-panel" aria-label="Story details">
          <label class="field">Title <input name="title" value="${e(values.title)}" maxlength="100" required></label>
          <label class="field">Story intro <textarea name="caption" rows="2" maxlength="300">${e(values.caption)}</textarea></label>
          <div class="field-row">
            <label class="field">Category <select name="category">${categories.map((name) => `<option${name === values.category ? " selected" : ""}>${name}</option>`).join("")}</select></label>
            <label class="field">Photo date <input type="date" name="photo_date" value="${e(values.photo_date)}"></label>
          </div>
          <label class="field">Location <input name="location" value="${e(values.location)}" maxlength="100"></label>
          <label class="field">Story <textarea name="story" rows="9" maxlength="12000">${e(values.story)}</textarea></label>
        </section>
        <section class="editor-panel editor-photos" aria-labelledby="photos-heading">
          <h2 id="photos-heading">Photographs</h2>
          <p class="muted">Up to ${maxPhotos} JPEG, PNG, or WebP images. The first photo becomes the cover.</p>
          <div class="existing-photos" data-photo-order>
            ${photos.map((photo) => `<div class="editor-photo" data-photo>
              ${hidden("photo_order", photo.id)}
              <div class="editor-photo-top">
                <img src="${photoUrl(photo, true)}" alt="${e(photo.alt)}" loading="lazy">
                <div class="reorder" aria-label="Reorder photo">
                  <button class="icon-button" type="button" data-move="-1" aria-label="Move photo earlier">↑</button>
                  <button class="icon-button" type="button" data-move="1" aria-label="Move photo later">↓</button>
                </div>
                <label class="check"><input type="checkbox" name="remove_photo" value="${photo.id}"> Remove</label>
              </div>
              <label class="field">Alt text <input name="alt_${photo.id}" value="${e(edits?.[photo.id]?.alt ?? photo.alt)}" maxlength="200"></label>
              <label class="field">Photo caption <input name="caption_${photo.id}" value="${e(edits?.[photo.id]?.caption ?? photo.caption)}" maxlength="300"></label>
            </div>`).join("")}
          </div>
          <label class="field upload-field">Add photographs <input type="file" accept="image/jpeg,image/png,image/webp" multiple data-hosted-upload></label>
          <p class="muted" data-upload-status role="status" aria-live="polite" hidden></p>
          <div class="uploads" data-hosted-uploads></div>
          <template data-hosted-upload-template>
            <div class="editor-photo upload-preview">
              <div class="editor-photo-top"><img alt=""><span class="upload-filename"></span>
                <div class="reorder" aria-label="Reorder new photo">
                  <button class="icon-button" type="button" data-shift="-1" aria-label="Move new photo earlier">↑</button>
                  <button class="icon-button" type="button" data-shift="1" aria-label="Move new photo later">↓</button>
                </div>
                <button class="button compact" type="button" data-remove-upload>Remove</button>
              </div>
              <label class="field">Alt text <input maxlength="200" data-upload-alt></label>
              <label class="field">Photo caption <input maxlength="300" data-upload-caption></label>
            </div>
          </template>
          <noscript><p class="muted">Enable JavaScript to add photographs.</p></noscript>
        </section>
      </div>
      <div class="editor-actions">${save}</div>
    </form>
    ${post ? `<details class="delete-story">
      <summary>Delete story</summary>
      <form class="form" method="post" action="/admin/stories/${post.id}/action">
        ${hidden("csrf", csrf)}${hidden("revision", post.revision)}
        <label class="check"><input type="checkbox" name="confirm" value="yes" required> Delete this story, its photos, and its comments.</label>
        <button class="button" type="submit" name="action" value="delete">Delete permanently</button>
      </form>
    </details>` : ""}
  </div>`;
}
