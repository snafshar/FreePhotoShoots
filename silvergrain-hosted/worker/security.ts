import type { Bindings, Member } from "./types";

const textEncoder = new TextEncoder();
const CSRF_TTL = 12 * 60 * 60;
const CAPTCHA_TTL = 12 * 60;
const FORM_BYTES = 80 * 1024;
const keyCache = new WeakMap<object, Promise<CryptoKey>>();

export const seconds = () => Math.floor(Date.now() / 1000);
export const validEmail = (value: string) => /^[^\s@<>,;:\\"\x00-\x1f\x7f]+@[^\s@<>,;:\\"\x00-\x1f\x7f]+\.[^\s@<>,;:\\"\x00-\x1f\x7f]+$/u.test(value) && value.length <= 254;
export const validPhone = (value: string) => /^\+?[0-9(). -]{3,30}$/.test(value) && (value.match(/[0-9]/g)?.length ?? 0) >= 3;
export const tel = (value: string) => (value.startsWith("+") ? "+" : "") + value.replace(/\D/g, "");

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type Identity = { admin: boolean; signedIn: boolean; id: string; email?: string; member?: Member | null };

export async function identify(request: Request, env: Bindings): Promise<Identity> {
  const id = request.headers.get("oai-authenticated-user-id") || "";
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (!id || !email || !validEmail(email)) return { admin: false, signedIn: false, id: "" };
  let owner = env.SILVERGRAIN_ADMIN_ID;
  if (!owner) {
    if (email === env.SILVERGRAIN_ADMIN_EMAIL?.trim().toLowerCase()) {
      await env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('admin_site_user_id',?)").bind(id).run();
    }
    owner = await env.DB.prepare("SELECT value FROM settings WHERE key='admin_site_user_id'").first<string>("value") ?? undefined;
  }
  if (id === owner) return { admin: true, signedIn: true, id, email };
  const member = await env.DB.prepare("SELECT * FROM contributors WHERE site_user_id=?").bind(id).first<Member>();
  return { admin: false, signedIn: true, id, email, member };
}
export const approvedMember = (actor: Identity) => actor.member?.status === "approved" ? actor.member : null;
export const writerAllowed = "(?=1 OR EXISTS (SELECT 1 FROM contributors WHERE id=? AND site_user_id=? AND status='approved'))";
export const writerArgs = (actor: Identity) => [Number(actor.admin), actor.member?.id ?? null, actor.id];

async function signature(env: Bindings, purpose: string, value: string) {
  const secret = env.SILVERGRAIN_FORM_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503, "The form is temporarily unavailable.");
  let key = keyCache.get(env);
  if (!key) {
    key = crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(env, key);
  }
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", await key, textEncoder.encode(`${purpose}:${value}`)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return mismatch === 0;
}

function cookieName(request: Request) {
  return new URL(request.url).protocol === "https:" ? "__Host-silvergrain-form" : "silvergrain-form";
}

function cookieValue(request: Request) {
  const prefix = cookieName(request) + "=";
  return request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? "";
}

async function validToken(env: Bindings, identity: Identity, token: string) {
  if (!/^\d{1,12}\.[\da-f-]{36}\.[\da-f]{64}$/.test(token)) return false;
  const [stamp, nonce, signed] = token.split(".");
  const age = seconds() - Number(stamp);
  return age >= 0 && age <= CSRF_TTL &&
    equal(signed, await signature(env, "csrf", `${identity.id}:${stamp}.${nonce}`));
}

export async function formToken(request: Request, env: Bindings, identity: Identity) {
  const existing = cookieValue(request);
  if (await validToken(env, identity, existing)) return { token: existing, cookie: "" };
  const payload = `${seconds()}.${crypto.randomUUID()}`;
  const token = `${payload}.${await signature(env, "csrf", `${identity.id}:${payload}`)}`;
  const name = cookieName(request);
  const cookie = `${name}=${token}; Max-Age=${CSRF_TTL}; Path=/; HttpOnly; SameSite=Lax` +
    (name.startsWith("__Host-") ? "; Secure" : "");
  return { token, cookie };
}

