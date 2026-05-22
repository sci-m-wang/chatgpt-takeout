# chatgpt-takeout

> Export your ChatGPT conversations &mdash; including every image, attachment,
> and DALL·E generation &mdash; to a self-contained, browsable HTML archive.
> Everything stays in your browser.

🌐 **Web UI:** <https://sci-m-wang.github.io/chatgpt-takeout/>
🐚 **CLI:** [`scripts/chatgpt_takeout.py`](./scripts/chatgpt_takeout.py)
☁️ **CORS proxy:** [`worker/`](./worker/) (deploy your own in 60 seconds)

---

## Why

ChatGPT's official **Settings → Data Controls → Export Data** ships you a zip
hours later, and the included HTML viewer is barely usable. This project gives
you:

- a **live** export &mdash; runs against the same `chatgpt.com/backend-api`
  the web app uses, so you get whatever is in your account right now;
- **images, DALL·E generations, and user uploads** downloaded as real files;
- a clean **HTML archive** (one page per conversation, plus an index) that
  reads like the ChatGPT UI;
- two ways to run it: a **static web page** (no install) or a **Python CLI**.

## How it works

```text
                ┌────────────────────────┐
   You ──cURL──▶│   Static web page      │
                │ (GitHub Pages, JS)     │
                └──────────┬─────────────┘
                           │ HTTPS
                ┌──────────▼─────────────┐
                │  Your Cloudflare       │  (you deploy this; tiny, stateless,
                │  Worker (CORS proxy)   │   forwards only /backend-api/*)
                └──────────┬─────────────┘
                           │
                  https://chatgpt.com
```

The web page parses a request you copied from your browser (so it has your
Authorization header and cookies), proxies the calls through **your own**
Cloudflare Worker (free tier is plenty), and downloads/renders/zips everything
locally. The proxy exists only because `chatgpt.com` does not send CORS
headers; nothing about your data ever touches a server you do not control.

---

## Option A — Web UI (recommended)

### Prerequisites

1. A free Cloudflare account.
2. Node.js (only to run Cloudflare's `wrangler` CLI once).

### Steps

1. **Deploy the Worker.** From this repo:

   ```bash
   cd worker
   npm install -g wrangler
   wrangler login
   wrangler deploy
   ```

   You will get a URL like `https://chatgpt-takeout-proxy.<account>.workers.dev`.

2. **Open the web UI:** <https://sci-m-wang.github.io/chatgpt-takeout/>

3. Paste the Worker URL into **Proxy URL**.

4. Open [chatgpt.com](https://chatgpt.com) signed in →  DevTools → **Network** →
   reload → find a request to `/backend-api/conversations` → right-click →
   **Copy** → **Copy as cURL**. Paste it into the **cURL** box.

5. Click **Start export**. When it finishes, click **Download archive (.zip)**
   or **Open index in new tab** to preview.

The zip contains:

```text
chatgpt-takeout-YYYY-MM-DD.zip
├── index.json                       # raw conversation list
├── conversations/<title>_<id>.json  # raw conversation bodies
├── assets/<file_id>.<ext>           # all images and attachments
└── html/
    ├── index.html                   # browse the archive
    └── <title>_<id>.html
```

> **Privacy:** the only network calls from your browser are
> `your-page → your-worker → chatgpt.com`. No analytics, no third-party
> requests, no logging. See [`worker/src/index.js`](./worker/src/index.js).

### Tighten the Worker (recommended)

Edit `worker/wrangler.toml` and uncomment:

```toml
[vars]
ALLOWED_ORIGIN = "https://sci-m-wang.github.io"
```

Redeploy. Now only the GitHub Pages site can use your proxy.

---

## Option B — Python CLI

If you would rather skip the proxy:

```bash
# 1) Save the cURL into a file
pbpaste > request.curl     # macOS; or just edit the file

# 2) Run
pip install -r scripts/requirements.txt
python scripts/chatgpt_takeout.py request.curl ./out
```

Output:

```text
out/
├── index.json
├── conversations/<title>_<id>.json
├── assets/<file_id>.<ext>
└── html/index.html …
```

Flags: `--skip-assets`, `--skip-render`, `--rate 0.5`, `--limit 100`.

---

## FAQ

**Will my cookies / tokens leak?**
The web page never sends them anywhere except to the Worker URL you control.
The Worker itself is &lt;100 lines of JavaScript (auditable in
[`worker/src/index.js`](./worker/src/index.js)), holds no state, and writes no
logs.

**Why not just call `chatgpt.com` directly from the page?**
`chatgpt.com` does not return `Access-Control-Allow-Origin`, so the browser
blocks the response. A proxy on your own subdomain is the only way without a
browser extension.

**Some `file_xxx` items show as "missing" — why?**
ChatGPT keeps some files (especially sandbox/Canvas intermediates) only for a
limited window. Once expired, they cannot be recovered. User-uploaded files
and DALL·E generations are usually persistent.

**How fast is it?**
Pace is intentionally throttled (~1s between calls) so you do not trip rate
limits. Expect roughly 1&nbsp;minute per 50 conversations.

---

## Contributing

PRs welcome. See [CONTRIBUTORS.md](./CONTRIBUTORS.md) for current credits.

## License

MIT — see [LICENSE](./LICENSE). © 2026 KinaMind.
