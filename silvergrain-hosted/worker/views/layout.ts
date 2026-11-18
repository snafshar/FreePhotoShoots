import { tel, type Identity } from "../security";
import { magazineBase, papers, type Settings } from "../types";

const entities: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
export const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => entities[char]);
const dateFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
export const dateLabel = (value: string | number) => dateFormat.format(new Date(typeof value === "number" ? value * 1000 : value));
export const emailLink = (value: string) => "mailto:" + encodeURIComponent(value).replace("%40", "@");
export const phoneLink = (value: string) => "tel:" + tel(value);
export const hidden = (name: string, value: unknown) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
export const trap = '<div class="trap" aria-hidden="true" inert><label>Leave this empty <input name="company" type="text" tabindex="-1" autocomplete="off"></label></div>';
export const notice = (message: string, error = false) => message
  ? `<p class="notice" role="${error ? "alert" : "status"}">${escape(message)}</p>` : "";

export type Active = "home" | "journal" | "photographers" | "contact" | "admin" | "";
export const arrow = '<span aria-hidden="true">↗</span>';

export function layout(site: Settings, title: string, active: Active, identity: Identity, content: string, head = "") {
  const base = magazineBase(site), label = escape(site.magazine_title || "Silvergrain");
  const links = [["home", base || "/", "Home"], ["journal", base + "/journal", "Journal"], ["photographers", "/photographers", "Photographers"], ["contact", base + "/contact", "Contact"]];
  const brand = `<a class="brand" href="/" aria-label="${label} home"><span class="brand-mark" aria-hidden="true"></span><span class="brand-word">${label}</span></a>`;
  const account = identity.admin ? ["/admin","Manage"] : identity.member?.status === "approved" ? ["/studio","My studio"] :
    identity.signedIn ? ["/account","Account"] : ["/login","Sign in"];
  return `<!doctype html>
<html lang="en" data-paper="${escape(site.paper || "cream")}" data-typeface="${escape(site.typeface || "editorial")}" data-spacing="${escape(site.spacing || "spacious")}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${label}, a black-and-white photography magazine by ${escape(site.name)}.">
  <meta name="theme-color" content="${(papers[site.paper || "cream"] || papers.cream)[1]}">
  <title>${title ? escape(title) + " · " : ""}${label}</title>
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
      <a class="admin-link" href="${account[0]}"><span class="lock-icon" aria-hidden="true"></span>${account[1]}</a>
    </div>
  </header>
  <main id="main">${content}</main>
  <footer class="site-footer">
    <div class="shell footer-inner">
      ${brand}<p>© ${new Date().getUTCFullYear()} ${escape(site.name)}</p>
      <a class="small-link" href="${base}/contact">Contact ${arrow}</a>
    </div>
  </footer>
</body>
</html>`;
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
