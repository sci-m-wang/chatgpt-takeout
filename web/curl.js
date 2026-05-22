// Parse a "Copy as cURL" string into { headers, cookies }.
// Handles both POSIX (\\\n line continuations, single-quoted args) and bash forms.

function tokenize(text) {
  // Drop backslash-newline line continuations.
  const s = text.replace(/\\\s*\n/g, ' ').trim();
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
    if (ch === "'") {
      // Single-quoted: take until next ', no escapes (per POSIX shell semantics
      // used by Chrome/Firefox "Copy as cURL"). Bash-extension $'...' is not
      // typically emitted.
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error("Unterminated ' in cURL");
      out.push(s.slice(i + 1, end));
      i = end + 1;
    } else if (ch === '"') {
      let buf = '';
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) { buf += s[i + 1]; i += 2; }
        else { buf += s[i]; i++; }
      }
      if (s[i] !== '"') throw new Error('Unterminated " in cURL');
      i++;
      out.push(buf);
    } else {
      let buf = '';
      while (i < s.length && !' \t\n'.includes(s[i])) {
        if (s[i] === '\\' && i + 1 < s.length) { buf += s[i + 1]; i += 2; }
        else { buf += s[i]; i++; }
      }
      out.push(buf);
    }
  }
  return out;
}

const FLAGS_WITH_VALUE = new Set([
  '-H', '--header', '-b', '--cookie', '-X', '--request',
  '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode',
  '-A', '--user-agent', '-e', '--referer', '-u', '--user',
  '--cookie-jar', '--connect-timeout', '-m', '--max-time',
]);
const FLAGS_NOARG = new Set([
  '--compressed', '-k', '--insecure', '-L', '--location', '-s', '--silent',
  '-S', '--show-error', '-v', '--verbose', '-i', '--include', '-I', '--head',
  '-f', '--fail', '-O', '--remote-name', '-J', '--remote-header-name',
  '-N', '--no-buffer', '-#', '--progress-bar',
]);

export function parseCurl(text) {
  const tokens = tokenize(text);
  if (!tokens.length) throw new Error('Empty cURL');
  let idx = 0;
  // Skip leading newline/whitespace artifacts; first non-empty must be 'curl'.
  while (idx < tokens.length && !tokens[idx]) idx++;
  if (tokens[idx] !== 'curl') throw new Error("cURL must start with 'curl'");
  idx++;

  const headers = {};
  let cookie = '';
  let url = '';

  while (idx < tokens.length) {
    const t = tokens[idx];
    if (FLAGS_WITH_VALUE.has(t)) {
      const v = tokens[idx + 1] || '';
      idx += 2;
      if (t === '-H' || t === '--header') {
        const colon = v.indexOf(':');
        if (colon > 0) {
          const k = v.slice(0, colon).trim();
          const val = v.slice(colon + 1).trim();
          headers[k] = val;
        }
      } else if (t === '-b' || t === '--cookie') {
        cookie = v;
      }
    } else if (FLAGS_NOARG.has(t)) {
      idx++;
    } else if (t.startsWith('-')) {
      // Unknown flag — assume it takes one arg (safest for unknown flags).
      idx += 2;
    } else {
      if (!url) url = t;
      idx++;
    }
  }

  // Normalize: lowercase header lookup.
  const has = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
  if (cookie && !has('cookie')) headers['Cookie'] = cookie;
  if (!has('authorization')) {
    throw new Error('No Authorization header found in the cURL. Make sure you copied a request from a signed-in session.');
  }
  // Remove headers that the browser will reject when we re-set them.
  const FORBIDDEN = ['host', 'connection', 'content-length', 'origin', 'referer', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest'];
  for (const k of Object.keys(headers)) {
    if (FORBIDDEN.includes(k.toLowerCase())) delete headers[k];
  }
  return { headers, url };
}
