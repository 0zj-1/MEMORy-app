/* Serves the demo and turns a scanned photo into a game item with OpenAI. The API key stays here on the server. */

const IMAGE_PROMPT = `Image 1 is a photo of someone's real keepsake. Image 2 is the style reference from a cozy isometric room-decorating game.

First identify the single main subject of image 1: the one keepsake the photo is about. Then redraw only that subject as one game item, in exactly the art style of image 2: warm hand-illustrated look, soft cream, brown, olive and amber tones, clean dark brown outlines with rounded joins, simple shading on each surface.

Keep what makes this particular object recognisable: its real shape, colours, proportions and visible details. If it is a photograph or a print, draw it as a printed photo with a simplified picture. Show it in a 3/4 isometric view from above, as if it stands on the floor of an isometric room.

Remove everything that is not the subject: hands, table, floor, wall, other objects, cast shadows and the whole background. Every pixel outside the subject's outline must be fully transparent. Centre the subject, let it fill most of the canvas, with its base near the bottom edge. No added text or logos, and nothing copied from image 2.`;

const META_PROMPT = `The image shows an old keepsake someone scanned for a room-decorating game. Reply with only this JSON:
{"name": "the object in Simplified Chinese, at most 8 characters", "footprint": [w, d], "height": h, "small": true or false, "question": "one gentle question in Simplified Chinese that invites the owner to tell the story of this object"}
footprint and height are whole numbers of floor cells from 1 to 5, where one cell is about 40 cm: a photo or book is [1,1] height 1, a chair [2,2] height 2, a wardrobe [3,1] height 5. small is true if it would naturally stand on a table.`;

const MAX_UPLOAD = 6 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "local";
}

async function readCount(env, key) {
  return Number(await env.USAGE.get(key)) || 0;
}

/* Daily caps cap the bill: KV counts can drift slightly under load, so the limits are set with margin. */
async function usage(env, request) {
  const day = dayKey();
  const allKey = `all:${day}`;
  const ipKey = `ip:${day}:${clientIp(request)}`;
  const [all, ip] = await Promise.all([readCount(env, allKey), readCount(env, ipKey)]);
  return { allKey, ipKey, all, ip, dailyMax: Number(env.DAILY_LIMIT), ipMax: Number(env.IP_DAILY_LIMIT) };
}

async function addUse(env, u, delta) {
  const ttl = { expirationTtl: 60 * 60 * 48 };
  await Promise.all([
    env.USAGE.put(u.allKey, String(Math.max(0, u.all + delta)), ttl),
    env.USAGE.put(u.ipKey, String(Math.max(0, u.ip + delta)), ttl),
  ]);
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function makeImage(env, request, photo) {
  const style = await env.ASSETS.fetch(new Request(new URL("/assets/style_ref.png", request.url)));
  if (!style.ok) throw new Error("style reference is missing");
  const form = new FormData();
  form.append("model", env.IMAGE_MODEL);
  form.append("prompt", IMAGE_PROMPT);
  form.append("image[]", photo, "photo.jpg");
  form.append("image[]", new File([await style.arrayBuffer()], "style.png", { type: "image/png" }));
  form.append("size", "1024x1024");
  form.append("quality", env.IMAGE_QUALITY);
  form.append("background", "transparent");
  form.append("output_format", "png");
  const r = await fetch(`${env.OPENAI_BASE}/images/edits`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    const e = new Error(err.error?.message || `image request failed: ${r.status}`);
    e.status = r.status;
    e.code = err.error?.code;
    throw e;
  }
  const data = await r.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("no image in the response");
  return `data:image/png;base64,${b64}`;
}

/* Name and footprint are a nicety: the image still counts if this call fails. */
async function describe(env, photoBase64, type) {
  try {
    const r = await fetch(`${env.OPENAI_BASE}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: env.TEXT_MODEL,
        input: [{ role: "user", content: [
          { type: "input_text", text: META_PROMPT },
          { type: "input_image", image_url: `data:${type};base64,${photoBase64}`, detail: "low" },
        ] }],
        text: { format: { type: "json_object" } },
        store: false,
      }),
    });
    if (!r.ok) return {};
    const data = await r.json();
    const text = data.output?.flatMap((o) => o.content || []).find((c) => c.type === "output_text")?.text;
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

async function convert(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) return json({ error: "forbidden" }, 403);
  if (!env.OPENAI_API_KEY) return json({ error: "not_configured" }, 503);

  const type = (request.headers.get("content-type") || "").split(";")[0];
  if (!ACCEPTED.includes(type)) return json({ error: "bad_type" }, 415);
  const size = Number(request.headers.get("content-length"));
  if (size > MAX_UPLOAD) return json({ error: "too_large" }, 413);

  const { success } = await env.BURST.limit({ key: clientIp(request) });
  if (!success) return json({ error: "too_fast" }, 429);
  const u = await usage(env, request);
  if (u.all >= u.dailyMax || u.ip >= u.ipMax) return json({ error: "daily_limit" }, 429);

  const buffer = await request.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > MAX_UPLOAD) return json({ error: "too_large" }, 413);
  await addUse(env, u, 1);

  try {
    const photo = new File([buffer], "photo.jpg", { type });
    const [sprite, meta] = await Promise.all([makeImage(env, request, photo), describe(env, base64(buffer), type)]);
    return json({ sprite, ...meta, model: env.IMAGE_MODEL });
  } catch (e) {
    await addUse(env, u, 0); // a failed generation gives the use back
    console.error("convert failed", e.status, e.code, e.message);
    const refused = e.status === 400 && /moderation|safety/i.test(`${e.code} ${e.message}`);
    return json({ error: refused ? "refused" : "upstream" }, refused ? 422 : 502);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/status") {
      if (!env.OPENAI_API_KEY) return json({ enabled: false });
      const u = await usage(env, request);
      return json({ enabled: true, left: Math.max(0, Math.min(u.dailyMax - u.all, u.ipMax - u.ip)) });
    }
    if (pathname === "/api/convert") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      return convert(request, env);
    }
    if (pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
