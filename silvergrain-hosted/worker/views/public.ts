import { photoPageUrl, photoUrl, storyDiscussionUrl } from "../data";
import type { Card, Comment, Photo, Settings, Story } from "../types";
import { arrow, dateLabel, emailLink, escape as e, hidden, notice, pad, pager, phoneLink, sliderControls, trap } from "./layout";

function card(entry: Card, heading: 2 | 3) {
  const image = entry.photo
    ? `<div class="card-image"><img src="${photoUrl(entry.photo, true)}" alt="${e(entry.photo.alt)}" width="720" height="480" loading="lazy"></div>` : "";
  return `<article class="story-card"><a href="/stories/${entry.slug}">
    ${image}
    <div class="card-meta">
      <span>${e(entry.category)}${entry.photo_date ? ` <span aria-hidden="true">/</span> <time datetime="${entry.photo_date}">${dateLabel(entry.photo_date)}</time>` : ""}</span>
      <span>${entry.photo_count} ${entry.photo_count === 1 ? "photo" : "photos"}</span>
    </div>
    <div class="card-title"><h${heading}>${e(entry.title)}</h${heading}><span class="diagonal" aria-hidden="true">↗</span></div>
  </a></article>`;
}

const photoCaption = (photo: Photo) => photo.caption || photo.alt || "Untitled photograph";

export function home(cards: Card[], site: Settings) {
  const masthead = `<header class="masthead">
    <h1>Silvergrain</h1>
    <p class="publication"><span class="eyebrow">Photography journal</span><span class="publication-name">${e(site.name)}</span></p>
  </header>`;
  if (!cards.length) return `<div class="shell">${masthead}<p class="empty">Stories will appear here when they’re published.</p></div>`;
  const slides = cards.map((entry, index) => {
    const title = entry.demo && entry.slug === "where-the-light-falls" ? "Where the<br><em>light falls</em>" : e(entry.title);
    const image = entry.photo ? `<figure class="hero-photo">
      <a href="${photoPageUrl(entry.slug, entry.photo.id)}#photograph" aria-label="View the photograph from ${e(entry.title)}">
        <picture>
          <source media="(max-width: 680px)" srcset="${photoUrl(entry.photo, true)}">
          <img class="hero-image" src="${photoUrl(entry.photo)}" alt="${e(entry.photo.alt)}" ${index ? 'loading="lazy"' : 'fetchpriority="high"'}>
        </picture>
      </a>
      <figcaption>${e(photoCaption(entry.photo))}</figcaption>
    </figure>` : "";
    const facts = [entry.category, entry.location, entry.demo ? "Sample story" : ""].filter(Boolean);
    return `<article class="hero-slide" data-slide${index ? " hidden" : ""}>
      ${image}
      <div class="hero-copy">
        <p class="eyebrow hero-kicker">Featured story</p>
        <h2>${title}</h2>
        <p class="eyebrow feature-facts">${facts.map(e).join(" / ")}</p>
        ${entry.caption ? `<p class="hero-caption">${e(entry.caption)}</p>` : ""}
        <a class="small-link hero-link" href="/stories/${entry.slug}">Read the story <span aria-hidden="true">→</span></a>
      </div>
    </article>`;
  }).join("");
  return `<div class="shell">
    ${masthead}
    <section class="hero" aria-label="Featured stories" data-slider>
      <div class="hero-window" data-slider-touch>${slides}</div>
      ${sliderControls(cards.length, "Story")}
    </section>
    ${cards.length > 1 ? `<section class="recent" aria-labelledby="recent-title">
      <div class="section-heading"><h2 id="recent-title">Latest stories</h2><a class="small-link" href="/journal">View journal ${arrow}</a></div>
      <div class="story-grid">${cards.slice(1).map((entry) => card(entry, 3)).join("")}</div>
    </section>` : ""}
  </div>`;
}

export function archive(cards: Card[], used: string[], category: string, page: number, pages: number) {
  const query = category ? `?category=${encodeURIComponent(category)}` : "";
  const filters = used.length ? `<nav class="filters" aria-label="Filter by category">
    <a class="filter" href="/journal"${category ? "" : ' aria-current="true"'}>All stories</a>
    ${used.map((item) => `<a class="filter" href="/journal?category=${encodeURIComponent(item)}"${item === category ? ' aria-current="true"' : ""}>${e(item)}</a>`).join("")}
  </nav>` : "";
  return `<div class="shell journal-page" data-paged>
    <section class="intro page-heading"><h1>Journal</h1>${filters}</section>
    ${cards.length ? `<div class="story-grid archive-grid" data-page-touch>${cards.map((entry) => card(entry, 2)).join("")}</div>`
      : '<p class="empty">There are no published stories here yet.</p>'}
    ${pager(page, pages, (number) => (number === 1 ? "/journal" : `/journal/page/${number}`) + query, "Journal pages", true)}
  </div>`;
}

type StoryPage = {
  post: Story; photos: Photo[]; index: number;
  adjacent: [Pick<Story, "title" | "slug"> | null, Pick<Story, "title" | "slug"> | null];
  comments: Comment[]; commentCount: number; page: number; pages: number;
  csrf: string; error?: string; sent?: boolean; form?: URLSearchParams; legacy: boolean; hasLegacy: boolean;
};