export async function verifyForm(request: Request, env: Bindings, identity: Identity, provided: unknown) {
  const stored = cookieValue(request);
  const origin = request.headers.get("origin");
  if ((origin !== null && origin !== new URL(request.url).origin) ||
    ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "") ||
    typeof provided !== "string" || !equal(stored, provided) || !(await validToken(env, identity, stored))
  ) {
    throw new HttpError(403, "This form expired. Reload the page and try again.");
  }
}

export async function readBytes(request: Request, limit: number) {
  const stated = request.headers.get("content-length");
  if (stated && (!/^\d{1,12}$/.test(stated) || Number(stated) > limit)) {
    throw new HttpError(413, "This submission is too large.");
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new HttpError(413, "This submission is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readForm(request: Request, env: Bindings, identity: Identity, maxBytes = FORM_BYTES) {
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new HttpError(415, "Use the journal’s form to submit your information.");
  }
  const data = new URLSearchParams(new TextDecoder().decode(await readBytes(request, maxBytes)));
  await verifyForm(request, env, identity, data.get("csrf"));
  return data;
}

export function field(form: URLSearchParams, key: string, limit: number, label = key) {
  const value = (form.get(key) ?? "").trim();
  if (value.length > limit || value.includes("\0")) {
    throw new HttpError(400, `${label[0].toUpperCase() + label.slice(1)} must be at most ${limit} characters.`);
  }
  return value;
}

export async function rateLimit(request: Request, env: Bindings, scope: string, limit: number) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = seconds();
  const window = now - now % 900;
  const key = await signature(env, "rate", `${scope}:${ip}`);
  const [_, result] = await env.DB.batch<{ count: number }>([
    env.DB.prepare("DELETE FROM rate_limits WHERE window < ?").bind(now - 86400),
    env.DB.prepare(
      "INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) " +
      "ON CONFLICT(key, window) DO UPDATE SET count = count + 1 RETURNING count",
    ).bind(key, window),
  ]);
  if ((result.results[0]?.count ?? Infinity) > limit) {
    throw new HttpError(429, "Please wait a few minutes before submitting again.");
  }
}

export function turnstile(env: Bindings) {
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && env.TURNSTILE_HOSTNAME) return env.TURNSTILE_SITE_KEY;
  if (env.TURNSTILE_SITE_KEY || env.TURNSTILE_SECRET_KEY || env.TURNSTILE_HOSTNAME) {
    throw new HttpError(503, "Contact verification is temporarily unavailable.");
  }
  return "";
}

export async function challenge(env: Bindings, csrf: string) {
  const random = crypto.getRandomValues(new Uint8Array(2));
  const a = random[0] % 8 + 2, b = random[1] % 8 + 2;
  const payload = `${seconds()}.${crypto.randomUUID()}.${a}.${b}`;
  const proof = await signature(env, "contact", `${csrf}:${payload}`);
  return { label: `What is ${a} + ${b}?`, token: `${payload}.${proof}` };
}

export async function verifyChallenge(env: Bindings, form: URLSearchParams) {
  if (turnstile(env)) {
    const token = form.get("cf-turnstile-response") ?? "";
    if (!token || token.length > 2048) return false;
    try {
      const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY!, response: token }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json<{ success: boolean; action: string; hostname: string }>();
      return res.ok && data.success === true && data.action === "contact" &&
        data.hostname === env.TURNSTILE_HOSTNAME!.trim().toLowerCase();
    } catch {
      throw new HttpError(503, "Verification is temporarily unavailable. Try again shortly.");
    }
  }
  const token = form.get("challenge") ?? "";
  if (!/^\d{1,12}\.[\da-f-]{36}\.[2-9]\.[2-9]\.[\da-f]{64}$/.test(token)) return false;
  const [stamp, nonce, a, b, proof] = token.split(".");
  const now = seconds();
  const age = now - Number(stamp);
  if (age < 0 || age > CAPTCHA_TTL || !equal(
    proof, await signature(env, "contact", `${form.get("csrf")}:${stamp}.${nonce}.${a}.${b}`),
  )) return false;
  const [_, result] = await env.DB.batch([
    env.DB.prepare("DELETE FROM captcha_attempts WHERE expires < ?").bind(now),
    env.DB.prepare("INSERT OR IGNORE INTO captcha_attempts VALUES (?, ?)").bind(nonce, Number(stamp) + CAPTCHA_TTL),
  ]);
  return result.meta.changes === 1 && (form.get("answer") ?? "").trim() === String(Number(a) + Number(b));
}
