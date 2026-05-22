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
                │  Cloudflare Worker     │  (official one is pre-deployed and
                │  (CORS proxy)          │   ready; you can self-host instead)
                └──────────┬─────────────┘
                           │
                  https://chatgpt.com
```

The web page parses a request you copied from your browser (so it has your
Authorization header and cookies), proxies the calls through a Cloudflare
Worker (because `chatgpt.com` does not send CORS headers), and
downloads/renders/zips everything **inside your browser**. The Worker is
**stateless** &mdash; it does not log, store, or read your credentials, it only
forwards the bytes. Source: [`worker/src/index.js`](./worker/src/index.js).

---

## Option A — Web UI (recommended)

Just open <https://sci-m-wang.github.io/chatgpt-takeout/> and follow the
on-screen steps:

1. Open [chatgpt.com](https://chatgpt.com) signed in →  DevTools → **Network** →
   reload → find a request to `/backend-api/conversations` → right-click →
   **Copy** → **Copy as cURL**.
2. Paste the whole cURL into the web UI.
3. Click **Start export**. When it finishes, click **Download archive (.zip)**
   or **Open index in new tab** to preview.

The page ships a pre-configured Worker URL so it works out of the box. If you
prefer to run your own proxy (see [Privacy](#privacy)), click *Use my own
proxy instead* in the UI and follow the [worker README](./worker/README.md).

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

## Privacy

The only network calls from your browser are
`your-page → Worker → chatgpt.com`. The default Worker

- holds **no state** (stateless `fetch` forwarder; entire source is
  &lt;100 lines, [auditable here](./worker/src/index.js)),
- writes **no logs** (no `console.log`, no analytics binding),
- is restricted by `ALLOWED_ORIGIN` to the GitHub Pages site, so it cannot
  be used as an open relay,
- and crucially, **never reads** your `Authorization` header &mdash; it just
  passes the bytes upstream.

That said, *in theory* a proxy operator can passively observe headers.
If your threat model rules that out, **self-host in 60 seconds** &mdash; see the
[worker README](./worker/README.md) and click *Use my own proxy instead* in
the web UI.

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
See the [Privacy section](#privacy) above. Short answer: the default proxy is
&lt;100 lines of auditable JS, stateless, log-free, and origin-locked; if you
want zero trust in any third party, self-host the Worker on your own account.

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
