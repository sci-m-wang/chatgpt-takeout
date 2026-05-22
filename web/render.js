// Browser-side renderer: turns a ChatGPT conversation JSON into HTML,
// using a map of file_id -> blob URL / relative path for images.

const FILE_ID_RE = /file[-_][A-Za-z0-9]{16,}/g;

const CSS = `
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
`;

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function mdInline(text) {
  text = escapeHtml(text);
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

function mdToHtml(text) {
  const re = /```(\w*)\n([\s\S]*?)```/g;
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out.push(mdInline(text.slice(last, m.index)));
    const lang = m[1] || '';
    out.push(`<pre><code class="lang-${lang}">${escapeHtml(m[2])}</code></pre>`);
    last = m.index + m[0].length;
  }
  out.push(mdInline(text.slice(last)));
  return out.join('');
}

function renderPart(part, assets) {
  if (typeof part === 'string') return mdToHtml(part);
  if (!part || typeof part !== 'object') return `<pre>${escapeHtml(String(part))}</pre>`;
  const ctype = part.content_type || '';
  if (ctype === 'image_asset_pointer') {
    const ptr = part.asset_pointer || '';
    const m = ptr.match(FILE_ID_RE);
    if (m) {
      const fid = m[0];
      const local = assets[fid];
      if (local) {
        if (/\.(png|jpe?g|gif|webp|svg)$/i.test(local)) {
          return `<div class="img"><img src="${escapeHtml(local)}" alt="${fid}" loading="lazy"></div>`;
        }
        return `<div class="file"><a href="${escapeHtml(local)}" target="_blank" rel="noopener">📎 ${fid}</a></div>`;
      }
      return `<div class="img missing">[image missing: ${fid}]</div>`;
    }
  }
  if (ctype === 'audio_transcription') {
    return `<blockquote>🎙 ${escapeHtml(part.text || '')}</blockquote>`;
  }
  if (part.text) return mdToHtml(part.text);
  return `<details><summary>${escapeHtml(ctype || 'part')}</summary><pre>${escapeHtml(JSON.stringify(part, null, 2))}</pre></details>`;
}

function renderAttachment(att, assets) {
  const fid = att.id || att.file_id || '';
  const name = att.name || fid;
  const local = assets[fid];
  if (local) {
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(local)) {
      return `<div class="img"><img src="${escapeHtml(local)}" alt="${escapeHtml(name)}" loading="lazy"><div class="caption">${escapeHtml(name)}</div></div>`;
    }
    return `<div class="file"><a href="${escapeHtml(local)}" target="_blank" rel="noopener">📎 ${escapeHtml(name)}</a></div>`;
  }
  return `<div class="file missing">📎 ${escapeHtml(name)} (not downloaded)</div>`;
}

function* linearMessages(data) {
  const mapping = data.mapping || {};
  let cur = data.current_node;
  const chain = [];
  while (cur) {
    const node = mapping[cur];
    if (!node) break;
    chain.push(node);
    cur = node.parent;
  }
  chain.reverse();
  for (const node of chain) {
    if (node.message) yield node.message;
  }
}

function tsFmt(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderConversationHtml(data, assets) {
  const title = data.title || 'Untitled';
  const created = tsFmt(data.create_time);
  const updated = tsFmt(data.update_time);

  const blocks = [];
  for (const msg of linearMessages(data)) {
    const role = (msg.author && msg.author.role) || '';
    if (role === 'system') continue;
    const c = msg.content || {};
    const parts = c.parts || [];
    const attachments = (msg.metadata && msg.metadata.attachments) || [];
    const isEmpty = c.content_type === 'text'
      && !parts.some((p) => typeof p === 'string' && p.trim())
      && attachments.length === 0;
    if (isEmpty) continue;
    if (role === 'tool' && msg.channel === 'analysis'
      && !parts.some((p) => typeof p === 'object' && p)) continue;

    const body = [
      ...parts.map((p) => renderPart(p, assets)),
      ...attachments.map((a) => renderAttachment(a, assets)),
    ];
    if (!body.length) continue;
    const label = { user: 'You', assistant: 'ChatGPT', tool: 'Tool' }[role] || role;
    blocks.push(
      `<div class="msg ${role}"><div class="meta">${escapeHtml(label)} · ${tsFmt(msg.create_time)}</div>`
      + `<div class="body">${body.join('')}</div></div>`,
    );
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>
<div class="header"><h1>${escapeHtml(title)}</h1>
<div>Created: ${created} · Updated: ${updated}</div></div>
${blocks.join('')}
</body></html>`;
}

export function renderIndexHtml(entries) {
  entries.sort((a, b) => (b.updated || b.created).localeCompare(a.updated || a.created));
  const rows = entries.map((e) =>
    `<li><a href="${escapeHtml(e.path)}">${escapeHtml(e.title)}</a>`
    + `<span class="t">${e.updated || e.created}</span></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ChatGPT Takeout</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:860px;margin:0 auto;padding:24px;color:#1f2328;background:#fafafa}
h1{font-size:22px} ul{list-style:none;padding:0}
li{padding:8px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between;gap:12px}
a{color:#0969da;text-decoration:none} a:hover{text-decoration:underline}
.t{color:#6e7781;font-size:12px;white-space:nowrap}
</style></head><body>
<h1>ChatGPT Takeout · ${entries.length} conversations</h1>
<ul>${rows}</ul></body></html>`;
}

export function extractFileIds(obj, out = new Set()) {
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj)) for (const v of obj) extractFileIds(v, out);
    else for (const v of Object.values(obj)) extractFileIds(v, out);
  } else if (typeof obj === 'string') {
    const m = obj.match(FILE_ID_RE);
    if (m) for (const f of m) out.add(f);
  }
  return out;
}

export function safeFilename(name) {
  return (name || 'Untitled').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 120) || 'Untitled';
}

export function guessExt(url, contentType, fname) {
  const tryExt = (s) => {
    if (!s) return '';
    const m = s.match(/\.([A-Za-z0-9]{1,6})(?:$|\?)/);
    return m ? `.${m[1].toLowerCase()}` : '';
  };
  return tryExt(fname) || tryExt(new URL(url, 'https://x/').pathname)
    || ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
          'image/svg+xml': '.svg', 'application/pdf': '.pdf', 'text/plain': '.txt',
          'text/markdown': '.md', 'application/json': '.json' }[
            (contentType || '').split(';')[0].trim()
          ]) || '.bin';
}
