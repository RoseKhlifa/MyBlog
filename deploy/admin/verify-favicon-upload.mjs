import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';

const origin = 'https://blog.rosekhlifa.com';
const agent = new https.Agent({ keepAlive: true, proxyEnv: process.env });
const credentials = readFileSync(new URL('../artifacts/online-admin-login.txt', import.meta.url), 'utf8');
const username = credentials.match(/^Username: (.+)$/m)?.[1].trim();
const password = credentials.match(/^Password: (.+)$/m)?.[1].trim();
assert(username && password, 'Expected the local administrator login file');
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const uploadOnly = process.argv.includes('--upload-only');
const uploadRoute = '/api/admin/site-assets/upload/';
const settingsRoute = '/api/admin/settings/';
const slots = ['png', 'appleTouchIcon'];
const fixtures = [];
const originals = [];
let before;
let afterUpload;
let savedSnapshot;
let restoredSnapshot;
let writeAttempted = false;
let restoration = 'not-needed';
let failure;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const faviconValue = (settings) => settings.site.favicon;
const withFaviconPatch = (settings, patch) => ({
  ...settings,
  site: { ...settings.site, favicon: { ...settings.site.favicon, ...patch } },
});

async function request(route, { method, body, auth = true, requestOrigin = origin, redirects = 0, noCache = false } = {}) {
  const headers = { Accept: '*/*', ...(auth ? { Authorization: authorization } : {}) };
  if (requestOrigin !== false) headers.Origin = requestOrigin;
  if (noCache) {
    headers['Cache-Control'] = 'no-cache';
    headers.Pragma = 'no-cache';
  }
  let bytes;
  if (body instanceof FormData) {
    const serialized = new Response(body);
    bytes = Buffer.from(await serialized.arrayBuffer());
    headers['Content-Type'] = serialized.headers.get('content-type');
  } else if (body !== undefined) {
    bytes = Buffer.from(JSON.stringify(body));
    headers['Content-Type'] = 'application/json';
  }
  if (bytes) headers['Content-Length'] = String(bytes.length);
  const target = new URL(route, origin);
  assert.equal(target.origin, origin, 'Verification must not forward administrator credentials to another origin');
  const response = await new Promise((resolve, reject) => {
    const req = https.request(target, {
      agent, method: method || (body === undefined ? 'GET' : 'POST'), headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseBytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes: responseBytes, text: responseBytes.toString('utf8') });
      });
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error(`Timeout: ${target.pathname}`)));
    req.on('error', reject);
    req.end(bytes);
  });
  if (response.headers.location && [301, 302, 303, 307, 308].includes(response.status) && body === undefined && (!method || method === 'GET')) {
    assert(redirects < 4, `Too many redirects: ${target.pathname}`);
    const next = new URL(response.headers.location, target);
    assert.equal(next.origin, origin, 'Verification must not forward administrator credentials to another origin');
    return await request(next, { method, auth, requestOrigin, noCache, redirects: redirects + 1 });
  }
  return response;
}

function parseJson(response, label) {
  try { return JSON.parse(response.text); }
  catch { throw new Error(`${label}: HTTP ${response.status}, expected JSON: ${response.text.slice(0, 180)}`); }
}

