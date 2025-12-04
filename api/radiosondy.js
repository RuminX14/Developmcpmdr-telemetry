
// Vercel serverless function: /api/radiosondy
// Proxy do https://radiosondy.info/export/export_search.php?csv=1&search_limit=200

const CACHE_TTL_MS = 30000;
const UPSTREAM_URL = 'https://radiosondy.info/export/export_search.php?csv=1&search_limit=200';

let lastFetchTime = 0;
let lastBody = null;
let lastStatus = 200;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const now = Date.now();
  const useFresh = now - lastFetchTime > CACHE_TTL_MS;

  async function fetchUpstream() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const upstreamRes = await fetch(UPSTREAM_URL, {
        method: 'GET',
        signal: controller.signal
      });
      clearTimeout(timeout);

      const text = await upstreamRes.text();
      if (upstreamRes.ok) {
        lastFetchTime = Date.now();
        lastBody = text;
        lastStatus = upstreamRes.status || 200;
      }
      return { status: upstreamRes.status || 500, body: text };
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  let body;
  let status;

  if (useFresh || !lastBody) {
    try {
      const result = await fetchUpstream();
      status = result.status;
      body = result.body;
    } catch (err) {
      if (lastBody) {
        res.setHeader('X-Proxy-Warn', 'stale-cache');
        status = lastStatus;
        body = lastBody;
      } else {
        res.status(504).send('Upstream timeout');
        return;
      }
    }
  } else {
    status = lastStatus;
    body = lastBody;
  }

  res.status(status);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  const url = new URL(req.url, 'http://localhost');
  const mode = url.searchParams.get('mode') || 'all';
  const id = (url.searchParams.get('id') || '').toLowerCase();

  if (mode === 'single' && id) {
    const lines = body.split(/\r?\n/);
    const out = [];
    if (lines.length) out.push(lines[0]);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (line.toLowerCase().includes(id)) out.push(line);
    }
    res.send(out.join('\n'));
  } else {
    res.send(body);
  }
}
