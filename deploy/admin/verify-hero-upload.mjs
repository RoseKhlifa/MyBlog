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
const uploadRoute = '/api/admin/site-assets/hero/';
const settingsRoute = '/api/admin/settings/';
const width = 64;
const height = 48;
const imageBytes = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
const digest = createHash('sha256').update(imageBytes).digest('hex');
const expectedSrc = `src/assets/hero-uploads/hero-${digest}.png`;
let uploaded;
let originalHero;
let originalPublicHero;
let writeAttempted = false;
let restoration = 'not-needed';
let failure;

async function request(route, { method, body, auth = true, requestOrigin = origin } = {}) {
  const headers = { Accept: '*/*', ...(auth ? { Authorization: authorization } : {}) };
  if (requestOrigin !== false) headers.Origin = requestOrigin;
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
  return await new Promise((resolve, reject) => {
    const req = https.request(new URL(route, origin), {
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
    req.setTimeout(30000, () => req.destroy(new Error(`Timeout: ${route}`)));
    req.on('error', reject);
    req.end(bytes);
  });
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

function form(bytes = imageBytes, name = 'hero-upload-verification.png', mimeType = 'image/png') {
  const result = new FormData();
  // Deliberately no collection or entryId: a site Hero is independent of articles and bits.
  result.set('image', new Blob([bytes], { type: mimeType }), name);
  return result;
}

function heroImageSrc(html) {
  const section = html.match(/<div\b[^>]*class="hero"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  return section?.match(/<img\b[^>]*\bsrc="([^"]+)"/)?.[1] ?? null;
}

async function waitPublicHero(predicate, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await request(`/?hero-verification=${Date.now()}`, { auth: false, requestOrigin: false });
    const src = heroImageSrc(response.text);
    if (response.status === 200 && predicate(src, response.text)) return { src, html: response.text };
    if (attempt % 15 === 0) {
      const stateResponse = await request('/_publish/status');
      assert.equal(stateResponse.status, 200);
      const state = parseJson(stateResponse, 'Publisher status');
      console.log(`WAIT ${label}: publisher=${state.state ?? 'pending'}`);
    }
    await delay(2000);
  }
  throw new Error(`Public homepage did not reach ${label}`);
}

async function restoreHero() {
  // Always merge into the latest complete snapshot and retry revision conflicts.
  // Only our temporary Hero value may be replaced; a concurrent user selection wins.
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = (await api(settingsRoute)).payload;
    if (current.settings.home.heroImageSrc !== uploaded.src) {
      if (current.settings.home.heroImageSrc === originalHero) {
        restoration = 'original-already-restored';
        return;
      }
      restoration = 'concurrent-user-hero-preserved';
      console.log('RESTORE PASS: concurrent user Hero selection preserved; no settings overwritten');
      return;
    }
    const settings = {
      ...current.settings,
      home: { ...current.settings.home, heroImageSrc: originalHero },
    };
    const response = await request(settingsRoute, { body: { revision: current.revision, settings } });
    if (response.status === 409) continue;
    const result = parseJson(response, 'Restore Hero');
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.payload.settings.home.heroImageSrc, originalHero);
    assert.deepEqual(result.payload.settings, settings, 'Restore must preserve every other current setting');
    restoration = 'original-hero-restored';
    return;
  }
  throw new Error('Hero restore hit repeated concurrent revision conflicts; inspect hero-upload-cleanup.json');
}

