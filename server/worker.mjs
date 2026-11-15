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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/locale') return locale(request);
    if (pathname === APP_UPDATE_PATH) return appUpdate(request, env);
    return env.ASSETS.fetch(request);
  },
};
