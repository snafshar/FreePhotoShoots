import { categories, maxPhotos, photoPageUrl, photoUrl } from "../data";
import type { dashboard, EditPhoto } from "../data";
import type { MagazinePhoto, Photo, Settings, Story, StoryInput } from "../types";
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
  ["stories", "/admin", "Stories"], ["order", "/admin/order", "Photo order"],
  ["inbox", "/admin/inbox", "Inbox"], ["settings", "/admin/settings", "Settings"],
];

function studioNavigation(section: string, unread = 0) {
  return sections.map(([key, url, label]) => `<a href="${url}"${key === section ? ' aria-current="page"' : ""}>${label}${key === "inbox" && unread ? ` <span>${unread}</span>` : ""}</a>`).join("");
}

export function dashboardView(
  state: Awaited<ReturnType<typeof dashboard>>, section: string, view: string, site: Settings,
  csrf: string, message: string, error = "",
) {
  const { stats, cards, messages } = state;
  const nav = studioNavigation(section, stats.unread);
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

export function orderView(photos: MagazinePhoto[], revision: string, csrf: string, message: string, error = "") {
  return `<div class="shell studio">
    <header class="studio-heading">
      <div><p class="eyebrow">Silvergrain Studio</p><h1>Photo order</h1></div>
      <a class="button" href="/">View magazine ${arrow}</a>
    </header>
    <nav class="studio-nav" aria-label="Dashboard">${studioNavigation("order")}</nav>
    ${notice(message)}${notice(error, true)}
    ${photos.length ? `<form class="form order-form" method="post" action="/admin/order" data-publication-order>
      ${hidden("csrf", csrf)}${hidden("order_revision", revision)}
      <p class="muted order-instructions">Set the reading order. Every magazine page shows 10 photos.</p>
      <ol class="publication-order-list" data-publication-list>
        ${photos.map((photo, index) => `<li class="publication-order-row" data-publication-photo>
          ${hidden("publication_photo", photo.id)}
          <img src="${photoUrl(photo, true)}" alt="" width="96" height="64" loading="lazy">
          <div class="order-photo-title">
            <a href="${photoPageUrl(photo.slug, photo.id)}">${e(photo.title)}</a>
            <p class="muted">${e(photo.location || photo.category)}${photo.demo ? " / Sample" : ""}</p>
          </div>
          <label class="field order-position">Position
            <input type="number" name="position_${photo.id}" value="${index + 1}" min="1" max="${photos.length}" step="1" required>
          </label>
          <div class="reorder">
            <button class="icon-button" type="button" data-publication-move="-1" aria-label="Move ${e(photo.title)} earlier">↑</button>
            <button class="icon-button" type="button" data-publication-move="1" aria-label="Move ${e(photo.title)} later">↓</button>
          </div>
        </li>`).join("")}
      </ol>
      <button class="button button-light" type="submit">Save photo order</button>
    </form>` : '<p class="empty">Published photos will appear here.</p>'}
  </div>`;
}

type Editor = {
  id: string; post: Story | null; photos: Photo[]; values: StoryInput; csrf: string;
  error?: string; queued?: string; edits?: Record<string, EditPhoto>;
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
          ${hidden("caption", values.caption)}${hidden("story", values.story)}
          <div class="field-row">
            <label class="field">Category <select name="category">${categories.map((name) => `<option${name === values.category ? " selected" : ""}>${name}</option>`).join("")}</select></label>
            <label class="field">Photo date <input type="date" name="photo_date" value="${e(values.photo_date)}"></label>
          </div>
          <label class="field">Location <input name="location" value="${e(values.location)}" maxlength="100"></label>
        </section>
        <section class="editor-panel editor-photos" aria-labelledby="photos-heading">
          <h2 id="photos-heading">Photographs</h2>
          <p class="muted">Add up to ${maxPhotos} photos, each with its own story. Set the magazine sequence in <a href="/admin/order">Photo order</a>.</p>
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
              <label class="field">Photo title <input name="title_${photo.id}" value="${e(edits?.[photo.id]?.title ?? photo.title ?? values.title)}" maxlength="100"></label>
              <label class="field">Photo caption <input name="caption_${photo.id}" value="${e(edits?.[photo.id]?.caption ?? photo.caption)}" maxlength="300"></label>
              <label class="field">Story for this photo <textarea name="story_${photo.id}" rows="6" maxlength="12000">${e(edits?.[photo.id]?.story ?? photo.story ?? values.story)}</textarea></label>
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
              <label class="field">Photo title <input maxlength="100" data-upload-title></label>
              <label class="field">Photo caption <input maxlength="300" data-upload-caption></label>
              <label class="field">Story for this photo <textarea rows="6" maxlength="12000" data-upload-story></textarea></label>
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
        <label class="check"><input type="checkbox" name="confirm" value="yes" required> Delete this story and its photos.</label>
        <button class="button" type="submit" name="action" value="delete">Delete permanently</button>
      </form>
    </details>` : ""}
  </div>`;
}
