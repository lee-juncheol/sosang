// Cloudflare supplies this country code; no IP address or location is stored.
// Missing geolocation lets the browser apply its own language fallback.
export function localeForCountry(country) {
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country) || country === 'XX') return null;
  return country === 'KR' ? 'ko' : 'en';
}

// Origins of the sosang desktop app's WebView (macOS/Linux, then Windows). Static files allow
// any origin through _headers; this list is for responses the Worker builds itself.
// Only functions and the default handler may be exported: workerd treats every named export
// as an entrypoint and refuses to start on a constant.
const APP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

export function isAppOrigin(origin) {
  return APP_ORIGINS.includes(origin);
}

// Update information for the desktop app's updater. The release step publishes the file as a
// static asset; until there is one, 204 tells the updater there is no update.
const APP_UPDATE_PATH = '/app/latest.json';

const READ_ONLY = 'GET, HEAD';

function methodNotAllowed(headers) {
  return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', Allow: READ_ONLY },
  });
}

function locale(request) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  };
  const origin = request.headers.get('Origin');
  if (origin && isAppOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(headers);
  // Do not trust query parameters or caller-supplied country/language headers.
  const body = JSON.stringify({ locale: localeForCountry(request.cf?.country) });
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}

async function appUpdate(request, env) {
  const headers = { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(headers);
  // Ask the asset store for the file itself; query strings and caller headers are not passed on.
  const asset = await env.ASSETS.fetch(new Request(new URL(APP_UPDATE_PATH, request.url), { method: request.method }));
  if (asset.status === 404) return new Response(null, { status: 204, headers });
  if (!asset.ok) return new Response(null, { status: 502, headers });
  return new Response(request.method === 'HEAD' ? null : asset.body, {
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...(asset.headers.get('ETag') ? { ETag: asset.headers.get('ETag') } : {}) },
  });
}

// Messages from the in-app and on-site contact form. Each one is kept in the CONTACT KV store for
// CONTACT_TTL_DAYS and, when CONTACT_WEBHOOK (a Discord webhook URL secret) is set, also posted
// there. The caller's IP address is used only as the rate-limit key and is not stored.
// wrangler.jsonc: CONTACT has no namespace id, so wrangler creates it on the first deploy;
// CONTACT_LIMIT allows 3 messages a minute from one address.
const CONTACT_PATH = '/api/contact';
const CONTACT_TTL_DAYS = 180;
const CONTACT_MAX_BODY = 16 * 1024;
const CONTACT_LIMITS = { message: 4000, email: 200, field: 80 };
const CONTEXT_FIELDS = ['source', 'version', 'os', 'camera', 'firmware', 'locale'];

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

function cleanText(value, max, { multiline = false } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFC').replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, '').trim();
  return text.length > max ? null : text;
}

/** The fields kept from a contact request, or null when it is not acceptable. */
export function contactMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const message = cleanText(input.message, CONTACT_LIMITS.message, { multiline: true });
  if (!message || message.length < 5) return null;
  const email = cleanText(input.email, CONTACT_LIMITS.email);
  if (email === null || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return null;
  const context = {};
  const given = input.context && typeof input.context === 'object' && !Array.isArray(input.context) ? input.context : {};
  for (const field of CONTEXT_FIELDS) {
    const value = cleanText(given[field], CONTACT_LIMITS.field);
    if (value === null) return null;
    if (value) context[field] = value;
  }
  return { message, ...(email ? { email } : {}), context };
}

function webhookText(entry) {
  const facts = Object.entries(entry.context).map(([key, value]) => `${key}: ${value}`).join(' · ');
  const text = [`sosang 문의 ${entry.received}`, facts, entry.email ? `reply: ${entry.email}` : 'reply: (none)', '', entry.message].join('\n');
  return text.length > 1900 ? `${text.slice(0, 1900)}…` : text;
}

async function contact(request, env, ctx) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
  const origin = request.headers.get('Origin');
  const sameSite = origin === new URL(request.url).origin;
  if (origin && isAppOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  if (request.method === 'OPTIONS' && headers['Access-Control-Allow-Origin']) {
    return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { ...headers, Allow: 'POST' });
  // Only this site and the desktop app may send; other pages cannot post on a visitor's behalf.
  if (!sameSite && !isAppOrigin(origin)) return json({ error: 'forbidden' }, 403, headers);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'bad_request' }, 415, headers);
  if (!env.CONTACT) return json({ error: 'unavailable' }, 503, headers);
  if (env.CONTACT_LIMIT) {
    const key = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.CONTACT_LIMIT.limit({ key });
    if (!success) return json({ error: 'rate_limited' }, 429, headers);
  }
  const raw = await request.text();
  if (raw.length > CONTACT_MAX_BODY) return json({ error: 'bad_request' }, 413, headers);
  let input;
  try { input = JSON.parse(raw); } catch { return json({ error: 'bad_request' }, 400, headers); }
  // Hidden field that people never see; forms that fill it in are bots. Answer as if it worked.
  if (input && typeof input === 'object' && input.website) return json({ ok: true }, 200, headers);
  const fields = contactMessage(input);
  if (!fields) return json({ error: 'bad_request' }, 400, headers);
  const received = new Date().toISOString();
  const entry = { received, ...fields };
  const id = `${received}-${crypto.randomUUID().slice(0, 8)}`;
  await env.CONTACT.put(`msg:${id}`, JSON.stringify(entry), { expirationTtl: CONTACT_TTL_DAYS * 86400 });
  if (env.CONTACT_WEBHOOK) {
    const post = fetch(env.CONTACT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: webhookText(entry), allowed_mentions: { parse: [] } }),
    }).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(post); else await post;
  }
  return json({ ok: true }, 200, headers);
}

