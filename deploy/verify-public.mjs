import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const origin = (process.argv[2] || 'http://51.83.101.143:18180').replace(/\/$/, '');
const verifyLocalHash = !process.argv.includes('--skip-local-hash');
const publicSite = 'https://blog.rosekhlifa.com';
const assets = new Set();
const visited = new Set();
async function request(route, expectedType, expectedStatus = 200) {
  const url = new URL(route, origin);
  assert.equal(url.origin, origin, `Unexpected external runtime resource: ${route}`);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, expectedStatus, `${route}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') || '';
  if (expectedType) assert(type.includes(expectedType), `${route}: unexpected content type ${type}`);
  assert(bytes.length > 0, `${route}: empty response`);
  console.log(`${response.status} ${route} ${type} ${bytes.length} bytes`);
  visited.add(url.pathname);
  return { response, bytes, text: bytes.toString('utf8') };
}

for (const route of ['/', '/archive/markdown-guide/']) {
  const { text, bytes } = await request(route, 'text/html');
  assert(text.includes(`<link rel="canonical" href="${publicSite}${route}"`), `${route}: canonical mismatch`);
  if (route === '/' && verifyLocalHash) {
    const local = readFileSync(new URL('../dist/index.html', import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(local).digest('hex'), 'Public homepage differs from local build');
  }
  for (const match of text.matchAll(/(?:src|href)="(\/(?:_astro|fonts|author)\/[^"?#]+)(?:[?#][^"]*)?"/g)) assets.add(match[1]);
}
for (const route of ['/_health', '/rss.xml', '/archive/rss.xml', '/essay/rss.xml', '/sitemap-index.xml', '/sitemap-0.xml', '/robots.txt']) {
  const { text } = await request(route, route.endsWith('.xml') ? 'xml' : 'text/plain');
  if (route.endsWith('.xml')) assert(text.includes(publicSite), `${route}: missing production domain`);
  if (route.endsWith('rss.xml')) assert(text.includes('<item>'), `${route}: no feed entries`);
}
for (const asset of [...assets]) {
  const { text, response } = await request(asset, asset.endsWith('.css') ? 'text/css' : undefined);
  if (asset.startsWith('/_astro/')) assert((response.headers.get('cache-control') || '').includes('immutable'), `${asset}: immutable cache missing`);
  if (asset.endsWith('.css')) {
    for (const match of text.matchAll(/url\(["']?(\/fonts\/[^\s)"']+)/g)) assets.add(match[1]);
  }
}
for (const asset of assets) if (!visited.has(asset)) await request(asset);
// Explicitly check a self-hosted font even if the font URL is in inline CSS.
if (![...visited].some((url) => url.endsWith('.woff2'))) await request('/fonts/noto-serif-sc-400-latin.woff2');
const redirect = await fetch(`${origin}/about`, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
assert.equal(redirect.status, 301, 'Directory redirect should be HTTP 301');
assert.equal(new URL(redirect.headers.get('location'), origin).href, `${origin}/about/`, 'Directory redirect lost IP/port');
console.log(`301 /about -> ${redirect.headers.get('location')} (origin preserved)`);
await request('/__deployment_missing_page__', 'text/html', 404);
console.log(`PUBLIC PASS: ${visited.size} responses; ${verifyLocalHash ? 'homepage SHA256 matches local dist' : 'local homepage hash comparison skipped for rollback'}; canonical/RSS use ${publicSite}`);
