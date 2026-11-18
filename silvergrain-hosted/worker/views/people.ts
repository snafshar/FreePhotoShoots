import { decisions } from "../accounts";
import { emailSubject, needsReconciliation, type Delivery } from "../mail";
import { papers, spacings, typefaces, type Member, type Settings, type Status } from "../types";
import { dateLabel, emailLink, escape as e, hidden, notice, pager } from "./layout";
import { studioNavigation, type Desk } from "./admin";

const signOut = '<a class="button" href="/signout-with-chatgpt?return_to=%2F" target="_top">Sign out</a>';
const signIn = (next: string) => `<a class="button button-light" href="/signin-with-chatgpt?return_to=${encodeURIComponent(next)}" target="_top">Sign in with ChatGPT</a>`;
export const statuses: Record<Status, string> = { pending:"Pending", approved:"Approved", suspended:"Suspended", declined:"Declined" };

export function loginView(join: boolean, open: boolean, title: string) {
  return `<section class="shell narrow-page account-page"><p class="eyebrow">${e(title)}</p><h1>${join ? "Request a magazine" : "Sign in"}</h1>
    <p class="account-intro">${join ? (open ? "Choose a username and send a request to the editor. Once approved, you can publish photos and stories in your own magazine." : "New contributor requests are currently closed.") : "Open your photography studio or check the status of your request."}</p>
    <div class="account-actions">${signIn(join ? "/join" : "/account")}${join ? "" : '<a class="small-link" href="/join">Request a contributor account</a>'}</div></section>`;
}
export function joinView(email: string, person: Member | null | undefined, token: string, open: boolean, issue = "", form?: URLSearchParams) {
  const status = {
    pending:["Request received","The editor will review your request. Your approval email will go to your sign-in address."],
    declined:["Request declined","The editor has declined this request. Contact the editor if you have a question."],
    suspended:["Account suspended","Your magazine and publishing access are suspended. Contact the editor about your account."],
    approved:["Account approved","Your studio is ready."],
  };
  if (person) {
    const [heading,body] = status[person.status];
    return `<section class="shell narrow-page account-page"><p class="eyebrow">Contributor account</p><h1>${heading}</h1><p class="account-intro">${body}</p>
      <p>@${e(person.handle)} · ${e(email)}</p><div class="account-actions"><a class="button" href="/contact">Contact the editor</a>${signOut}</div></section>`;
  }
  return `<section class="shell narrow-page account-page"><p class="eyebrow">Contributor account</p><h1>Request a magazine</h1>${notice(issue,true)}
    ${open ? `<form class="form" method="post" action="/join">${hidden("csrf",token)}
      <p class="muted">Your approval email will go to ${e(email)}.</p>
      <label class="field">Display name<input name="name" maxlength="100" required autocomplete="name" value="${e(form?.get("name"))}"></label>
      <label class="field">Magazine username<input name="handle" maxlength="32" minlength="3" pattern="[a-zA-Z][a-zA-Z0-9\\-]{1,30}[a-zA-Z0-9]" required autocapitalize="none" autocomplete="off" placeholder="your-name" value="${e(form?.get("handle"))}">
      <small>Your public address ends in /your-name.</small></label>
      <label class="field">Message to the editor (optional)<textarea name="note" maxlength="1000" rows="3">${e(form?.get("note"))}</textarea></label>
      <button class="button button-light">Send request</button></form>` : "<p>New contributor requests are currently closed.</p>"}<div class="account-actions">${signOut}</div></section>`;
}
export function deskFrame(title: string, section: string, desk: Desk, body: string, message = "", issue = "") {
  return `<div class="shell studio"><header class="studio-heading"><div><p class="eyebrow">${desk === "/admin" ? "Site management" : "Contributor studio"}</p><h1>${e(title)}</h1></div>${signOut}</header>
    <nav class="studio-nav" aria-label="Dashboard">${studioNavigation(section,desk)}</nav>${notice(message)}${notice(issue,true)}${body}</div>`;
}
export function profileForm(person: Member, token: string, admin: boolean) {
  return `<form class="form settings-panel" method="post" action="${admin ? "/admin/users/"+person.id+"/profile" : "/studio/profile"}">
    ${hidden("csrf",token)}${hidden("revision",person.revision)}
    <label class="field">Display name<input name="name" required maxlength="100" autocomplete="name" value="${e(person.name)}"></label>
    ${admin ? `<label class="field">Magazine username<input name="handle" required maxlength="32" value="${e(person.handle)}"><small>Changing the username changes the magazine’s public address.</small></label>`
      : `<p>Magazine address · <a href="/${person.handle}">/${e(person.handle)}</a></p>`}
    <label class="field">About you<textarea name="bio" rows="4" maxlength="1200">${e(person.bio)}</textarea></label>
    <label class="field">Location<input name="location" maxlength="100" value="${e(person.location)}"></label>
    <div class="field-row"><label class="field">Public email (optional)<input name="public_email" type="email" maxlength="254" value="${e(person.public_email)}"></label>
    <label class="field">Public phone (optional)<input name="public_phone" type="tel" maxlength="30" value="${e(person.public_phone)}"></label></div>
    <button class="button button-light">Save profile</button></form>`;
}
const options = (values: Record<string,string>, current: string) => Object.entries(values).map(([key,label]) =>
  `<option value="${e(key)}"${key === current ? " selected" : ""}>${e(label)}</option>`).join("");
