import { field, HttpError, seconds, validEmail } from "./security";
import type { Bindings } from "./types";

export type Delivery = {
  id: string; member_id: string; recipient: string; body: string; state: string; created_at: number;
  sender: string | null; first_attempt: number | null; attempted_at: number | null; provider_id: string | null;
};
type StoredSender = { from: string; encrypted: string; iv: string };
const encode = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = (encoded: string) => Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
const utf8 = new TextEncoder();
const dayWindow = 23 * 60 * 60;
export const emailSubject = "Your Silvergrain publishing request was approved";

async function wrappingKey(env: Bindings) {
  if (!env.SILVERGRAIN_FORM_SECRET || env.SILVERGRAIN_FORM_SECRET.length < 32) throw new HttpError(503, "The secure sender settings need attention.");
  const material = await crypto.subtle.importKey("raw", utf8.encode(env.SILVERGRAIN_FORM_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8.encode("silvergrain-mail-v1"), info: utf8.encode("resend-sender") },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function stored(env: Bindings): Promise<StoredSender | null> {
  const value = await env.DB.prepare("SELECT value FROM settings WHERE key='mail_sender'").first<string>("value");
  return value ? JSON.parse(value) : null;
}
const managed = (env: Bindings) => !!(env.RESEND_API_KEY && env.SILVERGRAIN_EMAIL_FROM);
export async function senderStatus(env: Bindings) {
  if (managed(env)) return { managed: true, from: env.SILVERGRAIN_EMAIL_FROM! };
  return { managed: false, from: (await stored(env))?.from ?? "" };
}
export async function saveSender(env: Bindings, form: URLSearchParams) {
  if (managed(env)) throw new HttpError(409, "The sender is managed in hosting settings.");
  const from = field(form, "from", 254), key = field(form, "api_key", 240);
  if (!validEmail(from) || !/^re_[A-Za-z0-9_-]{8,235}$/.test(key)) throw new HttpError(400, "Enter a verified sending address and a Resend sending key.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wrappingKey(env), utf8.encode(key));
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES('mail_sender',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify({ from, encrypted: encode(encrypted), iv: encode(iv) })).run();
}
async function credentials(env: Bindings) {
  if (managed(env)) return { from: env.SILVERGRAIN_EMAIL_FROM!, key: env.RESEND_API_KEY! };
  const saved = await stored(env);
  if (!saved) return null;
  const key = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(saved.iv) }, await wrappingKey(env), decode(saved.encrypted));
  return { from: saved.from, key: new TextDecoder().decode(key) };
}
export function approvalBody(env: Bindings, handle: string) {
  const origin = new URL(env.SILVERGRAIN_PUBLIC_ORIGIN || "https://silvergrain.afsharsn.chatgpt.site");
  if (origin.protocol !== "https:" || origin.username || origin.password) throw new HttpError(503, "The configured magazine address needs attention.");
  return `Your publishing request has been approved.\n\nSign in with the same ChatGPT account to publish your photographs and stories.\n${origin.origin}/studio\n\nYour magazine\n${origin.origin}/${handle}\n\nSilvergrain`;
}
export async function deliverApproval(env: Bindings, id: string) {
  let sender;
  try { sender = await credentials(env); } catch { return "configuration"; }
  if (!sender) return "queued";
  const now = seconds(), claim = crypto.randomUUID();
  // A frozen payload and stable idempotency key cover retries after a lost response.
  const mail = await env.DB.prepare(`UPDATE approval_emails SET claim=?, state='sending', sender=COALESCE(sender,?),
    first_attempt=COALESCE(first_attempt,?),attempted_at=? WHERE id=?
    AND (state IN ('queued','failed') OR (state IN ('uncertain','sending') AND first_attempt>? AND attempted_at<?))
    AND EXISTS (SELECT 1 FROM contributors WHERE id=approval_emails.member_id AND status='approved') RETURNING *`)
    .bind(claim, sender.from, now, now, id, now-dayWindow, now-60).first<Delivery>();
  if (!mail) return "unchanged";
  let state = "uncertain", providerId: string | null = null;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(8000),
      headers: { Authorization: "Bearer " + sender.key, "Content-Type": "application/json", "Idempotency-Key": "approval/" + mail.id },
      body: JSON.stringify({ from: mail.sender, to: [mail.recipient], subject: emailSubject, text: mail.body }),
    });
    if (response.ok) {
      const data = await response.json<{id?: string}>();
      if (typeof data.id === "string" && data.id.length && data.id.length <= 100) {
        providerId = data.id; state = "accepted";
      }
    } else if ([400,401,403,404,422,429].includes(response.status)) state = "failed";
  } catch { /* The provider may have accepted a request whose response was lost. */ }
  await env.DB.prepare(`UPDATE approval_emails SET state=?,provider_id=?,claim=NULL,
    first_attempt=CASE WHEN ?='failed' THEN NULL ELSE first_attempt END,
    sender=CASE WHEN ?='failed' THEN NULL ELSE sender END WHERE id=? AND claim=?`)
    .bind(state, providerId, state, state, id, claim).run();
  return state;
}
export function needsReconciliation(mail: Delivery) {
  return ["sending","uncertain"].includes(mail.state) && mail.first_attempt !== null && mail.first_attempt <= seconds() - dayWindow;
}
export async function updateDelivery(env: Bindings, id: string, form: URLSearchParams) {
  const action = form.get("action");
  if (action === "manual") {
    if (form.get("sent_by_editor") !== "yes") throw new HttpError(400, "Confirm that you sent the approval email.");
    const result = await env.DB.prepare(`UPDATE approval_emails SET state='manual' WHERE id=? AND state IN ('queued','failed')
      AND EXISTS (SELECT 1 FROM contributors WHERE id=approval_emails.member_id AND status='approved')`).bind(id).run();
    if (!result.meta.changes) throw new HttpError(409, "The delivery status changed. Reload this page.");
    return "reviewed";
  }
  if (action === "confirmed" || action === "requeue") {
    if (form.get("checked_provider") !== "yes") throw new HttpError(400, "Check the provider log before updating the delivery.");
    const result = await env.DB.prepare(`UPDATE approval_emails SET state=?,claim=NULL,first_attempt=NULL,attempted_at=NULL
      WHERE id=? AND state IN ('uncertain','sending') AND first_attempt<=?`)
      .bind(action === "confirmed" ? "accepted" : "queued", id, seconds()-dayWindow).run();
    if (!result.meta.changes) throw new HttpError(409, "The delivery status changed. Reload this page.");
    if (action === "confirmed") return "reviewed";
  } else if (action !== "send") throw new HttpError(400, "Choose an email action.");
  return deliverApproval(env, id);
}
