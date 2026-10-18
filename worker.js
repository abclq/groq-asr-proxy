addEventListener("fetch", (event) => {
  event.respondWith(handle(event.request));
});

// ── 配置（通过 wrangler.toml [vars] / secret 注入，勿硬编码真实密钥）──
const AUTH_TOKEN = (globalThis.AUTH_TOKEN || "CHANGE_ME_AUTH_TOKEN");
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const TENCENT_SECRET_ID = (globalThis.TENCENT_SECRET_ID || "");
const TENCENT_SECRET_KEY = (globalThis.TENCENT_SECRET_KEY || "");

async function handle(req) {
  const u = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: C });
  if (u.pathname === "/" || u.pathname === "/health") {
    return j({ ok: true, service: "groq-asr-proxy", mode: "groq_key_pool_then_tencent", groq_keys: getGroqKeys().length });
  }
  if (u.pathname === "/info") {
    return j({
      service: "groq-asr-proxy",
      api_base: "https://" + u.host + "/v1/audio/transcriptions",
      auth: "Bearer " + AUTH_TOKEN,
      routing: ["1.groq (cf-us-egress)", "2.tencent (cloud-asr)", "3.siliconflow (local-fallback-in-caller)"],
      groq_keys: getGroqKeys().length,
      tencent: TENCENT_SECRET_ID ? "enabled" : "not-configured",
      rotate_token: "wrangler secret put AUTH_TOKEN",
      note: "SiliconFlow 3001 is a LOCAL fallback handled by the caller script; this cloud Worker cannot reach 192.168.31.88:3001."
    });
  }
  if (u.pathname === "/debug-keys") {
    const keys = getGroqKeys();
    const results = [];
    for (let i = 0; i < keys.length; i++) {
      try {
        const r = await fetch("https://api.groq.com/openai/v1/models", {
          headers: { Authorization: `Bearer ${keys[i]}` }
        });
        results.push({ idx: i + 1, status: r.status, ok: r.ok, preview: keys[i].substring(0, 8) + "..." });
      } catch (e) {
        results.push({ idx: i + 1, error: e.message, preview: keys[i].substring(0, 8) + "..." });
      }
    }
    return j({ keys_total: keys.length, results });
  }

  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${AUTH_TOKEN}`) return j({ error: "unauthorized" }, 401);

  let path = u.pathname;
  if (path === "/models") path = "/v1/models";
  if (path.startsWith("/audio/")) path = "/v1" + path;
  if (!path.startsWith("/v1/")) return j({ error: "not_found" }, 404);
  if (path === "/v1/models") return j({ object: "list", data: [{ id: GROQ_MODEL, object: "model", owned_by: "groq/tencent" }] });

  if (path === "/v1/audio/transcriptions") {
    try {
      const rawBody = await req.arrayBuffer();
      const contentType = req.headers.get("content-type") || "";

      // 1) Try Groq (CF US egress): forward raw multipart body with each key
      const keys = getGroqKeys();
      const groqErrors = [];
      for (let i = 0; i < keys.length; i++) {
        try {
          const r = await fetch(GROQ_URL, {
            method: "POST",
            headers: { "Authorization": `Bearer ${keys[i]}`, "Content-Type": contentType },
            body: rawBody
          });
          const text = await r.text();
          if (r.ok) {
            let data = {};
            try { data = JSON.parse(text); } catch (_) {}
            const transcript = String(data.text || data.transcript || "").trim();
            if (transcript) return j({ text: transcript, provider: `groq-${i + 1}` });
          }
          groqErrors.push({ idx: i + 1, status: r.status, body: text.substring(0, 200) });
        } catch (e) {
          groqErrors.push({ idx: i + 1, error: e.message });
        }
      }

      // 2) Fallback to Tencent (cloud ASR): extract audio from raw multipart
      if (TENCENT_SECRET_ID && TENCENT_SECRET_KEY) {
        const boundary = contentType.match(/boundary=(.+)/)?.[1] || "";
        let audioBytes = rawBody;
        let audioName = "audio.wav";
        if (boundary) {
          const result = extractFileFromMultipart(rawBody, boundary);
          if (result) { audioBytes = result.data; audioName = result.filename || "audio.wav"; }
        }
        const tenResult = await transcribeTencent(audioBytes, audioName);
        tenResult.groq_errors = groqErrors;
        return j(tenResult);
      }

      // 3) No cloud fallback available — return Groq errors so caller can try local SiliconFlow
      return j({ error: "all_providers_failed", groq_errors: groqErrors, hint: "caller should fallback to local SiliconFlow 3001" }, 502);
    } catch (e) {
      return j({ error: "worker_error", msg: String((e && e.message) || e) }, 500);
    }
  }
  return j({ error: "not_supported" }, 404);
}

function extractFileFromMultipart(rawBody, boundary) {
  const u8 = new Uint8Array(rawBody);
  const boundaryBytes = new TextEncoder().encode("--" + boundary);
  const crlf = new Uint8Array([13, 10]);
  const doubleCrlf = new Uint8Array([13, 10, 13, 10]);
  let pos = indexOf(u8, boundaryBytes, 0);
  if (pos === -1) return null;
  pos += boundaryBytes.length;
  if (pos + 2 > u8.length) return null;
  if (u8[pos] === 13 && u8[pos + 1] === 10) pos += 2;
  else if (u8[pos] === 45 && u8[pos + 1] === 45) pos += 2;
  const headerEnd = indexOf(u8, doubleCrlf, pos);
  if (headerEnd === -1) return null;
  const headerBytes = u8.slice(pos, headerEnd);
  const headerText = new TextDecoder().decode(headerBytes);
  const nameMatch = headerText.match(/name="([^"]+)"/);
  const filenameMatch = headerText.match(/filename="([^"]+)"/);
  const contentTypeMatch = headerText.match(/Content-Type:\s*(.+)/i);
  const dataStart = headerEnd + 4;
  const nextBoundary = indexOf(u8, boundaryBytes, dataStart);
  if (nextBoundary === -1) return null;
  let dataEnd = nextBoundary - 2;
  if (dataEnd > 0 && u8[dataEnd - 1] === 13 && u8[dataEnd] === 10) dataEnd -= 2;
  const fileData = u8.slice(dataStart, dataEnd);
  return {
    name: nameMatch ? nameMatch[1] : "file",
    filename: filenameMatch ? filenameMatch[1] : null,
    contentType: contentTypeMatch ? contentTypeMatch[1].trim() : null,
    data: fileData.buffer
  };
}

function indexOf(haystack, needle, start) {
  for (let i = start; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

function getGroqKeys() {
  const raw = (globalThis.GROQ_KEYS || "").trim();
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String).map(x => x.trim()).filter(Boolean);
  } catch (_) {}
  return raw.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
}

async function transcribeTencent(audioBytes, name) {
  if (!TENCENT_SECRET_ID || !TENCENT_SECRET_KEY) return { text: "", provider: "tencent", error: "tencent_not_configured" };
  const u8 = new Uint8Array(audioBytes);
  const base64 = chunkedBase64(u8);
  const fmt = name.indexOf("wav") >= 0 ? "wav" : name.indexOf("mp3") >= 0 ? "mp3" : name.indexOf("m4a") >= 0 ? "m4a" : name.indexOf("ogg") >= 0 ? "ogg-opus" : "mp3";
  const payload = JSON.stringify({ ProjectId: 0, SubServiceType: 2, EngSerViceType: "16k_zh", SourceType: 1, VoiceFormat: fmt, UsrAudioKey: crypto.randomUUID(), Data: base64, DataLen: audioBytes.byteLength });
  const host = "asr.tencentcloudapi.com", region = "ap-shanghai", action = "SentenceRecognition", ver = "2019-06-14";
  const ts = Math.floor(Date.now() / 1e3), dt = new Date(ts * 1e3).toISOString().slice(0, 10);
  const hp = await sha256Hex(payload);
  const cr = "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:" + host + "\nx-tc-action:" + action.toLowerCase() + "\n\ncontent-type;host;x-tc-action\n" + hp;
  const cs = dt + "/asr/tc3_request";
  const sd = await hmac("TC3" + TENCENT_SECRET_KEY, dt), ss = await hmac(sd, "asr"), ssi = await hmac(ss, "tc3_request");
  const sig = await hmacHex(ssi, "TC3-HMAC-SHA256\n" + ts + "\n" + cs + "\n" + (await sha256Hex(cr)));
  const resp = await fetch("https://" + host, {
    method: "POST",
    headers: {
      "Authorization": "TC3-HMAC-SHA256 Credential=" + TENCENT_SECRET_ID + "/" + cs + ", SignedHeaders=content-type;host;x-tc-action, Signature=" + sig,
      "Content-Type": "application/json; charset=utf-8", "Host": host, "X-TC-Action": action, "X-TC-Timestamp": String(ts), "X-TC-Version": ver, "X-TC-Region": region
    },
    body: payload
  });
  if (!resp.ok) return { text: "", provider: "tencent", error: "tencent_api_failed", status: resp.status };
  const data = await resp.json();
  const result = (data.Response && data.Response.Result) || "";
  const err = (data.Response && data.Response.Error) || null;
  return { text: result, provider: "tencent", tencent_error: err };
}

function chunkedBase64(u8) {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

const C = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type" };
function j(o, s) { return new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json; charset=utf-8", ...C } }); }
async function sha256Hex(s) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function hmac(k, m) { const r = typeof k === "string" ? new TextEncoder().encode(k) : k; return crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", r, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(m)); }
async function hmacHex(k, m) { return hex(await hmac(k, m)); }
function hex(b) { return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join(""); }