// Anonymous camera usage from the desktop app: which body and firmware it reached and whether
// reads and writes worked. Rows hold no serial, device id, IP address, file name or photo; the
// app sends each distinct row at most once a day. Stored in the USAGE D1 database (created on
// the first deploy, like CONTACT); USAGE_LIMIT allows 30 rows a minute from one address.
const USAGE_PATH = '/api/usage';
const USAGE_EVENTS = ['status', 'list', 'register', 'delete', 'rearrange', 'restore', 'card_list', 'card_register'];
const USAGE_SUPPORT = ['supported', 'experimental', 'unsupported'];
const USAGE_TEXT = /^[\w .()/+-]{1,40}$/;

/** The row kept from a usage report, or null when it is not acceptable. */
export function usageRow(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { event, model = '', firmware = '', support = '', result, ms, version, os = '' } = input;
  if (!USAGE_EVENTS.includes(event)) return null;
  if (typeof result !== 'string' || !/^[a-z_]{1,40}$/.test(result)) return null;
  if (!Number.isInteger(ms) || ms < 0 || ms > 3_600_000) return null;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  for (const text of [model, firmware, os]) if (typeof text !== 'string' || (text && !USAGE_TEXT.test(text))) return null;
  if (support && !USAGE_SUPPORT.includes(support)) return null;
  return { event, model, firmware, support, result, ms, version, os };
}

let usageTableReady = false;
async function usage(request, env) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
  const origin = request.headers.get('Origin');
  if (isAppOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  if (request.method === 'OPTIONS' && isAppOrigin(origin)) {
    return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { ...headers, Allow: 'POST' });
  if (!isAppOrigin(origin)) return json({ error: 'forbidden' }, 403, headers);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'bad_request' }, 415, headers);
  if (!env.USAGE) return json({ error: 'unavailable' }, 503, headers);
  if (env.USAGE_LIMIT) {
    const { success } = await env.USAGE_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return json({ error: 'rate_limited' }, 429, headers);
  }
  const raw = await request.text();
  if (raw.length > 2048) return json({ error: 'bad_request' }, 413, headers);
  let row;
  try { row = usageRow(JSON.parse(raw)); } catch { row = null; }
  if (!row) return json({ error: 'bad_request' }, 400, headers);
  if (!usageTableReady) {
    await env.USAGE.prepare('CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, received TEXT NOT NULL, event TEXT NOT NULL, model TEXT, firmware TEXT, support TEXT, result TEXT NOT NULL, ms INTEGER, version TEXT, os TEXT)').run();
    usageTableReady = true;
  }
  await env.USAGE.prepare('INSERT INTO usage (received, event, model, firmware, support, result, ms, version, os) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), row.event, row.model, row.firmware, row.support, row.result, row.ms, row.version, row.os).run();
  return json({ ok: true }, 200, headers);
}

// LUT downloads from the website and the app: the saved file's name (which film look, print and
// format), whether the server's file or a browser-made one was saved, and where. One row per
// saved file; no IP address or anything else about the person. Same USAGE database and
// USAGE_LIMIT as camera usage.
const DOWNLOAD_PATH = '/api/download';
const DOWNLOAD_KINDS = ['file', 'made'];
const DOWNLOAD_SOURCES = ['web', 'app'];

/** The row kept from a download report, or null when it is not acceptable. */
export function downloadRow(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { lut, kind, source } = input;
  if (typeof lut !== 'string' || !/^[A-Za-z0-9-]{1,80}\.(cube|zip)$/.test(lut)) return null;
  if (!DOWNLOAD_KINDS.includes(kind) || !DOWNLOAD_SOURCES.includes(source)) return null;
  return { lut, format: lut.endsWith('.zip') ? 'zip' : /VLOG\.cube$/.test(lut) ? 'vlog' : 'std', kind, source };
}

let downloadTableReady = false;
async function download(request, env) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
  const origin = request.headers.get('Origin');
  const allowed = isAppOrigin(origin) || origin === new URL(request.url).origin;
  if (isAppOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  if (request.method === 'OPTIONS' && isAppOrigin(origin)) {
    return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { ...headers, Allow: 'POST' });
  if (!allowed) return json({ error: 'forbidden' }, 403, headers);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'bad_request' }, 415, headers);
  if (!env.USAGE) return json({ error: 'unavailable' }, 503, headers);
  if (env.USAGE_LIMIT) {
    const { success } = await env.USAGE_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return json({ error: 'rate_limited' }, 429, headers);
  }
  const raw = await request.text();
  if (raw.length > 1024) return json({ error: 'bad_request' }, 413, headers);
  let row;
  try { row = downloadRow(JSON.parse(raw)); } catch { row = null; }
  if (!row) return json({ error: 'bad_request' }, 400, headers);
  if (!downloadTableReady) {
    await env.USAGE.prepare('CREATE TABLE IF NOT EXISTS downloads (id INTEGER PRIMARY KEY, received TEXT NOT NULL, lut TEXT NOT NULL, format TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL)').run();
    downloadTableReady = true;
  }
  await env.USAGE.prepare('INSERT INTO downloads (received, lut, format, kind, source) VALUES (?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), row.lut, row.format, row.kind, row.source).run();
  return json({ ok: true }, 200, headers);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/locale') return locale(request);
    if (pathname === CONTACT_PATH) return contact(request, env, ctx);
    if (pathname === USAGE_PATH) return usage(request, env);
    if (pathname === DOWNLOAD_PATH) return download(request, env);
    if (pathname === APP_UPDATE_PATH) return appUpdate(request, env);
    return env.ASSETS.fetch(request);
  },
};
