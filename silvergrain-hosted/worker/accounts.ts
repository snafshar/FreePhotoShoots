import { approvalBody, deliverApproval } from "./mail";
import { field, HttpError, seconds, validEmail, validPhone, type Identity } from "./security";
import { ownerHandle, papers, spacings, typefaces, type Bindings, type Member, type Status } from "./types";

export const handlePattern = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const reserved = new Set(["admin","account","accounts","apply","join","login","logout","signin","signup","studio","stories",
  "journal","contact","page","media","static","api","callback","photographers","signin-with-chatgpt","signout-with-chatgpt",
  "settings","profile","privacy","terms","support","www","assets","silvergrain",ownerHandle]);
export const validHandle = (value: string) => handlePattern.test(value) && !reserved.has(value);
export const memberBy = (db: D1Database, key: "id" | "handle", value: string) =>
  db.prepare(`SELECT * FROM contributors WHERE ${key}=?`).bind(value).first<Member>();
function revision(form: URLSearchParams) {
  const value = Number(form.get("revision"));
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, "Reload this page before saving.");
  return value;
}

export async function applyForAccount(env: Bindings, actor: Identity, form: URLSearchParams) {
  if (!actor.signedIn || !actor.email || actor.admin) throw new HttpError(403, "Sign in to request a magazine.");
  if (actor.member) return;
  const handle = field(form, "handle", 32).toLowerCase(), name = field(form, "name", 100), note = field(form, "note", 1000);
  if (!name || !validHandle(handle)) throw new HttpError(400, "Enter a name and an available username of 3–32 letters, numbers or hyphens. Start with a letter.");
  const id = crypto.randomUUID(), now = seconds();
  const [insert] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO contributors(id,site_user_id,email,handle,name,note,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?
      WHERE COALESCE((SELECT value FROM settings WHERE key='applications'),'open')='open' ON CONFLICT DO NOTHING`)
      .bind(id, actor.id, actor.email, handle, name, note, now, now),
    env.DB.prepare("INSERT INTO account_events(member_id,actor,action,created_at) SELECT id,site_user_id,'requested',? FROM contributors WHERE id=?").bind(now,id),
  ]);
  if (!insert.meta.changes && !await env.DB.prepare("SELECT id FROM contributors WHERE site_user_id=?").bind(actor.id).first()) {
    throw new HttpError(409, "The request could not be saved. Check that applications are open and try another username.");
  }
}

export async function saveProfile(db: D1Database, member: Member, actor: Identity, form: URLSearchParams) {
  const name = field(form, "name", 100), handle = actor.admin ? field(form,"handle",32).toLowerCase() : member.handle;
  const email = field(form,"public_email",254), phone = field(form,"public_phone",30);
  if (!name || !validHandle(handle) || (email && !validEmail(email)) || (phone && !validPhone(phone))) {
    throw new HttpError(400, "Enter a name and valid profile details.");
  }
  const result = await db.prepare(`UPDATE OR IGNORE contributors SET handle=?,name=?,bio=?,location=?,public_email=?,public_phone=?,updated_at=?,revision=revision+1
    WHERE id=? AND revision=? AND (?=1 OR (site_user_id=? AND status='approved'))`)
    .bind(handle, name, field(form,"bio",1200), field(form,"location",100), email, phone, seconds(), member.id, revision(form), Number(actor.admin), actor.id).run();
  if (!result.meta.changes) throw new HttpError(409, "This profile changed or that username is taken. Reload before saving.");
}

export const decisions = {
  approve: { from: ["pending","declined"], to: "approved", label: "Approve and email" },
  decline: { from: ["pending"], to: "declined", label: "Decline request" },
  suspend: { from: ["approved"], to: "suspended", label: "Suspend account" },
  restore: { from: ["suspended"], to: "approved", label: "Restore access" },
} satisfies Record<string, { from: Status[]; to: Status; label: string }>;

export async function reviewAccount(env: Bindings, member: Member, actor: Identity, form: URLSearchParams) {
  const key = form.get("action") as keyof typeof decisions;
  if (!actor.admin || !Object.hasOwn(decisions,key) || !(decisions[key].from as Status[]).includes(member.status)) {
    throw new HttpError(409, "This action is unavailable for the current status.");
  }
  const expected = revision(form), mailId = crypto.randomUUID(), now = seconds();
  // D1 batches are transactional. changes() ties the event and notification to the winning revision.
  const queries = [
    env.DB.prepare("UPDATE contributors SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status=?")
      .bind(decisions[key].to, now, member.id, expected, member.status),
    env.DB.prepare("INSERT INTO account_events(member_id,actor,action,created_at) SELECT ?,?,?,? WHERE changes()=1").bind(member.id, actor.id, key, now),
  ];
  if (key === "approve") queries.push(env.DB.prepare(`INSERT INTO approval_emails(id,member_id,recipient,body,created_at)
    SELECT ?,?,?,?,? WHERE changes()=1`).bind(mailId, member.id, member.email, approvalBody(env,member.handle), now));
  if (key === "suspend") queries.push(env.DB.prepare(`UPDATE approval_emails SET state='cancelled' WHERE member_id=?
    AND state IN ('queued','failed','uncertain') AND changes()=1`).bind(member.id));
  const [result] = await env.DB.batch(queries);
  if (!result.meta.changes) throw new HttpError(409, "The account changed. Review its current status.");
  return key === "approve" ? await deliverApproval(env,mailId) : "saved";
}

export async function deleteAccount(db: D1Database, member: Member, actor: Identity, form: URLSearchParams) {
  if (!actor.admin) throw new HttpError(403, "Owner access is required.");
  if (form.get("confirm_handle") !== member.handle) throw new HttpError(400, "Type the exact username to delete the account.");
  const guard = "EXISTS (SELECT 1 FROM contributors WHERE id=? AND revision=?)";
  const args = [member.id, revision(form)];
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO uploads(id,post_id,width,height,expires,uploader_id) SELECT f.id,f.post_id,f.width,f.height,0,?
      FROM photos f JOIN posts p ON p.id=f.post_id WHERE p.owner_id=? AND ${guard}`).bind(member.site_user_id, member.id, ...args),
    db.prepare(`UPDATE uploads SET expires=0 WHERE (uploader_id=? OR post_id IN (SELECT id FROM posts WHERE owner_id=?)) AND ${guard}`).bind(member.site_user_id,member.id,...args),
    db.prepare(`DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE owner_id=?) AND ${guard}`).bind(member.id,...args),
    db.prepare(`DELETE FROM posts WHERE owner_id=? AND ${guard}`).bind(member.id,...args),
    db.prepare(`DELETE FROM messages WHERE owner_id=? AND ${guard}`).bind(member.id,...args),
    db.prepare(`DELETE FROM settings WHERE key=? AND ${guard}`).bind("photo_order:"+member.id,...args),
    db.prepare("DELETE FROM contributors WHERE id=? AND revision=?").bind(...args),
  ]);
  if (!results.at(-1)?.meta.changes) throw new HttpError(409, "The account changed. Reload before deleting.");
}
export async function saveAppearance(db: D1Database, form: URLSearchParams) {
  const title = field(form,"magazine_title",60), paper = field(form,"paper",12), typeface = field(form,"typeface",12), spacing = field(form,"spacing",12);
  if (!title || !Object.hasOwn(papers,paper) || !Object.hasOwn(typefaces,typeface) || !Object.hasOwn(spacings,spacing)) throw new HttpError(400,"Select valid appearance settings.");
  const values = { magazine_title:title, paper, typeface, spacing, applications: form.get("applications")==="open" ? "open" : "closed" };
  await db.batch(Object.entries(values).map(([key,value]) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key,value)));
}
