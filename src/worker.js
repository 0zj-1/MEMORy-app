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

function aiEnabled(env) {
  return env.AI_ENABLED === "true" && !!env.OPENAI_API_KEY;
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

/* The Workers free plan allows about 10 ms of CPU per request, so large bodies are forwarded, never parsed or re-encoded. */
async function requestImage(env, request, buffer, type) {
  const style = await env.ASSETS.fetch(new Request(new URL("/assets/style_ref.jpg", request.url)));
  if (!style.ok) throw new Error("style reference is missing");
  const form = new FormData();
  form.append("model", env.IMAGE_MODEL);
  form.append("prompt", IMAGE_PROMPT);
  form.append("image[]", new File([buffer], "photo.jpg", { type }));
  form.append("image[]", new File([await style.arrayBuffer()], "style.jpg", { type: "image/jpeg" }));
  form.append("size", "1024x1024");
  form.append("quality", env.IMAGE_QUALITY);
  form.append("background", "transparent");
  form.append("output_format", "png");
  return fetch(`${env.OPENAI_BASE}/images/edits`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
}

async function convert(request, env) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const type = (request.headers.get("content-type") || "").split(";")[0];
  if (!ACCEPTED.includes(type)) return json({ error: "bad_type" }, 415);
  if (Number(request.headers.get("content-length")) > MAX_UPLOAD) return json({ error: "too_large" }, 413);

  const { success } = await env.BURST.limit({ key: clientIp(request) });
  if (!success) return json({ error: "too_fast" }, 429);
  const u = await usage(env, request);
  if (u.all >= u.dailyMax || u.ip >= u.ipMax) return json({ error: "daily_limit" }, 429);

  const buffer = await request.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > MAX_UPLOAD) return json({ error: "too_large" }, 413);
  await addUse(env, u, 1);

  let upstream;
  try {
    upstream = await requestImage(env, request, buffer, type);
  } catch (e) {
    await addUse(env, u, 0); // a failed generation gives the use back
    console.error("convert network failure", e.message);
    return json({ error: "upstream_network" }, 502);
  }
  if (upstream.ok) {
    return new Response(upstream.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  await addUse(env, u, 0);
  const err = await upstream.json().catch(() => ({}));
  console.error("convert failed", upstream.status, err.error?.code, err.error?.message);
  const refused = upstream.status === 400 && /moderation|safety/i.test(`${err.error?.code} ${err.error?.message}`);
  return json({ error: refused ? "refused" : `upstream_${upstream.status}` }, refused ? 422 : 502);
}

/* Name and footprint are a nicety, so a failure here only leaves the defaults. The page sends the photo as a data URL. */
async function describe(request, env) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  if (Number(request.headers.get("content-length")) > MAX_UPLOAD * 1.4) return json({ error: "too_large" }, 413);
  const dataUrl = await request.text();
  if (!dataUrl.startsWith("data:image/")) return json({ error: "bad_type" }, 415);
  const body = `{"model":${JSON.stringify(env.TEXT_MODEL)},"store":false,"text":{"format":{"type":"json_object"}},"input":[{"role":"user","content":[{"type":"input_text","text":${JSON.stringify(META_PROMPT)}},{"type":"input_image","detail":"low","image_url":"${dataUrl.replace(/[^A-Za-z0-9+/=:;,\-]/g, "")}"}]}]}`;
  const r = await fetch(`${env.OPENAI_BASE}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body,
  });
  if (!r.ok) {
    console.error("describe failed", r.status);
    return json({ error: `upstream_${r.status}` }, 502);
  }
  return new Response(r.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function guard(request, env) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "forbidden" }, 403);
  if (!aiEnabled(env)) return json({ error: "not_configured" }, 503);
  return null;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/status") {
      if (!aiEnabled(env)) return json({ enabled: false });
      const u = await usage(env, request);
      return json({ enabled: true, left: Math.max(0, Math.min(u.dailyMax - u.all, u.ipMax - u.ip)) });
    }
    if (pathname === "/api/convert") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      return convert(request, env);
    }
    if (pathname === "/api/describe") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      return describe(request, env);
    }
    if (pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
