import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

const credentials = readFileSync(new URL('../artifacts/online-admin-login.txt', import.meta.url), 'utf8');
const username = credentials.match(/^Username: (.+)$/m)?.[1].trim();
const password = credentials.match(/^Password: (.+)$/m)?.[1].trim();
assert(username && password, 'Expected generated login details');
const origin = process.env.ADMIN_ORIGIN || 'https://blog.rosekhlifa.com';
const publicOrigin = process.env.VERIFY_PUBLIC_ORIGIN || 'https://blog.rosekhlifa.com';
const agent = new https.Agent({ ...(new URL(origin).hostname === '51.83.101.143' ? { ca: readFileSync(new URL('../artifacts/online-admin-server.crt', import.meta.url)) } : { proxyEnv: process.env }), keepAlive: true });
const authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
const entryId = `online-smoke-${Date.now()}`;
let current;
let uploaded;

async function request(route, options = {}) {
  let bytes;
  const headers = { ...(options.auth === false ? {} : { Authorization: authorization }), ...(options.headers || {}) };
  if (options.origin !== false) headers.Origin = options.origin || origin;
  if (options.body instanceof FormData) {
    const form = new Response(options.body);
    bytes = Buffer.from(await form.arrayBuffer());
    headers['Content-Type'] = form.headers.get('content-type');
  } else if (options.body !== undefined) {
    bytes = Buffer.from(JSON.stringify(options.body));
    headers['Content-Type'] = 'application/json';
  }
  if (bytes) headers['Content-Length'] = String(bytes.length);
  return await new Promise((resolve, reject) => {
    const req = https.request(new URL(route, origin), { agent, method: options.body === undefined ? 'GET' : 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(60000, () => req.destroy(new Error(`Timeout requesting ${route}`)));
    req.on('error', reject);
    req.end(bytes);
  });
}
async function api(route, body) {
  const response = await request(route, { body });
  let data;
  try { data = JSON.parse(response.text); } catch { throw new Error(`${route}: HTTP ${response.status}: ${response.text.slice(0, 250)}`); }
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.ok, true, JSON.stringify(data));
  console.log(`200 ${route} ok=true`);
  return data;
}
async function waitPublic(expectedText, expectedStatus = 200) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(`${publicOrigin}/archive/${entryId}/`, { signal: AbortSignal.timeout(15000) });
    const html = await response.text();
    if (response.status === expectedStatus && (!expectedText || html.includes(expectedText))) return html;
    if (attempt % 10 === 0) {
      const state = await request('/_publish/status');
      console.log(`Waiting for public update: ${JSON.parse(state.text).state}`);
    }
    await delay(2000);
  }
  throw new Error(`Public article did not reach expected status ${expectedStatus}`);
}

try {
  for (const route of ['/admin/content/', '/@vite/client', '/_publish/status', '/api/admin/content/entry/?collection=essay&entryId=markdown-guide']) {
    const response = await request(route, { auth: false });
    assert.equal(response.status, 401);
    console.log(`BASELINE 401 ${route} without login`);
  }
  for (const route of ['/admin/content/', '/@vite/client', '/_publish/status.js']) {
    const response = await request(route);
    assert.equal(response.status, 200, `${route}: ${response.text.slice(0, 200)}`);
    if (route.startsWith('/admin/')) assert(response.text.includes('/_publish/status.js'), 'Expected publishing status widget');
    assert.match(response.headers['cache-control'], /no-store/);
    console.log(`MODIFIED 200 ${route} authenticated`);
  }
  for (const foreignOrigin of [false, 'https://unrelated.example']) {
    const response = await request('/api/admin/content/create/', { origin: foreignOrigin, body: {} });
    assert.equal(response.status, 403);
    console.log(`403 write rejected for ${foreignOrigin === false ? 'missing' : 'foreign'} Origin`);
  }
  const frontmatter = {
    title: 'Temporary online editor verification', description: '', date: '2026-10-20',
    publishedAt: '', updatedAt: '', tagsText: 'verification', draft: true, archive: true,
    slug: entryId, cover: '', badge: '',
  };
  current = (await api('/api/admin/content/create/', { collection: 'essay', entryId, frontmatter })).payload;
  assert.equal(current.values.draft, true);
  const initialPublic = await fetch(`${publicOrigin}/archive/${entryId}/`);
  assert.equal(initialPublic.status, 404, 'Draft should remain private');
  console.log('DRAFT PASS: saved on server and absent from public site');

  const form = new FormData();
  form.set('collection', 'essay');
  form.set('entryId', entryId);
  form.set('image', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#8c6d5a"/></svg>'], { type: 'image/svg+xml' }), `${entryId}.svg`);
  uploaded = (await api('/api/admin/images/upload/', form)).result;
  assert.match(uploaded.src, /^\.\/.+-assets\/.+\.svg$/);
  const marker = 'Temporary acceptance content from the online editor.';
  let body = `# Online editor verification\n\n${marker}\n\n![Verification](${uploaded.src})\n`;
  current = (await api('/api/admin/content/entry/', { collection: 'essay', entryId, revision: current.revision, frontmatter: { ...current.values, draft: false }, body })).payload;
  const html = await waitPublic(marker);
  assert(html.includes('https://blog.rosekhlifa.com/archive/'), 'Production canonical mismatch');
  const src = [...html.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map((match) => match[1]).find((src) => src.includes('online-smoke'));
  assert(src, 'Uploaded image is missing from public article');
  const image = await fetch(new URL(src, publicOrigin));
  assert.equal(image.status, 200);
  console.log(`PUBLISH PASS: ${publicOrigin}/archive/${entryId}/; uploaded image HTTP 200`);
  const rss = await (await fetch(`${publicOrigin}/rss.xml`)).text();
  assert(rss.includes(`/archive/${entryId}/`), 'Published article missing from RSS');
  console.log('RSS PASS: published article appears in feed');

  body = body.replace(marker, 'Updated online acceptance content.');
  current = (await api('/api/admin/content/entry/', { collection: 'essay', entryId, revision: current.revision, frontmatter: current.values, body })).payload;
  await waitPublic('Updated online acceptance content.');
  console.log('EDIT PASS: saved article changes automatically reached the public site');
} finally {
  if (current) {
    current = (await api(`/api/admin/content/entry/?collection=essay&entryId=${entryId}`)).payload;
    const removed = await api('/api/admin/content/delete/', { collection: 'essay', entryId, revision: current.revision, expectedRelativePath: current.relativePath });
    assert.equal(removed.result.deleted, true);
    writeFileSync(new URL('../artifacts/online-smoke-cleanup.json', import.meta.url), JSON.stringify({ entryId, uploadedPath: uploaded?.path, trashedPath: removed.result.trashedPath }, null, 2));
    await waitPublic(undefined, 404);
    const rss = await (await fetch(`${publicOrigin}/rss.xml`)).text();
    assert(!rss.includes(`/archive/${entryId}/`), 'Deleted article remained in public RSS');
    console.log('ROLLBACK PASS: temporary article removed from public site/RSS; original demo content remains');
  }
  agent.destroy();
}
console.log('ONLINE PASS: TLS/login/CSRF/draft/image upload/publish/edit/delete/automatic production update');
