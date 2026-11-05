/* Serves the demo and turns a scanned photo into a game item with Cloudflare Workers AI. */

const IMAGE_PROMPT = `Image 1 is a photo of someone's real keepsake. Image 2 is the style reference from a cozy isometric room-decorating game.

Identify the single main subject of image 1 and redraw only that object as one game item, in exactly the illustrated art style of image 2: warm hand-illustrated cartoon look, soft cream, brown, olive and amber tones, clean dark brown outlines, simple shading. Not a photograph.

Keep what makes this object recognisable: its real shape, colours, proportions and visible details. Show it in a 3/4 isometric view from above.

Remove everything else: hands, table, floor, wall, other objects and the whole original background. Draw no shadow of any kind: no ground shadow, no drop shadow. Place the single object in the centre on a pure solid white background, with a clear margin all around it. No text, no logos, nothing copied from image 2.`;

const META_PROMPT = `This photo shows an old keepsake someone scanned for a room-decorating game. Reply with only this JSON and nothing else:
{"name": "the object in Simplified Chinese, at most 8 characters", "footprint": [w, d], "height": h, "small": true or false, "question": "one gentle question in Simplified Chinese that invites the owner to tell the story of this object"}
footprint and height are whole numbers of floor cells from 1 to 5, where one cell is about 40 cm: a photo or book is [1,1] height 1, a chair [2,2] height 2, a wardrobe [3,1] height 5. small is true if it would naturally stand on a table.`;

const MAX_UPLOAD = 3 * 1024 * 1024;
const MAX_THUMB = 300 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function aiEnabled(env) {
  return env.AI_ENABLED === "true";
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

/* The daily caps keep use inside the free Neuron allowance. KV counts can drift slightly under load. */
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

function guard(request, env) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "forbidden" }, 403);
  if (!aiEnabled(env)) return json({ error: "not_configured" }, 503);
  return null;
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

  try {
    const style = await env.ASSETS.fetch(new Request(new URL("/assets/style_ref.jpg", request.url)));
    if (!style.ok) throw new Error("style reference is missing");
    const form = new FormData();
    form.append("prompt", IMAGE_PROMPT);
    form.append("width", "1024");
    form.append("height", "1024");
    form.append("input_image_0", new File([buffer], "photo.jpg", { type }));
    form.append("input_image_1", new File([await style.arrayBuffer()], "style.jpg", { type: "image/jpeg" }));
    const packed = new Response(form);
    const result = await env.AI.run(env.IMAGE_MODEL, { multipart: { body: packed.body, contentType: packed.headers.get("content-type") } });
    if (!result?.image) throw new Error("no image in the response");
    return json({ image: result.image });
  } catch (e) {
    await addUse(env, u, 0); // a failed generation gives the use back
    console.error("convert failed", e.message);
    return json({ error: /quota|neuron|limit/i.test(e.message) ? "ai_quota" : "ai_failed" }, 502);
  }
}

/* Name and footprint are a nicety: the page keeps its defaults if this fails. It takes a small thumbnail as a data URL. */
async function describe(request, env) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  if (Number(request.headers.get("content-length")) > MAX_THUMB) return json({ error: "too_large" }, 413);
  const dataUrl = await request.text();
  if (!dataUrl.startsWith("data:image/")) return json({ error: "bad_type" }, 415);
  try {
    const result = await env.AI.run(env.TEXT_MODEL, {
      messages: [{ role: "user", content: [{ type: "text", text: META_PROMPT }, { type: "image_url", image_url: { url: dataUrl } }] }],
      max_tokens: 900,
      chat_template_kwargs: { enable_thinking: false },
    });
    return json({ text: result?.choices?.[0]?.message?.content ?? result?.response ?? "" });
  } catch (e) {
    console.error("describe failed", e.message);
    return json({ error: "ai_failed" }, 502);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/status") {
      if (!aiEnabled(env)) return json({ enabled: false });
      const u = await usage(env, request);
      return json({ enabled: true, left: Math.max(0, Math.min(u.dailyMax - u.all, u.ipMax - u.ip)) });
    }
    if (pathname === "/api/convert" || pathname === "/api/describe") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      return pathname === "/api/convert" ? convert(request, env) : describe(request, env);
    }
    if (pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
