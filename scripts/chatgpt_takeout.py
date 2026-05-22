"""chatgpt-takeout: 命令行版

从浏览器复制 ChatGPT 的请求为 cURL，本地解析并下载所有会话、附件，渲染 HTML。

用法:
    1) 浏览器登录 chatgpt.com → DevTools → Network → 找一个 /backend-api/conversations
       请求 → 右键 Copy → Copy as cURL → 存成 request.curl
    2) python -m chatgpt_takeout.cli request.curl ./out

输出目录结构:
    out/
      conversations/<title>_<id>.json   原始会话 JSON
      assets/<file_id>.<ext>            图片与附件
      html/index.html                   会话索引
      html/<title>_<id>.html            每个会话渲染
"""
from __future__ import annotations

import argparse
import glob
import html
import json
import mimetypes
import os
import re
import shlex
import sys
import time
from datetime import datetime
from typing import Iterable
from urllib.parse import urlparse

import requests


# ---------- cURL 解析 ----------

def parse_curl(curl_text: str) -> dict:
    """从 'curl ...' 文本里抽出 headers + cookies。"""
    # 折行处理
    text = re.sub(r"\\\s*\n", " ", curl_text).strip()
    tokens = shlex.split(text)
    if not tokens or tokens[0] != "curl":
        raise ValueError("不像是 cURL 命令，应当以 'curl' 开头")
    headers: dict[str, str] = {}
    cookie = ""
    it = iter(tokens[1:])
    for tok in it:
        if tok in ("-H", "--header"):
            line = next(it)
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip()] = v.strip()
        elif tok in ("-b", "--cookie"):
            cookie = next(it)
        elif tok.startswith("-"):
            # 跳过未知 flag 的值（保守起见，吃一个）
            if tok in ("-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "-A", "--user-agent", "-e", "--referer"):
                next(it, None)
        # 其他位置参数（URL）忽略
    if cookie and "Cookie" not in {k.lower() for k in headers}:
        headers["Cookie"] = cookie
    if "Authorization" not in headers and "authorization" not in headers:
        raise ValueError("cURL 里没有 Authorization 头，确认你复制的是登录后的请求")
    return headers


# ---------- API ----------

class Client:
    BASE = "https://chatgpt.com/backend-api"

    def __init__(self, headers: dict[str, str], rate: float = 1.0):
        self.rate = rate
        self.session = requests.Session()
        self.session.headers.update(headers)

    def list_conversations(self, limit: int = 100, offset: int = 0):
        url = f"{self.BASE}/conversations?offset={offset}&limit={limit}&order=updated"
        r = self.session.get(url, timeout=30)
        if r.status_code != 200:
            raise RuntimeError(f"列表失败 offset={offset}: HTTP {r.status_code} {r.text[:200]}")
        return r.json().get("items", [])

    def get_conversation(self, conv_id: str):
        r = self.session.get(f"{self.BASE}/conversation/{conv_id}", timeout=60)
        if r.status_code != 200:
            return None
        return r.json()

    def file_download_url(self, file_id: str):
        for url in (
            f"{self.BASE}/files/{file_id}/download",
            f"{self.BASE}/files/{file_id}",
        ):
            try:
                r = self.session.get(url, timeout=30)
            except Exception:
                continue
            if r.status_code != 200:
                continue
            try:
                data = r.json()
            except Exception:
                continue
            dl = data.get("download_url") or data.get("url")
            name = data.get("file_name") or data.get("name")
            if dl:
                return dl, name
        return None, None

    def fetch_file(self, file_id: str, out_dir: str) -> bool:
        existing = glob.glob(os.path.join(out_dir, f"{file_id}.*"))
        if existing:
            return True
        dl, fname = self.file_download_url(file_id)
        if not dl:
            return False
        try:
            r = self.session.get(dl, timeout=60, stream=True)
            if r.status_code != 200:
                return False
            ext = guess_ext(dl, r.headers.get("Content-Type"), fname)
            out = os.path.join(out_dir, f"{file_id}{ext}")
            with open(out, "wb") as f:
                for chunk in r.iter_content(8192):
                    f.write(chunk)
            return True
        except Exception:
            return False


# ---------- 工具 ----------

FILE_ID_RE = re.compile(r"file[-_][A-Za-z0-9]{16,}")


def safe_filename(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", name).strip()
    return name[:120] or "Untitled"


def guess_ext(url: str, content_type: str | None, fname: str | None = None) -> str:
    if fname:
        _, ext = os.path.splitext(fname)
        if ext and len(ext) <= 6:
            return ext
    path = urlparse(url).path
    _, ext = os.path.splitext(path)
    if ext and len(ext) <= 6:
        return ext
    if content_type:
        ext = mimetypes.guess_extension(content_type.split(";")[0].strip())
        if ext:
            return ext
    return ".bin"


def extract_file_ids(obj, found: set):
    if isinstance(obj, dict):
        for v in obj.values():
            extract_file_ids(v, found)
    elif isinstance(obj, list):
        for v in obj:
            extract_file_ids(v, found)
    elif isinstance(obj, str):
        for m in FILE_ID_RE.findall(obj):
            found.add(m)


# ---------- 渲染 ----------

def md_inline(text: str) -> str:
    text = html.escape(text)
    text = re.sub(r"`([^`\n]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*\n]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2" target="_blank" rel="noopener">\1</a>', text)
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    return "".join(f"<p>{p.replace(chr(10), '<br>')}</p>" for p in paragraphs)


def md_to_html(text: str) -> str:
    out = []
    pattern = re.compile(r"```(\w*)\n([\s\S]*?)```", re.MULTILINE)
    last = 0
    for m in pattern.finditer(text):
        out.append(md_inline(text[last:m.start()]))
        lang = m.group(1) or ""
        code = html.escape(m.group(2))
        out.append(f'<pre><code class="lang-{lang}">{code}</code></pre>')
        last = m.end()
    out.append(md_inline(text[last:]))
    return "".join(out)


def render_part(part, assets: dict) -> str:
    if isinstance(part, str):
        return md_to_html(part)
    if not isinstance(part, dict):
        return f"<pre>{html.escape(str(part))}</pre>"
    ctype = part.get("content_type", "")
    if ctype == "image_asset_pointer":
        ptr = part.get("asset_pointer", "")
        m = FILE_ID_RE.search(ptr)
        if m:
            fid = m.group(0)
            local = assets.get(fid)
            if local:
                mime = mimetypes.guess_type(local)[0] or ""
                if mime.startswith("image/"):
                    return f'<div class="img"><img src="{html.escape(local)}" alt="{fid}" loading="lazy"></div>'
                return f'<div class="file"><a href="{html.escape(local)}" target="_blank" rel="noopener">📎 {fid}</a></div>'
            return f'<div class="img missing">[image missing: {fid}]</div>'
    if ctype == "audio_transcription":
        return f"<blockquote>🎙 {html.escape(part.get('text',''))}</blockquote>"
    if "text" in part:
        return md_to_html(part["text"])
    return f"<details><summary>{html.escape(ctype or 'part')}</summary><pre>{html.escape(json.dumps(part, ensure_ascii=False, indent=2))}</pre></details>"


def render_attachment(att, assets: dict) -> str:
    fid = att.get("id") or att.get("file_id") or ""
    name = att.get("name") or fid
    local = assets.get(fid)
    if local:
        mime = mimetypes.guess_type(local)[0] or ""
        if mime.startswith("image/"):
            return f'<div class="img"><img src="{html.escape(local)}" alt="{html.escape(name)}" loading="lazy"><div class="caption">{html.escape(name)}</div></div>'
        return f'<div class="file"><a href="{html.escape(local)}" target="_blank" rel="noopener">📎 {html.escape(name)}</a></div>'
    return f'<div class="file missing">📎 {html.escape(name)} (not downloaded)</div>'


def linear_messages(data: dict) -> Iterable[dict]:
    mapping = data.get("mapping", {})
    cur = data.get("current_node")
    chain = []
    while cur:
        node = mapping.get(cur)
        if not node:
            break
        chain.append(node)
        cur = node.get("parent")
    chain.reverse()
    for node in chain:
        msg = node.get("message")
        if msg:
            yield msg


CSS = """
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:860px;margin:0 auto;padding:24px;color:#1f2328;background:#fafafa;line-height:1.55}
h1{font-size:22px;margin:0 0 4px}
.header{border-bottom:1px solid #e5e7eb;padding-bottom:12px;margin-bottom:24px;color:#57606a;font-size:13px}
.msg{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;margin:14px 0}
.msg.user{background:#f0f7ff;border-color:#cfe3ff}
.msg.assistant{background:#fff}
.msg.tool{background:#fffaf0;border-color:#ffe9c2;font-size:13px}
.meta{font-size:11px;color:#6e7781;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.body p{margin:.5em 0}
.body pre{background:#0d1117;color:#e6edf3;padding:12px 14px;border-radius:8px;overflow-x:auto;font-size:13px}
.body code{background:rgba(175,184,193,.2);padding:.1em .3em;border-radius:4px;font-size:.92em;font-family:'SF Mono',Menlo,monospace}
.body pre code{background:transparent;padding:0;color:inherit}
.img img{max-width:100%;border-radius:8px;border:1px solid #e5e7eb;margin:6px 0}
.img.missing,.file.missing{color:#a40e26;font-style:italic}
.caption{font-size:12px;color:#6e7781;margin-top:-2px}
.file a{color:#0969da;text-decoration:none}
a{color:#0969da}
blockquote{border-left:3px solid #d0d7de;margin:.5em 0;padding:.2em 1em;color:#57606a}
details{margin:.5em 0}
summary{cursor:pointer;color:#6e7781;font-size:12px}
"""


def render_conversation(json_path: str, html_dir: str, assets: dict):
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    title = data.get("title") or "Untitled"
    create_ts = data.get("create_time")
    update_ts = data.get("update_time")
    created = datetime.fromtimestamp(create_ts).strftime("%Y-%m-%d %H:%M") if create_ts else ""
    updated = datetime.fromtimestamp(update_ts).strftime("%Y-%m-%d %H:%M") if update_ts else ""

    blocks = []
    for msg in linear_messages(data):
        role = (msg.get("author") or {}).get("role", "")
        if role == "system":
            continue
        c = msg.get("content") or {}
        parts = c.get("parts") or []
        attachments = ((msg.get("metadata") or {}).get("attachments") or [])
        is_empty = (
            c.get("content_type") == "text"
            and not any(isinstance(p, str) and p.strip() for p in parts)
            and not attachments
        )
        if is_empty:
            continue
        channel = msg.get("channel")
        if role == "tool" and channel == "analysis" and not any(isinstance(p, dict) for p in parts):
            continue
        body = [render_part(p, assets) for p in parts] + [render_attachment(a, assets) for a in attachments]
        if not body:
            continue
        label = {"user": "You", "assistant": "ChatGPT", "tool": "Tool"}.get(role, role)
        ts = msg.get("create_time")
        ts_str = datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else ""
        blocks.append(
            f'<div class="msg {role}"><div class="meta">{html.escape(label)} · {ts_str}</div>'
            f'<div class="body">{"".join(body)}</div></div>'
        )

    doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>{html.escape(title)}</title><style>{CSS}</style></head><body>
<div class="header"><h1>{html.escape(title)}</h1>
<div>Created: {created} · Updated: {updated}</div></div>
{"".join(blocks)}
</body></html>"""

    cid = (data.get("id") or "")[:8]
    fname = f"{safe_filename(title)}_{cid}.html"
    with open(os.path.join(html_dir, fname), "w", encoding="utf-8") as f:
        f.write(doc)
    return {"title": title, "path": fname, "created": created, "updated": updated}


def write_index(html_dir: str, entries: list):
    entries.sort(key=lambda e: e["updated"] or e["created"], reverse=True)
    rows = "\n".join(
        f'<li><a href="{html.escape(e["path"])}">{html.escape(e["title"])}</a>'
        f'<span class="t">{e["updated"] or e["created"]}</span></li>'
        for e in entries
    )
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ChatGPT Takeout</title>
<style>
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:860px;margin:0 auto;padding:24px;color:#1f2328;background:#fafafa}}
h1{{font-size:22px}} ul{{list-style:none;padding:0}}
li{{padding:8px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between;gap:12px}}
a{{color:#0969da;text-decoration:none}} a:hover{{text-decoration:underline}}
.t{{color:#6e7781;font-size:12px;white-space:nowrap}}
</style></head><body>
<h1>ChatGPT Takeout · {len(entries)} conversations</h1>
<ul>{rows}</ul></body></html>"""
    with open(os.path.join(html_dir, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)


# ---------- 主流程 ----------

def main(argv=None):
    ap = argparse.ArgumentParser(description="Export ChatGPT conversations to local HTML.")
    ap.add_argument("curl_file", help="Path to a file containing a cURL command copied from chatgpt.com DevTools.")
    ap.add_argument("out_dir", help="Output directory.")
    ap.add_argument("--limit", type=int, default=100, help="Page size for listing (default 100).")
    ap.add_argument("--rate", type=float, default=1.0, help="Seconds between requests (default 1.0).")
    ap.add_argument("--skip-assets", action="store_true", help="Skip downloading attachments and images.")
    ap.add_argument("--skip-render", action="store_true", help="Skip HTML rendering.")
    args = ap.parse_args(argv)

    with open(args.curl_file, "r", encoding="utf-8") as f:
        headers = parse_curl(f.read())
    client = Client(headers, rate=args.rate)

    conv_dir = os.path.join(args.out_dir, "conversations")
    asset_dir = os.path.join(args.out_dir, "assets")
    html_dir = os.path.join(args.out_dir, "html")
    for d in (conv_dir, asset_dir, html_dir):
        os.makedirs(d, exist_ok=True)

    # 1) 列表
    print("Listing conversations...")
    all_convs = []
    offset = 0
    while True:
        items = client.list_conversations(limit=args.limit, offset=offset)
        if not items:
            break
        all_convs.extend(items)
        print(f"  got {len(all_convs)}")
        if len(items) < args.limit:
            break
        offset += len(items)
        time.sleep(args.rate)
    with open(os.path.join(args.out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(all_convs, f, ensure_ascii=False, indent=2)

    # 2) 详情
    print(f"Downloading {len(all_convs)} conversations...")
    for i, conv in enumerate(all_convs, 1):
        cid = conv["id"]
        title = safe_filename(conv.get("title") or "Untitled")
        out = os.path.join(conv_dir, f"{title}_{cid[:8]}.json")
        if os.path.exists(out):
            continue
        print(f"  [{i}/{len(all_convs)}] {title}")
        detail = client.get_conversation(cid)
        if detail:
            with open(out, "w", encoding="utf-8") as f:
                json.dump(detail, f, ensure_ascii=False, indent=2)
        time.sleep(args.rate)

    # 3) 附件
    if not args.skip_assets:
        print("Scanning for attachments...")
        all_ids: set[str] = set()
        for p in glob.glob(os.path.join(conv_dir, "*.json")):
            with open(p, "r", encoding="utf-8") as f:
                extract_file_ids(json.load(f), all_ids)
        print(f"Found {len(all_ids)} file ids. Downloading...")
        ok = fail = 0
        for i, fid in enumerate(sorted(all_ids), 1):
            if client.fetch_file(fid, asset_dir):
                ok += 1
            else:
                fail += 1
            if i % 20 == 0:
                print(f"  {i}/{len(all_ids)} (ok={ok} fail={fail})")
            time.sleep(args.rate * 0.4)
        print(f"Assets: ok={ok} fail={fail} (failures are usually expired sandbox files)")

    # 4) 渲染
    if not args.skip_render:
        print("Rendering HTML...")
        assets = {}
        for p in glob.glob(os.path.join(asset_dir, "file*.*")):
            fid = os.path.splitext(os.path.basename(p))[0]
            assets[fid] = os.path.relpath(p, html_dir)
        entries = []
        for p in sorted(glob.glob(os.path.join(conv_dir, "*.json"))):
            try:
                entries.append(render_conversation(p, html_dir, assets))
            except Exception as e:
                print(f"  render fail {p}: {e}")
        write_index(html_dir, entries)
        print(f"Done. Open {os.path.join(html_dir, 'index.html')}")


if __name__ == "__main__":
    sys.exit(main())