try {
  const noLogin = await request(uploadRoute, { auth: false, body: form() });
  assert.equal(noLogin.status, 401, 'Unauthenticated upload must be rejected');
  console.log('AUTH PASS: unauthenticated Hero upload HTTP 401');
  const foreign = await request(uploadRoute, { requestOrigin: 'https://unrelated.example', body: form() });
  assert.equal(foreign.status, 403, 'Cross-origin upload must be rejected');
  console.log('ORIGIN PASS: cross-origin Hero upload HTTP 403');
  const getResponse = await request(uploadRoute);
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.allow, 'POST');
  console.log('METHOD PASS: authenticated GET HTTP 405 Allow: POST');

  const before = (await api(settingsRoute)).payload;
  originalHero = before.settings.home.heroImageSrc;
  const home = await request('/', { auth: false, requestOrigin: false });
  assert.equal(home.status, 200);
  originalPublicHero = heroImageSrc(home.text);
  if (!uploadOnly) {
    assert.notEqual(before.settings.home.heroPresetId, 'none', 'Hero is hidden; use --upload-only to preserve the user display setting');
    assert(originalPublicHero, 'Expected an existing public Hero before the temporary publication test');
  }

  for (const sample of [
    { label: 'mismatched MIME', bytes: imageBytes, name: 'wrong-mime.png', type: 'image/jpeg' },
    { label: 'corrupt PNG', bytes: Buffer.from('not a valid PNG'), name: 'broken.png', type: 'image/png' },
    { label: 'SVG', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"/>'), name: 'vector.svg', type: 'image/svg+xml' },
  ]) {
    const response = await request(uploadRoute, { body: form(sample.bytes, sample.name, sample.type) });
    assert.equal(response.status, 400, `${sample.label} must be rejected`);
    assert.equal(parseJson(response, sample.label).ok, false);
    console.log(`VALIDATION PASS: ${sample.label} HTTP 400`);
  }

  uploaded = (await api(uploadRoute, { body: form() })).result;
  assert.equal(uploaded.src, expectedSrc);
  assert.equal(uploaded.path, expectedSrc);
  assert.equal(uploaded.fileName, `hero-${digest}.png`);
  assert.equal(uploaded.width, width);
  assert.equal(uploaded.height, height);
  assert.equal(uploaded.size, imageBytes.length);
  assert.equal(uploaded.mimeType, 'image/png');
  const afterUpload = (await api(settingsRoute)).payload;
  assert.equal(afterUpload.revision, before.revision, 'Upload alone must not save or publish theme settings');
  assert.deepEqual(afterUpload.settings, before.settings);
  console.log(`UPLOAD PASS: image-only multipart; ${width}x${height} PNG; SHA256 filename; no article/bit created; settings and revision unchanged`);

  const params = new URLSearchParams({ field: 'home.heroImageSrc', value: uploaded.src });
  const meta = (await api(`/api/admin/images/meta/?${params}`)).result;
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
  assert.equal(meta.size, imageBytes.length);
  assert.equal(meta.mimeType, 'image/png');
  assert(meta.previewSrc, 'Expected a preview image URL');
  const preview = await request(meta.previewSrc);
  assert.equal(preview.status, 200);
  assert.match(preview.headers['content-type'] ?? '', /^image\/png\b/);
  assert(preview.bytes.equals(imageBytes), 'Preview must return the unchanged original image bytes');
  const privatePreview = await request(meta.previewSrc, { auth: false });
  assert.equal(privatePreview.status, 401, 'Source image preview must require login');
  console.log('PREVIEW PASS: metadata and authenticated source image HTTP 200; exact PNG bytes; anonymous HTTP 401');

  if (!uploadOnly) {
    const latest = (await api(settingsRoute)).payload;
    assert.equal(latest.settings.home.heroImageSrc, originalHero, 'User changed the Hero during the test; preserve their selection');
    const settings = { ...latest.settings, home: { ...latest.settings.home, heroImageSrc: uploaded.src } };
    writeAttempted = true;
    const saved = await api(settingsRoute, { body: { revision: latest.revision, settings } });
    assert.equal(saved.payload.settings.home.heroImageSrc, uploaded.src);
    assert.deepEqual(saved.payload.settings, settings, 'Only the Hero source should change');
    const published = await waitPublicHero((src) => src?.includes(`hero-${digest}`), 'uploaded Hero publication');
    const publicImage = await request(published.src, { auth: false, requestOrigin: false });
    assert.equal(publicImage.status, 200);
    assert.match(publicImage.headers['content-type'] ?? '', /^image\/(png|webp|avif)\b/);
    const publicMeta = await sharp(publicImage.bytes).metadata();
    assert(publicMeta.width > 0 && publicMeta.height > 0);
    assert.equal(publicMeta.width * height, publicMeta.height * width, 'Published image must retain the uploaded aspect ratio');
    console.log(`PUBLISH PASS: public homepage references uploaded Hero; public image HTTP 200 ${publicImage.headers['content-type']}`);
  }
} catch (error) {
  failure = error;
} finally {
  try {
    if (writeAttempted && uploaded) {
      await restoreHero();
      if (restoration !== 'concurrent-user-hero-preserved') {
        await waitPublicHero((src) => src === originalPublicHero, 'original Hero restoration');
        console.log('RESTORE PASS: original Hero setting and public homepage restored; other current settings preserved');
      }
    }
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Hero verification and restoration both failed') : error;
  } finally {
    if (uploaded) {
      const cleanup = { src: uploaded.src, sha256: digest, uploadOnly, writeAttempted, restoration, sourceFileRetained: true };
      mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true });
      writeFileSync(new URL('../artifacts/hero-upload-cleanup.json', import.meta.url), `${JSON.stringify(cleanup, null, 2)}\n`);
      console.log(`CLEANUP_JSON ${JSON.stringify(cleanup)}`);
    }
    agent.destroy();
  }
}
if (failure) throw failure;
console.log(uploadOnly
  ? 'HERO UPLOAD PASS: direct upload, validation, protected preview, unchanged settings; no temporary publication'
  : 'HERO PASS: direct upload, validation, protected preview, automatic public publication, original Hero restored');
