# Cloudflare Worker — CORS Proxy

The web UI needs to call `https://chatgpt.com/backend-api/*` from the browser,
which is blocked by CORS. This tiny Worker forwards the request and adds
permissive CORS headers. It does **not** read, log, store, or modify the
authorization headers or response bodies.

## Deploy in 60 seconds

1. Install Wrangler (Cloudflare's CLI) and sign in to your Cloudflare account
   (the free tier is enough):

   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. From this directory:

   ```bash
   wrangler deploy
   ```

3. Wrangler prints a URL like `https://chatgpt-takeout-proxy.<account>.workers.dev`.
   Paste it into the Proxy URL field of the web UI.

## Tighten security (recommended)

Edit `wrangler.toml` and uncomment the `[vars]` block, setting
`ALLOWED_ORIGIN` to the GitHub Pages origin that should be allowed to use
the proxy:

```toml
[vars]
ALLOWED_ORIGIN = "https://your-username.github.io"
```

Then redeploy:

```bash
wrangler deploy
```

Other origins will be refused.

## What the Worker does

- Accepts only `/backend-api/*` paths
- Forwards method, query string, body, and request headers untouched to
  `chatgpt.com` (so your Authorization header travels straight through)
- Strips response headers that would break CORS in the browser
  (`Set-Cookie`, CSP, etc.)
- Adds `Access-Control-Allow-Origin` etc. on the way back

## What it does **not** do

- It does **not** persist anything
- It does **not** read the request body or Authorization header
- It is not a public service; **you** deploy and own it
