/**
 * chatgpt-takeout CORS proxy
 *
 * A minimal Cloudflare Worker that forwards requests to
 * https://chatgpt.com/backend-api/* and re-emits them with permissive CORS
 * headers, so the static web page can call the ChatGPT API directly from
 * the browser.
 *
 * SECURITY:
 *   - This Worker is stateless: no cookies, tokens or response bodies are
 *     logged or stored.
 *   - It only forwards requests to chatgpt.com; any other host is rejected.
 *   - Optional ALLOWED_ORIGIN var restricts which web origin can use it.
 *
 * Deploy:
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler deploy
 *   3. Copy the *.workers.dev URL into the web UI settings.
 */

const TARGET = 'https://chatgpt.com';
const ALLOWED_PATH_PREFIX = '/backend-api/';
// Headers we must NOT forward back to the browser (they break CORS).
const STRIP_RESPONSE = new Set([
  'set-cookie',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
]);

function corsHeaders(origin, env) {
  const allowed = env && env.ALLOWED_ORIGIN;
  const allow = allowed && allowed !== '*' ? allowed : (origin || '*');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith(ALLOWED_PATH_PREFIX)) {
      return new Response('Only /backend-api/* is proxied.', {
        status: 400,
        headers: corsHeaders(origin, env),
      });
    }

    // Build upstream request: keep method, body, query, and incoming headers
    // (the browser is responsible for supplying Authorization, Cookie, etc.).
    const upstreamUrl = TARGET + url.pathname + url.search;
    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.delete('host');
    upstreamHeaders.delete('origin');
    upstreamHeaders.set('referer', `${TARGET}/`);
    upstreamHeaders.set('origin', TARGET);

    const init = {
      method: request.method,
      headers: upstreamHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'follow',
    };

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, init);
    } catch (err) {
      return new Response(`Upstream fetch failed: ${err.message || err}`, {
        status: 502,
        headers: corsHeaders(origin, env),
      });
    }

    const respHeaders = new Headers();
    for (const [k, v] of upstream.headers.entries()) {
      if (!STRIP_RESPONSE.has(k.toLowerCase())) respHeaders.set(k, v);
    }
    for (const [k, v] of Object.entries(corsHeaders(origin, env))) {
      respHeaders.set(k, v);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  },
};
