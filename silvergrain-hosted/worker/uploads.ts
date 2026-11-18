import { clearExpiredUploads, maxPhotoBytes, maxPhotoSide, photoKeys, registerUpload, storyIdPattern } from "./data";
import { approvedMember, HttpError, rateLimit, readBytes, verifyForm } from "./security";
import type { Identity } from "./security";
import type { Bindings } from "./types";

const maxThumb = 1024 * 1024;
const maxSmallSide = 720;

function inspectWebP(bytes: Uint8Array) {
  if (bytes.length < 30) throw new HttpError(415, "Choose a valid still image.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = (offset: number, name: string) => name.split("").every((letter, i) => bytes[offset + i] === letter.charCodeAt(0));
  if (!chunk(0, "RIFF") || !chunk(8, "WEBP") || view.getUint32(4, true) + 8 !== bytes.length) {
    throw new HttpError(415, "Choose a valid still image.");
  }
  let offset = 12;
  let width = 0, height = 0;
  let image = false;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (size > bytes.length - start) throw new HttpError(415, "Choose a valid still image.");
    if (chunk(offset, "VP8 ") && size >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 1 && bytes[start + 5] === 0x2a) {
      if (image) throw new HttpError(415, "Choose a valid still image.");
      width = view.getUint16(start + 6, true) & 0x3fff;
      height = view.getUint16(start + 8, true) & 0x3fff;
      image = true;
    } else if (chunk(offset, "VP8L") && size >= 5 && bytes[start] === 0x2f) {
      if (image) throw new HttpError(415, "Choose a valid still image.");
      const bits = view.getUint32(start + 1, true);
      width = 1 + (bits & 0x3fff);
      height = 1 + ((bits >> 14) & 0x3fff);
      image = true;
    } else if (!(chunk(offset, "ALPH") || chunk(offset, "VP8X"))) {
      throw new HttpError(415, "Choose a still image processed by the editor.");
    }
    offset = start + size + (size & 1);
  }
  if (!image || !width || !height || offset !== bytes.length) throw new HttpError(415, "Choose a valid still image.");
  return { width, height };
}

export async function uploadPhoto(request: Request, env: Bindings, identity: Identity, postId: string) {
  if (!storyIdPattern.test(postId)) throw new HttpError(400, "Reload the story editor.");
  await verifyForm(request, env, identity, request.headers.get("x-silvergrain-csrf"));
  if (request.headers.get("content-type") !== "application/octet-stream") throw new HttpError(415, "Use the photo editor to upload.");
  const length = request.headers.get("x-silvergrain-full-bytes") ?? "";
  if (!/^[1-9][0-9]{0,7}$/.test(length) || Number(length) > maxPhotoBytes) {
    throw new HttpError(413, "This photograph is too large after resizing.");
  }
  if (!identity.admin) {
    const member = approvedMember(identity);
    if (!member) throw new HttpError(403, "Publishing access is required.");
    const post = await env.DB.prepare("SELECT owner_id FROM posts WHERE id=?").bind(postId).first<{owner_id: string | null}>();
    if (post && post.owner_id !== member.id) throw new HttpError(404, "This story is unavailable.");
    await rateLimit(request, env, "upload-" + member.id, 60);
  }
  const data = await readBytes(request, maxPhotoBytes + maxThumb);
  const full = data.subarray(0, Number(length));
  const small = data.subarray(Number(length));
  if (!small.length || small.length > maxThumb) throw new HttpError(413, "This thumbnail is too large.");
  const fullInfo = inspectWebP(full);
  const smallInfo = inspectWebP(small);
  if (Math.max(fullInfo.width, fullInfo.height) > maxPhotoSide || Math.max(smallInfo.width, smallInfo.height) > maxSmallSide) {
    throw new HttpError(400, "The photo was not resized. Select the original again.");
  }
  const id = crypto.randomUUID();
  const keys = photoKeys(id);
  await clearExpiredUploads(env);
  const options = { httpMetadata: { contentType: "image/webp" } };
  const writes = await Promise.allSettled([env.BUCKET.put(keys[0], full, options), env.BUCKET.put(keys[1], small, options)]);
  if (writes.some((write) => write.status === "rejected")) {
    await env.BUCKET.delete([...keys]);
    throw new HttpError(503, "Photo storage is temporarily unavailable. Try again.");
  }
  try {
    await registerUpload(env, identity, postId, id, fullInfo.width, fullInfo.height);
  } catch (error) {
    await env.BUCKET.delete([...keys]);
    throw error;
  }
  return Response.json({ id }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

export async function media(env: Bindings, identity: Identity, id: string, small: boolean, head: boolean) {
  const photo = await env.DB.prepare(`SELECT f.id FROM photos f JOIN posts p ON p.id=f.post_id
    LEFT JOIN contributors c ON c.id=p.owner_id WHERE f.id=? AND (?=1 OR
    (p.owner_id IS NULL AND p.published_at IS NOT NULL) OR
    (c.status='approved' AND (p.published_at IS NOT NULL OR c.site_user_id=?)))`)
    .bind(id, Number(identity.admin), identity.id).first();
  if (!photo) return new Response(null, { status: 404, headers: {"Cache-Control": "no-store"} });
  const object = await env.BUCKET.get(photoKeys(id)[small ? 1 : 0]);
  if (!object) return new Response(null, { status: 404 });
  if (head) await object.body.cancel();
  return new Response(head ? null : object.body, { headers: {
    "Content-Type": "image/webp", "Cache-Control": "private, no-store",
    "Content-Length": String(object.size), "X-Content-Type-Options": "nosniff",
  } });
}

export async function pendingMedia(env: Bindings, postId: string, id: string, actor: Identity) {
  const pending = await env.DB.prepare("SELECT 1 FROM uploads WHERE id = ? AND post_id = ? AND expires > ? AND (?=1 OR uploader_id=?)")
    .bind(id, postId, Math.floor(Date.now() / 1000), Number(actor.admin), actor.id).first();
  if (!pending) return new Response(null, { status: 404 });
  const object = await env.BUCKET.get(photoKeys(id)[1]);
  return object ? new Response(object.body, { headers: {
    "Content-Type": "image/webp", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  } }) : new Response(null, { status: 404 });
}