function photoNavigation(post: Story, photos: Photo[], index: number) {
  if (photos.length < 2) return "";
  const step = (offset: -1 | 1) => {
    const label = offset === -1 ? "Previous photo" : "Next photo";
    const arrow = offset === -1 ? "←" : "→";
    const target = photos[index + offset];
    return target
      ? `<a class="icon-button" href="${photoPageUrl(post.slug, target.id)}#photograph" aria-label="${label}" data-page-${offset === -1 ? "prev" : "next"}>${arrow}</a>`
      : `<span class="icon-button unavailable" aria-hidden="true">${arrow}</span>`;
  };
  return `<nav class="photo-navigation" aria-label="Photos in this story">
    ${step(-1)}
    <span class="slider-count" aria-label="Photo ${index + 1} of ${photos.length}">${pad(index + 1)} / ${pad(photos.length)}</span>
    ${step(1)}
  </nav>`;
}

function photograph(post: Story, photos: Photo[], index: number) {
  const photo = photos[index];
  const paged = photos.length > 1;
  return `<section class="photo-gallery" id="photograph" tabindex="-1" aria-label="Story photograph" data-gallery${paged ? " data-paged" : ""}>
    <figure class="photo-window">
      <button class="photo-open" type="button" data-open-photo data-page-touch data-src="${photoUrl(photo)}" aria-label="Open photo ${index + 1} full screen">
        <img src="${photoUrl(photo)}" alt="${e(photo.alt || `Photo ${index + 1} from ${post.title}`)}" width="${photo.width}" height="${photo.height}">
        <span class="expand" aria-hidden="true">⤢</span>
      </button>
      <figcaption>${e(photoCaption(photo))}</figcaption>
    </figure>
    ${photoNavigation(post, photos, index)}
    <dialog class="lightbox" aria-label="Full screen photograph">
      <button class="icon-button lightbox-close" type="button" data-close-photo aria-label="Close photo">×</button><img alt="">
    </dialog>
  </section>`;
}

function discussion(input: StoryPage, photo: Photo | undefined) {
  const { post, comments, commentCount, page, pages, csrf, form, legacy } = input;
  if (post.published_at === null || (!photo && !legacy)) return "";
  const path = photo ? photoPageUrl(post.slug, photo.id) : `/stories/${post.slug}`;
  const olderThread = storyDiscussionUrl(post.slug);
  const link = legacy ? path : input.hasLegacy ? olderThread : "";
  return `<section class="comments" id="comments" tabindex="-1" aria-labelledby="comments-heading">
    <div class="section-heading">
      <h2 id="comments-heading">${legacy ? "Story discussion" : "Photo comments"}</h2>
      <span class="comment-count" aria-label="${commentCount} ${commentCount === 1 ? "comment" : "comments"}">${commentCount}</span>
    </div>
    ${comments.length ? comments.map((item) => `<article class="comment">
      <div class="entry-meta"><strong>${e(item.name)}</strong><time>${dateLabel(item.created_at)}</time></div>
      <p>${e(item.body)}</p>
    </article>`).join("") : `<p class="muted">${legacy ? "There are no story comments." : "Be the first to comment on this photo."}</p>`}
    ${pager(page, pages, (number) => (legacy ? `${olderThread}&` : `${path}?`) + `comments=${number}#comments`, "Comment pages")}
    ${legacy ? "" : `<form class="form comment-form" action="${path}/comments#comments" method="post">
      ${hidden("csrf", csrf)}${trap}
      ${notice(input.sent ? "Thanks. Your comment is awaiting approval." : "")}${notice(input.error ?? "", true)}
      <label class="field">Name <input name="name" value="${e(form?.get("name"))}" autocomplete="name" maxlength="60" required></label>
      <label class="field">Comment <textarea name="body" rows="4" maxlength="1500" required>${e(form?.get("body"))}</textarea></label>
      <button class="button button-light" type="submit">Post comment ${arrow}</button>
    </form>`}
    ${link ? `<a class="small-link discussion-link" href="${link}#comments">${legacy ? "Back to photo comments" : "View earlier story discussion"} ${arrow}</a>` : ""}
  </section>`;
}

export function storyView(input: StoryPage) {
  const { post, photos, index, adjacent } = input;
  const photo = photos[index];
  const facts = [
    e(post.category), e(post.location),
    post.photo_date ? `<time datetime="${post.photo_date}">${dateLabel(post.photo_date)}</time>` : "",
    post.demo ? "Sample story" : "", post.published_at === null ? "Draft preview" : "",
  ].filter(Boolean);
  const newer = adjacent[0], older = adjacent[1];
  const navigation = newer || older ? `<nav class="story-nav" aria-label="Browse story pages" data-page-touch>
    ${newer ? `<a href="/stories/${newer.slug}" rel="prev" data-page-prev><span class="eyebrow">← Newer story</span><span class="neighbor-title">${e(newer.title)}</span></a>` : "<span></span>"}
    ${older ? `<a href="/stories/${older.slug}" rel="next" data-page-next><span class="eyebrow">Older story →</span><span class="neighbor-title">${e(older.title)}</span></a>` : "<span></span>"}
  </nav>` : "";

  return `<article class="shell post-page" data-paged>
    <header class="post-heading" data-page-touch>
      <a class="small-link back-link" href="/journal"><span aria-hidden="true">←</span> Journal</a>
      <p class="eyebrow story-byline">${facts.join(" / ")}</p>
      <h1>${e(post.title)}</h1>
      ${post.caption ? `<p class="lead">${e(post.caption)}</p>` : ""}
    </header>
    ${photo ? photograph(post, photos, index) : ""}
    <div class="story-details${post.story ? " has-story" : ""}">
      ${post.story ? `<div class="story-copy prose" data-page-touch>${e(post.story)}</div>` : ""}
      ${discussion(input, photo)}
    </div>
    ${navigation}
  </article>`;
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
      <form class="form" method="post" action="/contact#contact-form">
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
