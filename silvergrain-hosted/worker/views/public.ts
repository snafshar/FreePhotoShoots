import { photoPageUrl, photoUrl } from "../data";
import type { MagazinePhoto, Settings, Story } from "../types";
import { arrow, emailLink, escape as e, hidden, notice, pager, phoneLink, trap } from "./layout";

function photoSpread(photo: MagazinePhoto, index: number, detail = false, prefix = "") {
  const titleTag = detail ? "h1" : "h2";
  const url = prefix + photoPageUrl(photo.slug, photo.id);
  const facts = [photo.location, photo.demo ? "Sample" : ""].filter(Boolean);
  return `<article class="magazine-spread" id="photo-${photo.id}" data-magazine-photo="${photo.id}" data-page-touch>
    <section class="magazine-photograph" aria-label="${e(photo.title)}" data-gallery>
      <figure>
        <button class="magazine-photo-open" type="button" data-open-photo data-src="${photoUrl(photo)}" aria-label="View ${e(photo.title)} full screen">
          <picture>
            <source media="(max-width: 680px)" srcset="${photoUrl(photo, true)}">
            <img src="${photoUrl(photo)}" alt="${e(photo.alt)}" width="${photo.width}" height="${photo.height}"${index ? ' loading="lazy"' : ' fetchpriority="high"'}>
          </picture>
        </button>
        ${photo.caption ? `<figcaption>${e(photo.caption)}</figcaption>` : ""}
      </figure>
      <dialog class="lightbox" aria-label="Full screen photograph">
        <button class="icon-button lightbox-close" type="button" data-close-photo aria-label="Close photo">×</button><img alt="">
      </dialog>
    </section>
    <div class="magazine-text">
      ${facts.length ? `<p class="eyebrow magazine-location">${facts.map(e).join(" / ")}</p>` : ""}
      <${titleTag}>${detail ? e(photo.title) : `<a href="${url}">${e(photo.title)}</a>`}</${titleTag}>
      ${photo.story ? `<div class="magazine-story prose">${e(photo.story)}</div>` : ""}
    </div>
  </article>`;
}

type Magazine = {
  photos: MagazinePhoto[]; site: Settings; page: number; pageCount: number;
  categories: string[]; category: string; journal: boolean;
};

export function magazineView(input: Magazine) {
  const { photos, site, page, pageCount, categories, category, journal } = input;
  const prefix = site.handle ? "/" + site.handle : "";
  const base = journal ? prefix + "/journal" : prefix || "/";
  const query = category ? `?category=${encodeURIComponent(category)}` : "";
  const path = (number: number) => (number === 1 ? base : journal ? `${prefix}/journal/page/${number}` : `${prefix}/page/${number}`) + query;
  return `<div class="shell magazine-page" data-paged>
    <header class="magazine-heading">
      <div><h1>${journal ? "Journal" : e(site.handle ? site.name : site.magazine_title || "Silvergrain")}</h1>
        ${site.handle && !journal ? `<p>@${e(site.handle)}${site.location ? " · " + e(site.location) : ""}</p>${site.bio ? `<div class="profile-bio prose">${e(site.bio)}</div>` : ""}` : `<p>Photography by ${e(site.name)}</p>`}</div>
      ${journal && categories.length > 1 ? `<nav class="filters" aria-label="Filter by category">
        <a class="filter" href="${prefix}/journal"${category ? "" : ' aria-current="true"'}>All</a>
        ${categories.map((item) => `<a class="filter" href="${prefix}/journal?category=${encodeURIComponent(item)}"${item === category ? ' aria-current="true"' : ""}>${e(item)}</a>`).join("")}
      </nav>` : ""}
    </header>
    ${photos.length ? photos.map((photo, index) => photoSpread(photo, index, false, prefix)).join("")
      : '<p class="empty">Published photographs will appear here.</p>'}
    ${pager(page, pageCount, path, "Magazine pages", true)}
  </div>`;
}

export function storyView(post: Story, photo: MagazinePhoto | undefined, adjacent: [MagazinePhoto | null, MagazinePhoto | null], prefix = "") {
  const [previous, next] = adjacent;
  return `<div class="shell magazine-detail" data-paged>
    <div class="detail-top">
      <a class="small-link" href="${prefix || "/"}">← Magazine</a>
      ${post.published_at === null ? '<span class="eyebrow">Draft preview</span>' : ""}
    </div>
    ${photo ? photoSpread(photo, 0, true, prefix) : `<h1 class="draft-heading">${e(post.title)}</h1>`}
    ${previous || next ? `<nav class="story-nav" aria-label="Browse photographs" data-page-touch>
      ${previous ? `<a href="${prefix}${photoPageUrl(previous.slug, previous.id)}" data-page-prev><span class="eyebrow">← Previous</span><span class="neighbor-title">${e(previous.title)}</span></a>` : "<span></span>"}
      ${next ? `<a href="${prefix}${photoPageUrl(next.slug, next.id)}" data-page-next><span class="eyebrow">Next →</span><span class="neighbor-title">${e(next.title)}</span></a>` : "<span></span>"}
    </nav>` : ""}
  </div>`;
}

type ContactForm = { csrf: string; key: string; challenge?: { label: string; token: string }; sent?: boolean; error?: string; form?: URLSearchParams };
export function contactView(site: Settings, input: ContactForm) {
  const { csrf, key, challenge, form } = input;
  const details = site.email || site.phone ? `<address class="contact-details">
    ${site.email ? `<div><span class="eyebrow">Email</span><a href="${emailLink(site.email)}">${e(site.email)} ${arrow}</a></div>` : ""}
    ${site.phone ? `<div><span class="eyebrow">Phone</span><a href="${phoneLink(site.phone)}">${e(site.phone)} ${arrow}</a></div>` : ""}
  </address>` : "";
  const verification = key
    ? `<div class="cf-turnstile" data-sitekey="${e(key)}" data-theme="light" data-action="contact" data-size="flexible"></div>`
    : `<div class="contact-challenge">
      ${hidden("challenge", challenge!.token)}
      <label class="field"><span>Verification · ${e(challenge!.label)}</span><input name="answer" inputmode="numeric" autocomplete="off" maxlength="3" required></label>
    </div>`;
  return `<div class="shell contact-page">
    <section class="intro"><h1>Contact me</h1>${details}</section>
    <section class="contact-card" id="contact-form" aria-labelledby="message-heading">
      <h2 id="message-heading">Send a message</h2>
      ${site.owner_id ? `<p class="muted">Your message goes to ${e(site.name)} and is visible to the site editor.</p>` : ""}
      <form class="form" method="post" action="${site.handle ? "/" + site.handle : ""}/contact#contact-form">
        ${hidden("csrf", csrf)}${trap}
        ${notice(input.sent ? "Your message was sent." : "")}${notice(input.error ?? "", true)}
        <div class="field-row">
          <label class="field">Name <input name="name" value="${e(form?.get("name"))}" autocomplete="name" maxlength="60" required></label>
          <label class="field">Email <input name="email" type="email" value="${e(form?.get("email"))}" autocomplete="email" maxlength="254" required></label>
        </div>
        <label class="field">Message <textarea name="body" rows="5" maxlength="3000" required>${e(form?.get("body"))}</textarea></label>
        ${verification}
        <button class="button button-light" type="submit">Send message ${arrow}</button>
      </form>
    </section>
  </div>`;
}
