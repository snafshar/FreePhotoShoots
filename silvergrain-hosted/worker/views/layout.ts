import { tel } from "../security";
import type { Settings } from "../types";

const entities: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
export const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => entities[char]);
export const pad = (n: number) => String(n).padStart(2, "0");
const dateFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
export const dateLabel = (value: string | number) => dateFormat.format(new Date(typeof value === "number" ? value * 1000 : value));
export const emailLink = (value: string) => "mailto:" + encodeURIComponent(value).replace("%40", "@");
export const phoneLink = (value: string) => "tel:" + tel(value);
export const hidden = (name: string, value: unknown) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
export const trap = '<div class="trap" aria-hidden="true" inert><label>Leave this empty <input name="company" type="text" tabindex="-1" autocomplete="off"></label></div>';
export const notice = (message: string, error = false) => message
  ? `<p class="notice" role="${error ? "alert" : "status"}">${escape(message)}</p>` : "";

type Active = "home" | "journal" | "contact" | "admin" | "";
const links = [["home", "/", "Home"], ["journal", "/journal", "Journal"], ["contact", "/contact", "Contact"]];
export const arrow = '<span aria-hidden="true">↗</span>';
const brand = '<a class="brand" href="/" aria-label="Silvergrain home"><span class="brand-mark" aria-hidden="true"></span><span class="brand-word">Silvergrain</span></a>';

export function layout(site: Settings, title: string, active: Active, admin: boolean, content: string, head = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Silvergrain, a black-and-white photography magazine by ${escape(site.name)}.">
  <meta name="theme-color" content="#ffffff">
  <title>${title ? escape(title) + " · " : ""}Silvergrain</title>
  <link rel="icon" href="/static/favicon.png" type="image/png">
  <link rel="preload" href="/static/fonts/InstrumentSerif-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/static/style.css">
  <script src="/static/journal.js" defer></script>
  ${head}
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header${active === "home" ? " cover-header" : ""}">
    <div class="shell header-inner">
      ${brand}
      <nav class="site-nav" aria-label="Main navigation">
        ${links.map(([key, href, label]) => `<a href="${href}"${key === active ? ' aria-current="page"' : ""}>${label}</a>`).join("")}
      </nav>
      <a class="admin-link" href="/admin"${active === "admin" ? ' aria-current="page"' : ""}><span class="lock-icon" aria-hidden="true"></span>${admin ? "Studio" : "Admin"}</a>
    </div>
  </header>
  <main id="main">${content}</main>
  <footer class="site-footer">
    <div class="shell footer-inner">
      ${brand}<p>© ${new Date().getUTCFullYear()} ${escape(site.name)}</p>
      <a class="small-link" href="/contact">Contact ${arrow}</a>
    </div>
  </footer>
</body>
</html>`;
}

export function sliderControls(count: number, item: "Story" | "Photo") {
  if (count < 2) return "";
  const dots = Array.from({ length: count }, (_, i) =>
    `<button class="slider-dot" type="button" data-goto="${i}" aria-label="${item} ${i + 1}"${i === 0 ? ' aria-current="true"' : ""}></button>`,
  );
  return `<div class="slider-controls" data-controls hidden>
    <div class="slider-dots" aria-label="${item}">${dots.join("")}</div>
    <div class="slider-step">
      <button type="button" class="icon-button" data-prev aria-label="Previous ${item.toLowerCase()}"><span aria-hidden="true">←</span></button>
      <span class="slider-count" aria-live="polite"><span data-count>01</span> <span aria-hidden="true">/</span> ${pad(count)}</span>
      <button type="button" class="icon-button" data-next aria-label="Next ${item.toLowerCase()}"><span aria-hidden="true">→</span></button>
    </div>
  </div>`;
}

export function pager(
  page: number, pages: number, link: (page: number) => string, label: string, swipe = false,
) {
  if (pages < 2) return "";
  return `<nav class="pager" aria-label="${label}">
    ${page > 1 ? `<a class="button" href="${escape(link(page - 1))}" rel="prev"${swipe ? " data-page-prev" : ""}>← Previous</a>` : "<span></span>"}
    <span>Page ${page} of ${pages}</span>
    ${page < pages ? `<a class="button" href="${escape(link(page + 1))}" rel="next"${swipe ? " data-page-next" : ""}>Next →</a>` : "<span></span>"}
  </nav>`;
}
