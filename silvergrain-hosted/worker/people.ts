import { applyForAccount, deleteAccount, memberBy, reviewAccount, saveAppearance, saveProfile } from "./accounts";
import { clearExpiredUploads } from "./data";
import { html, notFound, redirect, type State } from "./http";
import { saveSender, senderStatus, updateDelivery, type Delivery } from "./mail";
import { approvedMember, formToken, HttpError, rateLimit, readForm } from "./security";
import { ownerHandle, type Member } from "./types";
import { appearanceView, deskFrame, directoryView, emailView, joinView, loginView, memberView, peopleView, profileForm, statuses, type DirectoryPerson } from "./views/people";

const getForm = (s: State) => readForm(s.request,s.env,s.identity);
const getToken = (s: State) => formToken(s.request,s.env,s.identity);
const messages: Record<string,string> = {
  saved:"Changes saved.", queued:"Approval email queued. Connect a sender or send it from your mail app.",
  accepted:"The email provider accepted the approval email.", failed:"The email provider rejected the approval email. Check the sender and retry.",
  uncertain:"Delivery is unconfirmed. Check the email outbox.", configuration:"Update the email sender to send the approval.",
  reviewed:"Delivery status updated.", sender:"Sender saved.", removed:"Account deleted.", unchanged:"See the current delivery status below.",
};
function flash(s: State) {
  const key = s.url.searchParams.get("saved") || "";
  return Object.hasOwn(messages,key) ? messages[key] : "";
}
function paging(s: State, total: number, size = 25) {
  const raw = s.url.searchParams.get("page") || "1", page = Number(raw), pages = Math.max(1,Math.ceil(total/size));
  if (!/^[1-9][0-9]{0,6}$/.test(raw) || page > pages) throw notFound();
  return { page,pages,offset:(page-1)*size };
}
export async function account(s: State, path: string, get: boolean) {
  const {identity,site} = s;
  if (!get && path !== "/join") throw notFound();
  if (!identity.signedIn) {
    if (!get) throw new HttpError(403,"Sign in to request a magazine.");
    return html(s,path === "/join" ? "Request a magazine" : "Sign in","",loginView(path === "/join",site.applications !== "closed",site.magazine_title || "Silvergrain"));
  }
  if (identity.admin) return redirect("/admin");
  if (approvedMember(identity)) return redirect("/studio");
  if (path !== "/join") return redirect("/join");
  let form: URLSearchParams | undefined, issue: HttpError | undefined;
  if (!get) {
    form = await getForm(s);
    await rateLimit(s.request,s.env,"apply",12);
    try { await applyForAccount(s.env,identity,form); return redirect("/account"); }
    catch (error) {
      if (!(error instanceof HttpError) || ![400,409].includes(error.status)) throw error;
      issue = error;
    }
  }
  const csrf = await getToken(s);
  return html(s,"Contributor request","",joinView(identity.email!,identity.member,csrf.token,site.applications !== "closed",issue?.message,form),
    {cookie:csrf.cookie,status:issue?.status});
}
export async function personalProfile(s: State, get: boolean) {
  const person = approvedMember(s.identity);
  if (!person) throw new HttpError(403,"Publishing access is required.");
  if (!get) { await saveProfile(s.env.DB,person,s.identity,await getForm(s)); return redirect("/studio/profile?saved=saved"); }
  const csrf = await getToken(s);
  return html(s,"My profile","admin",deskFrame("My profile","profile","/studio",profileForm(person,csrf.token,false),flash(s)),{cookie:csrf.cookie});
}
export async function directory(s: State) {
  const db = s.env.DB;
  const total = await db.prepare("SELECT count(*) AS n FROM contributors WHERE status='approved'").first<number>("n") ?? 0;
  const {page,pages,offset} = paging(s,total+1,24);
  const rows = await db.prepare(`SELECT c.name,c.handle,c.location,
    (SELECT '/media/' || f.id || '/small' FROM photos f JOIN posts p ON p.id=f.post_id WHERE p.owner_id=c.id AND p.published_at IS NOT NULL
      ORDER BY p.published_at DESC,f.position,f.id LIMIT 1) AS image FROM contributors c WHERE status='approved'
    ORDER BY c.name COLLATE NOCASE,c.handle LIMIT ? OFFSET ?`).bind(page === 1 ? 23 : 24,Math.max(0,offset-1)).all<DirectoryPerson>();
  if (page === 1) {
    const cover = await db.prepare(`SELECT f.id FROM photos f JOIN posts p ON p.id=f.post_id WHERE p.owner_id IS NULL AND p.published_at IS NOT NULL
      ORDER BY p.published_at DESC,f.position,f.id LIMIT 1`).first<string>("id");
    rows.results.unshift({handle:ownerHandle,name:s.site.name,location:"",image:cover ? "/media/"+cover+"/small" : s.site.hide_samples === "1" ? null : "/static/demo/dolomites-small.webp"});
  }
  return html(s,"Photographers","photographers",directoryView(rows.results,page,pages));
}
export async function management(s: State, path: string, get: boolean, ctx: ExecutionContext) {
  if (!s.identity.admin) throw new HttpError(403,"Owner access is required.");
  const db = s.env.DB, csrf = await getToken(s);
  const show = (title: string, section: string, content: string) => html(s,title,"admin",deskFrame(title,section,"/admin",content,flash(s)),{cookie:csrf.cookie});
  if (path === "/admin/appearance") {
    if (get) return show("Appearance","appearance",appearanceView(s.site,csrf.token));
    await saveAppearance(db,await getForm(s));
    return redirect("/admin/appearance?saved=saved");
  }
  if (path === "/admin/email") {
    if (!get) { await saveSender(s.env,await getForm(s)); return redirect("/admin/email?saved=sender"); }
    const total = await db.prepare("SELECT count(*) AS n FROM approval_emails").first<number>("n") ?? 0;
    const {page,pages,offset} = paging(s,total);
    const [sender,rows] = await Promise.all([senderStatus(s.env),db.prepare("SELECT * FROM approval_emails ORDER BY created_at DESC,id LIMIT 25 OFFSET ?").bind(offset).all<Delivery>()]);
    return show("Email","email",emailView(sender,rows.results,csrf.token,page,pages));
  }
  const mail = path.match(/^\/admin\/email\/([a-f0-9-]{36})$/);
  if (mail && !get) return redirect("/admin/email?saved="+await updateDelivery(s.env,mail[1],await getForm(s)));
  if (path === "/admin/users" && get) {
    const status = s.url.searchParams.get("status") || "all", q = (s.url.searchParams.get("q") || "").trim();
    if ((status !== "all" && !Object.hasOwn(statuses,status)) || q.length>100) throw new HttpError(400,"Use a valid search and status.");
    const where = "WHERE (?='all' OR status=?) AND (instr(lower(name),lower(?))>0 OR instr(handle,lower(?))>0 OR instr(lower(email),lower(?))>0)";
    const args = [status,status,q,q,q];
    const [total,pending] = await db.batch<{n:number}>([db.prepare("SELECT count(*) AS n FROM contributors "+where).bind(...args),
      db.prepare("SELECT count(*) AS n FROM contributors WHERE status='pending'")]);
    const {page,pages,offset} = paging(s,total.results[0].n);
    const rows = await db.prepare(`SELECT * FROM contributors ${where} ORDER BY (status='pending') DESC,created_at DESC,id LIMIT 25 OFFSET ?`).bind(...args,offset).all<Member>();
    return show("People","users",peopleView(rows.results,status,q,pending.results[0].n,page,pages));
  }
  const target = path.match(/^\/admin\/users\/([a-f0-9-]{36})(?:\/(decision|profile|delete))?$/);
  if (!target) throw notFound();
  const person = await memberBy(db,"id",target[1]);
  if (!person) throw notFound("This account is unavailable.");
  const detail = "/admin/users/"+person.id;
  if (!get && target[2]) {
    const form = await getForm(s);
    if (target[2] === "decision") return redirect(detail+"?saved="+await reviewAccount(s.env,person,s.identity,form));
    if (target[2] === "delete") {
      await deleteAccount(db,person,s.identity,form);
      ctx.waitUntil(clearExpiredUploads(s.env).catch(()=>console.error("Photo cleanup deferred")));
      return redirect("/admin/users?saved=removed");
    }
    await saveProfile(db,person,s.identity,form);
    return redirect(detail+"?saved=saved");
  }
  if (!get || target[2]) throw notFound();
  const [total,events,mailRows] = await db.batch([
    db.prepare("SELECT count(*) AS n FROM posts WHERE owner_id=?").bind(person.id),
    db.prepare("SELECT action,created_at FROM account_events WHERE member_id=? ORDER BY id DESC LIMIT 25").bind(person.id),
    db.prepare("SELECT * FROM approval_emails WHERE member_id=? ORDER BY created_at DESC LIMIT 5").bind(person.id),
  ]);
  return show(person.name,"users",memberView(person,csrf.token,Number((total.results[0] as {n:number}).n),
    events.results as {action:string;created_at:number}[],mailRows.results as Delivery[]));
}