export function appearanceView(site: Settings, token: string) {
  return `<form class="form settings-panel" method="post" action="/admin/appearance">${hidden("csrf",token)}
    <label class="field">Magazine title<input name="magazine_title" required maxlength="60" value="${e(site.magazine_title || "Silvergrain")}"></label>
    <div class="field-row"><label class="field">Paper color<select name="paper">${options(Object.fromEntries(Object.entries(papers).map(([key,[label]])=>[key,label])),site.paper || "cream")}</select></label>
    <label class="field">Heading typeface<select name="typeface">${options(typefaces,site.typeface || "editorial")}</select></label></div>
    <label class="field">Photo spacing<select name="spacing">${options(spacings,site.spacing || "spacious")}</select></label>
    <label class="check"><input type="checkbox" name="applications" value="open"${site.applications === "closed" ? "" : " checked"}> Accept new contributor requests</label>
    <button class="button button-light">Save settings</button></form>`;
}
export function peopleView(rows: Member[], status: string, q: string, pending: number, page: number, pages: number) {
  const link = (n: number) => "/admin/users?" + new URLSearchParams({status,q,page:String(n)});
  return `<section><div class="section-heading"><h2>Contributors</h2><span class="muted">${pending} pending</span></div>
    <form class="people-search" method="get"><label class="field">Search people<input name="q" type="search" value="${e(q)}" maxlength="100"></label>
    <label class="field">Status<select name="status">${options({all:"All",...statuses},status)}</select></label><button class="button">Filter</button></form>
    ${rows.length ? `<ul class="people-list">${rows.map(person=>`<li><div><a class="person-name" href="/admin/users/${person.id}">${e(person.name)}</a>
    <p class="muted">@${e(person.handle)} · ${e(person.email)}</p></div><span class="entry-state">${statuses[person.status]}</span></li>`).join("")}</ul>` : '<p class="empty">No contributors in this view.</p>'}
    ${pager(page,pages,link,"Contributor pages")}</section>`;
}
const deliveryLabels: Record<string,string> = {queued:"Queued",failed:"Provider rejected email",uncertain:"Delivery unconfirmed",sending:"Sending",accepted:"Accepted by email provider",manual:"Marked sent by editor",cancelled:"Cancelled"};
function mailRow(mail: Delivery, token: string) {
  const action = "/admin/email/"+mail.id, fields = hidden("csrf",token), manual = ["queued","failed"].includes(mail.state);
  const compose = emailLink(mail.recipient) + "?subject=" + encodeURIComponent(emailSubject) + "&body=" + encodeURIComponent(mail.body);
  return `<div class="mail-row"><p>${e(mail.recipient)}<br><span class="muted">${e(deliveryLabels[mail.state] || "Unknown")} · ${dateLabel(mail.created_at)}</span></p>
    ${!["accepted","manual","cancelled"].includes(mail.state) ? `<form method="post" action="${action}">${fields}
      ${needsReconciliation(mail) ? '<label class="check"><input type="checkbox" name="checked_provider" value="yes" required> I checked the provider log</label><button class="button compact" name="action" value="confirmed">Already sent</button><button class="button compact" name="action" value="requeue">Confirmed unsent · send now</button>' :
      '<button class="button compact" name="action" value="send">Send via provider</button>'}</form>` : ""}
    ${manual ? `<details><summary>Send from my mail app</summary><a class="small-link" href="${e(compose)}">Compose approval email</a>
      <form method="post" action="${action}">${fields}<label class="check"><input type="checkbox" name="sent_by_editor" value="yes" required> I sent this email</label>
      <button class="button compact" name="action" value="manual">Mark sent</button></form></details>` : ""}</div>`;
}
export function emailView(sender: {from:string;managed:boolean}, rows: Delivery[], token: string, page: number, pages: number) {
  return `<div class="manage-columns"><section><h2>Approval sender</h2><p>${sender.from ? "Current sender · " + e(sender.from) : "Connect a sender to deliver approval emails automatically."}</p>
    ${sender.managed ? '<p class="muted">Configured in hosting settings.</p>' : `<form class="form" method="post" action="/admin/email">${hidden("csrf",token)}
    <label class="field">Verified Resend address<input name="from" type="email" maxlength="254" required value="${e(sender.from)}"></label>
    <label class="field">Resend sending key<input name="api_key" type="password" maxlength="240" required autocomplete="new-password"></label>
    <a class="small-link" href="https://resend.com/domains" target="_blank" rel="noopener noreferrer">Manage verified domains</a><button class="button button-light">Save sender</button></form>`}</section>
    <section><h2>Approval emails</h2>${rows.length ? rows.map(row=>mailRow(row,token)).join("") : '<p class="empty">Approved requests will appear here.</p>'}
    ${pager(page,pages,n=>"/admin/email?page="+n,"Approval email pages")}</section></div>`;
}
export function memberView(person: Member, token: string, total: number, events: {action:string;created_at:number}[], emails: Delivery[]) {
  const path = "/admin/users/"+person.id, hiddenFields = hidden("csrf",token) + hidden("revision",person.revision);
  return `<a class="small-link" href="/admin/users">All contributors</a><div class="manage-columns"><section>
    <div class="section-heading"><h2>Account</h2><span class="entry-state">${statuses[person.status]}</span></div><p>${e(person.email)}<br>@${e(person.handle)} · Requested ${dateLabel(person.created_at)}</p>
    ${person.note ? `<p class="prose">${e(person.note)}</p>` : ""}<form class="account-actions" method="post" action="${path}/decision">${hiddenFields}
    ${Object.entries(decisions).filter(([,decision])=>(decision.from as Status[]).includes(person.status)).map(([key,decision])=>`<button class="button${key === "approve" ? " button-light" : ""}" name="action" value="${key}">${decision.label}</button>`).join("")}</form>
    <div class="account-actions"><a class="small-link" href="/admin?author=${person.id}">Manage stories (${total})</a><a class="small-link" href="/admin/order?author=${person.id}">Set photo order</a>
    ${person.status === "approved" ? `<a class="small-link" href="/${person.handle}">View magazine</a>` : ""}</div>
    ${emails.map(row=>mailRow(row,token)).join("")}<details><summary>Account history</summary><ul>${events.map(ev=>`<li>${e(ev.action)} · ${dateLabel(ev.created_at)}</li>`).join("")}</ul></details>
    <details><summary>Delete account</summary><form class="form" method="post" action="${path}/delete">${hiddenFields}
    <label class="field">Type ${e(person.handle)} to permanently delete this account, its photos, stories and inbox.<input name="confirm_handle" required autocomplete="off"></label>
    <button class="button">Delete account</button></form></details></section><section><h2>Public profile</h2>${profileForm(person,token,true)}</section></div>`;
}
export type DirectoryPerson = { handle: string; name: string; location: string; image: string | null };
export function directoryView(people: DirectoryPerson[], page: number, pages: number) {
  return `<div class="shell"><header class="magazine-heading"><div><h1>Photographers</h1></div><a class="small-link" href="/join">Request a magazine</a></header>
    <ul class="directory-list">${people.map(person=>`<li><a href="/${person.handle}">${person.image ? `<img src="${e(person.image)}" width="96" height="68" alt="" loading="lazy">` : ""}
      <span><strong>${e(person.name)}</strong>${person.location ? `<small>${e(person.location)}</small>` : ""}</span></a></li>`).join("")}</ul>
    ${pager(page,pages,n=>"/photographers?page="+n,"Photographer pages")}</div>`;
}