async function api(route, options) {
  const response = await request(route, options);
  const data = parseJson(response, route);
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(data)}`);
  assert.equal(data.ok, true, `${route}: ${JSON.stringify(data)}`);
  return data;
}

async function fixture(label, slot, edge) {
  const bytes = await sharp(randomBytes(edge * edge * 3), { raw: { width: edge, height: edge, channels: 3 } }).png().toBuffer();
  const prefix = slot === 'png' ? 'favicon' : 'apple-touch-icon';
  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 8);
  const fileName = `${prefix}-${edge}x${edge}-${hash}.png`;
  return { label, slot, width: edge, height: edge, bytes, sha256: sha256(bytes), fileName, path: `/images/site/${fileName}` };
}

function form(sample) {
  const result = new FormData();
  result.set('slot', sample.slot);
  // A site icon upload is independent of any article or bit.
  result.set('image', new Blob([sample.bytes], { type: 'image/png' }), `${sample.label}.png`);
  return result;
}

function previewPath(publicPath) {
  const match = /^\/images\/site\/((?:favicon|apple-touch-icon)-\d+x\d+-[0-9a-f]{8}\.png)$/.exec(publicPath);
  assert(match, `Expected an administrator-generated favicon path: ${publicPath}`);
  return `/api/admin/site-assets/favicon-preview/${match[1]}/`;
}

function assertPng(response, expectedDigest, label) {
  assert.equal(response.status, 200, `${label}: expected HTTP 200`);
  assert.match(response.headers['content-type'] ?? '', /^image\/png\b/, `${label}: expected image/png`);
  assert.equal(sha256(response.bytes), expectedDigest, `${label}: original PNG bytes must be unchanged`);
}

async function verifyPreview(sample, { anonymous = false } = {}) {
  const route = previewPath(sample.path);
  const preview = await request(route);
  assertPng(preview, sample.sha256, `${sample.label} preview`);
  assert.match(preview.headers['cache-control'] ?? '', /\bno-store\b/, 'Private source previews must not be cached');
  if (anonymous) {
    const unauthenticated = await request(route, { auth: false });
    assert.equal(unauthenticated.status, 401, `${sample.label}: anonymous preview must require login`);
  }
  return preview;
}

async function upload(sample) {
  const result = (await api(uploadRoute, { body: form(sample) })).result;
  assert.equal(result.path, sample.path);
  assert.equal(result.fileName, sample.fileName);
  assert.equal(result.width, sample.width);
  assert.equal(result.height, sample.height);
  assert.equal(result.size, sample.bytes.length);
  sample.uploaded = result;
  fixtures.push(sample);
  await verifyPreview(sample, { anonymous: true });
  return result;
}

function linksFromHead(html) {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  return [...head.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => ({
    rel: tag.match(/\brel=["']([^"']+)["']/i)?.[1],
    type: tag.match(/\btype=["']([^"']+)["']/i)?.[1],
    href: tag.match(/\bhref=["']([^"']+)["']/i)?.[1],
  }));
}

function hasFavicon(links, favicon) {
  return slots.every((slot) => {
    const href = favicon[slot];
    if (!href) return true;
    const path = new URL(href, `${origin}/`).pathname;
    return links.some((link) => link.href
      && link.rel === (slot === 'png' ? 'icon' : 'apple-touch-icon')
      && (slot !== 'png' || link.type === 'image/png')
      && new URL(link.href, `${origin}/`).pathname === path);
  });
}

async function waitPublicFavicon(favicon, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await request(`/?favicon-verification=${Date.now()}-${attempt}`, { auth: false, requestOrigin: false, noCache: true });
    if (response.status === 200 && hasFavicon(linksFromHead(response.text), favicon)) return;
    if (attempt % 15 === 0) {
      const statusResponse = await request('/_publish/status');
      assert.equal(statusResponse.status, 200, 'Publisher status must be reachable');
      const state = parseJson(statusResponse, 'Publisher status');
      console.log(`WAIT ${label}: publisher=${state.state ?? 'pending'}`);
    }
    await delay(2000);
  }
  throw new Error(`Public homepage did not reach ${label}`);
}

async function verifyOriginalFiles(label) {
  for (const sample of originals) {
    await verifyPreview(sample);
    const response = await request(sample.path, { auth: false, requestOrigin: false, noCache: true });
    assertPng(response, sample.sha256, `${sample.label} ${label}`);
  }
}

async function restoreFavicon(temporary) {
  // Merge only the slots still carrying our test values into the latest revision.
  // A user's newer selection or other setting always survives this restoration.
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = (await api(settingsRoute)).payload;
    const currentFavicon = faviconValue(current.settings);
    const patch = {};
    const concurrentSlots = [];
    for (const slot of slots) {
      if (currentFavicon[slot] === temporary[slot]) patch[slot] = faviconValue(before.settings)[slot];
      else if (currentFavicon[slot] !== faviconValue(before.settings)[slot]) concurrentSlots.push(slot);
    }
    if (!Object.keys(patch).length) {
      restoredSnapshot = current;
      restoration = concurrentSlots.length ? 'concurrent-user-favicon-preserved' : 'original-already-restored';
      return;
    }
    const settings = withFaviconPatch(current.settings, patch);
    const response = await request(settingsRoute, { body: { revision: current.revision, settings } });
    if (response.status === 409) continue;
    const restored = parseJson(response, 'Restore favicon');
    assert.equal(response.status, 200, JSON.stringify(restored));
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.deepEqual(restored.payload.settings, settings, 'Restore must retain SVG and every other current setting');
    restoredSnapshot = restored.payload;
    restoration = concurrentSlots.length ? 'original-slots-restored-concurrent-user-favicon-preserved' : 'original-favicon-restored';
    return;
  }
  throw new Error('Favicon restore hit repeated revision conflicts; inspect favicon-upload-cleanup.json');
}

const sampleA = await fixture('favicon-verification-a', 'png', 64);
const sampleB = await fixture('favicon-verification-b', 'png', 96);
const sampleTouch = await fixture('favicon-verification-touch', 'appleTouchIcon', 80);
const temporary = { png: sampleA.path, appleTouchIcon: sampleTouch.path };

try {
  before = (await api(settingsRoute)).payload;
  for (const slot of slots) {
    const path = faviconValue(before.settings)[slot];
    if (!path) continue;
    const publicResponse = await request(path, { auth: false, requestOrigin: false, noCache: true });
    assert.equal(publicResponse.status, 200, `Original ${slot} must exist in the published site`);
    const sample = { label: `original-${slot}`, path, sha256: sha256(publicResponse.bytes), publicStatus: publicResponse.status, sourceExists: false };
    originals.push(sample);
    assertPng(publicResponse, sample.sha256, sample.label);
    await verifyPreview(sample, { anonymous: true });
    sample.sourceExists = true;
  }
  console.log(`BASELINE PASS: ${originals.length} saved favicon images exist in public output and authenticated source previews; PNG SHA256 matches`);

  const noLogin = await request(uploadRoute, { auth: false, body: form(sampleA) });
  assert.equal(noLogin.status, 401, 'Unauthenticated upload must be rejected');
  const foreign = await request(uploadRoute, { requestOrigin: 'https://unrelated.example', body: form(sampleA) });
  assert.equal(foreign.status, 403, 'Cross-origin upload must be rejected');
  const getResponse = await request(uploadRoute);
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.allow, 'POST');
  console.log('AUTH PASS: anonymous upload HTTP 401; foreign Origin HTTP 403; authenticated GET HTTP 405 Allow: POST');

  await upload(sampleA);
  await upload(sampleB);
  await verifyPreview(sampleA, { anonymous: true });
  await upload(sampleTouch);
  const duplicate = (await api(uploadRoute, { body: form(sampleA) })).result;
  assert.deepEqual(duplicate, sampleA.uploaded, 'Identical PNG upload must reuse the same immutable file');
  for (const sample of fixtures) await verifyPreview(sample, { anonymous: true });
  await verifyOriginalFiles('after uploads');
  afterUpload = (await api(settingsRoute)).payload;
  assert.equal(afterUpload.revision, before.revision, 'Upload alone must not change settings revision');
  assert.deepEqual(afterUpload.settings, before.settings, 'Upload alone must not save or publish settings');
  console.log('UPLOAD PASS: 64px A, 96px B, 80px touch PNGs uploaded independently; A/B/originals retained; duplicate reused; settings and revision unchanged');
  console.log('PREVIEW PASS: all authenticated previews HTTP 200 image/png with exact bytes and no-store; anonymous previews HTTP 401');

  // Do not probe unpublished public paths: a CDN could retain that otherwise-valid 404.
  if (!uploadOnly) {
    const latest = (await api(settingsRoute)).payload;
    assert.deepEqual(faviconValue(latest.settings), faviconValue(before.settings), 'User changed favicon selection during verification; preserve it');
    const settings = withFaviconPatch(latest.settings, temporary);
    writeAttempted = true;
    const saved = await api(settingsRoute, { body: { revision: latest.revision, settings } });
    savedSnapshot = saved.payload;
    assert.deepEqual(saved.payload.settings, settings, 'Publication must change only PNG/touch paths and retain original SVG and other settings');
    await waitPublicFavicon(temporary, 'temporary favicon publication');
    for (const sample of [sampleA, sampleTouch]) {
      const response = await request(sample.path, { auth: false, requestOrigin: false, noCache: true });
      assertPng(response, sample.sha256, `Published ${sample.label}`);
    }
    console.log('PUBLISH PASS: homepage head uses uploaded PNG/touch icons; public image bytes HTTP 200 exact SHA256; SVG and all other settings preserved');
  }
} catch (error) {
  failure = error;
} finally {
  try {
    if (writeAttempted) {
      await restoreFavicon(temporary);
      await waitPublicFavicon(faviconValue(restoredSnapshot.settings), 'favicon restoration');
      console.log(`RESTORE PASS: ${restoration}; homepage head restored; concurrent user settings preserved`);
    }
    if (before) {
      await verifyOriginalFiles('after restoration');
      for (const sample of fixtures) await verifyPreview(sample);
      console.log('RETENTION PASS: original user icons retain exact SHA256; all uploaded fixtures retained; no image files deleted');
    }
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Favicon verification and restoration both failed') : error;
  } finally {
    const cleanup = {
      uploadOnly, writeAttempted, restoration, restored: !writeAttempted || Boolean(restoredSnapshot),
      originalFavicon: before ? faviconValue(before.settings) : null,
      originals,
      fixtures: fixtures.map(({ bytes, ...sample }) => ({ ...sample, sourceFileRetained: true })),
      snapshots: { before: before ?? null, afterUpload: afterUpload ?? null, saved: savedSnapshot ?? null, restored: restoredSnapshot ?? null },
      imageFilesDeleted: false,
    };
    mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true });
    writeFileSync(new URL('../artifacts/favicon-upload-cleanup.json', import.meta.url), `${JSON.stringify(cleanup, null, 2)}\n`);
    console.log(`CLEANUP_JSON ${JSON.stringify({ uploadOnly, writeAttempted, restoration, restored: cleanup.restored, originals, fixtures: cleanup.fixtures, imageFilesDeleted: false })}`);
    agent.destroy();
  }
}
if (failure) throw failure;
console.log(uploadOnly
  ? 'FAVICON UPLOAD PASS: protected previews, immutable independent uploads, unchanged settings/revision, original PNG bytes retained; no temporary publication'
  : 'FAVICON PASS: protected previews, immutable independent uploads, public head/image publication, original favicon restoration, all user images retained');
