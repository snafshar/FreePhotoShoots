import { HttpError, type Identity } from "./security";
import type { Bindings, Settings } from "./types";
import { escape, layout, type Active } from "./views/layout";

export type State = { desk: "/admin" | "/studio"; orderAction?: string; request: Request; env: Bindings; identity: Identity; site: Settings; url: URL };
const originalCsp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'";
export const fallbackSite = { name: "Sina Afshar", email: "", phone: "", hide_samples: "0" };

export function html(state: State, title: string, active: Active, body: string, options: { status?: number; cookie?: string; turnstile?: boolean } = {}) {
  let csp = originalCsp;
  let head = "";
  if (options.turnstile) {
    csp = csp.replace("script-src 'self'", "script-src 'self' https://challenges.cloudflare.com") + "; frame-src https://challenges.cloudflare.com";
    head = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';
  }
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  if (active === "admin" || /^\/(admin|studio|account|join|login)(?:\/|$)/.test(state.url.pathname)) {
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Content-Security-Policy", csp + "; frame-ancestors 'self' https://chatgpt.com");
    headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  if (options.cookie) headers.append("Set-Cookie", options.cookie);
  const content = state.request.method === "HEAD" ? null : layout(state.site, title, active, state.identity, body, head);
  return new Response(content, { status: options.status ?? 200, headers });
}

export function redirect(location: string) {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}
export function errorPage(state: State, error: HttpError) {
  if (state.request.method === "POST" && /^\/(admin|studio)\/uploads\//.test(state.url.pathname)) {
    return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  return html(state, String(error.status), "", `<section class="shell narrow-page"><p class="eyebrow">${error.status}</p>
    <h1>${escape(error.message)}</h1><a class="small-link" href="/">← Back to the home page</a></section>`, { status: error.status });
}
export const notFound = (message = "This page is unavailable.") => new HttpError(404, message);
export const isFormError = (error: unknown): error is HttpError => error instanceof HttpError && error.status === 400;
