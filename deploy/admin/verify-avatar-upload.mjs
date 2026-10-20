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
const uploadRoute = '/api/admin/site-assets/avatar/';
const settingsRoute = '/api/admin/settings/';
const width = 48;
const height = 40;
const imageBytes = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
const digest = createHash('sha256').update(imageBytes).digest('hex');
const fileName = `avatar-${digest}.png`;
const expectedSrc = `author/uploads/${fileName}`;
let uploaded;
let originalAvatar;
let writeAttempted = false;
let publicationSkipped = false;
let restoration = 'not-needed';
let failure;

async function request(route, { method, body, auth = true, requestOrigin = origin, redirects = 0 } = {}) {
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
  const response = await new Promise((resolve, reject) => {
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
  if (response.headers.location && [301, 302, 303, 307, 308].includes(response.status) && body === undefined && (!method || method === 'GET')) {
    assert(redirects < 4, `Too many redirects: ${route}`);
    const target = new URL(response.headers.location, new URL(route, origin));
    assert.equal(target.origin, origin, 'Verification must never forward administrator credentials to a different origin');
    return await request(target, { method, auth, requestOrigin, redirects: redirects + 1 });
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

function form(bytes = imageBytes, name = 'avatar-upload-verification.png', mimeType = 'image/png') {
  const result = new FormData();
  // The site avatar upload contains only an image, with no article, collection, or bit.
  result.set('image', new Blob([bytes], { type: mimeType }), name);
  return result;
}

const avatarValue = (settings) => settings.page.bits.defaultAuthor.avatar;
const withAvatar = (settings, avatar) => ({
  ...settings,
  page: {
    ...settings.page,
    bits: {
      ...settings.page.bits,
      defaultAuthor: { ...settings.page.bits.defaultAuthor, avatar },
    },
  },
});

function avatarImageSources(html) {
  const images = [];
  const containers = html.matchAll(/<div\b[^>]*\bclass=["'](?:[^"']*\s)?avatar(?:\s[^"']*)?["'][^>]*>([\s\S]*?)<\/div>/g);
  for (const [, contents] of containers) {
    const src = contents.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/)?.[1];
    if (src) images.push(src);
  }
  return images;
}

function hasAvatar(sources, src) {
  const expected = new URL(src, `${origin}/`).pathname;
  return sources.some((source) => new URL(source, `${origin}/`).pathname === expected);
}

async function waitPublicAvatar(predicate, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await request(`/bits/?avatar-verification=${Date.now()}`, { auth: false, requestOrigin: false });
    const sources = avatarImageSources(response.text);
    if (response.status === 200 && predicate(sources, response.text)) return { sources, html: response.text };
    if (attempt % 15 === 0) {
      const stateResponse = await request('/_publish/status');
      assert.equal(stateResponse.status, 200);
      const state = parseJson(stateResponse, 'Publisher status');
      console.log(`WAIT ${label}: publisher=${state.state ?? 'pending'}`);
    }
    await delay(2000);
  }
  throw new Error(`Public /bits/ did not reach ${label}`);
}

async function restoreAvatar() {
  // Merge only our temporary avatar into the latest revision. A user's newer avatar wins.
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = (await api(settingsRoute)).payload;
    if (avatarValue(current.settings) !== uploaded.src) {
      if (avatarValue(current.settings) === originalAvatar) {
        restoration = 'original-already-restored';
        return;
      }
      restoration = 'concurrent-user-avatar-preserved';
      console.log('RESTORE PASS: concurrent user avatar selection preserved; no settings overwritten');
      return;
    }
    const settings = withAvatar(current.settings, originalAvatar);
    const response = await request(settingsRoute, { body: { revision: current.revision, settings } });
    if (response.status === 409) continue;
    const result = parseJson(response, 'Restore avatar');
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(avatarValue(result.payload.settings), originalAvatar);
    assert.deepEqual(result.payload.settings, settings, 'Restore must preserve the author name and every other current setting');
    restoration = 'original-avatar-restored';
    return;
  }
  throw new Error('Avatar restore hit repeated concurrent revision conflicts; inspect avatar-upload-cleanup.json');
}

try {
  const noLogin = await request(uploadRoute, { auth: false, body: form() });
  assert.equal(noLogin.status, 401, 'Unauthenticated upload must be rejected');
  console.log('AUTH PASS: unauthenticated avatar upload HTTP 401');
  const foreign = await request(uploadRoute, { requestOrigin: 'https://unrelated.example', body: form() });
  assert.equal(foreign.status, 403, 'Cross-origin upload must be rejected');
  console.log('ORIGIN PASS: cross-origin avatar upload HTTP 403');
  const getResponse = await request(uploadRoute);
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.allow, 'POST');
  console.log('METHOD PASS: authenticated GET HTTP 405 Allow: POST');

  const before = (await api(settingsRoute)).payload;
  originalAvatar = avatarValue(before.settings);

  for (const sample of [
    { label: 'mismatched MIME', bytes: imageBytes, name: 'wrong-mime.png', type: 'image/jpeg' },
    { label: 'corrupt PNG', bytes: Buffer.from('not a valid PNG'), name: 'broken.png', type: 'image/png' },
    { label: 'SVG', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="40"/>'), name: 'vector.svg', type: 'image/svg+xml' },
  ]) {
    const response = await request(uploadRoute, { body: form(sample.bytes, sample.name, sample.type) });
    assert.equal(response.status, 400, `${sample.label} must be rejected`);
    assert.equal(parseJson(response, sample.label).ok, false);
    console.log(`VALIDATION PASS: ${sample.label} HTTP 400`);
  }

  uploaded = (await api(uploadRoute, { body: form() })).result;
  assert.equal(uploaded.src, expectedSrc);
  assert.equal(uploaded.path, `public/${expectedSrc}`);
  assert.equal(uploaded.fileName, fileName);
  assert.equal(uploaded.width, width);
  assert.equal(uploaded.height, height);
  assert.equal(uploaded.size, imageBytes.length);
  assert.equal(uploaded.mimeType, 'image/png');
  const duplicate = (await api(uploadRoute, { body: form() })).result;
  assert.equal(duplicate.src, uploaded.src, 'Repeated identical content must reuse the same source');
  assert.equal(duplicate.path, uploaded.path, 'Repeated identical content must reuse the same file');
  const afterUpload = (await api(settingsRoute)).payload;
  assert.equal(afterUpload.revision, before.revision, 'Upload alone must not save or publish theme settings');
  assert.deepEqual(afterUpload.settings, before.settings);
  console.log(`UPLOAD PASS: image-only multipart; non-square ${width}x${height} PNG; SHA256 filename; duplicate reuses path; settings and revision unchanged`);

  const params = new URLSearchParams({ field: 'page.bits.defaultAuthor.avatar', value: uploaded.src });
  const meta = (await api(`/api/admin/images/meta/?${params}`)).result;
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
  assert.equal(meta.size, imageBytes.length);
  assert.equal(meta.mimeType, 'image/png');
  assert.equal(meta.previewSrc?.replace(/\/$/, ''), `/api/admin/site-assets/avatar-preview/${fileName}`);
  const preview = await request(meta.previewSrc);
  assert.equal(preview.status, 200);
  assert.match(preview.headers['content-type'] ?? '', /^image\/png\b/);
  assert(preview.bytes.equals(imageBytes), 'Preview must return the unchanged original image bytes');
  const privatePreview = await request(meta.previewSrc, { auth: false });
  assert.equal(privatePreview.status, 401, 'Unpublished source image preview must require login');
  console.log('PREVIEW PASS: metadata and authenticated source image HTTP 200; exact PNG bytes; anonymous HTTP 401');

  if (!uploadOnly) {
    const bits = await request('/bits/', { auth: false, requestOrigin: false });
    assert.equal(bits.status, 200);
    if (!originalAvatar || !hasAvatar(avatarImageSources(bits.text), originalAvatar)) {
      publicationSkipped = true;
      console.log('PUBLISH SKIPPED: no visible /bits/ card uses the current default avatar; upload/preview verified without creating a bit or changing settings');
    } else {
      const latest = (await api(settingsRoute)).payload;
      assert.equal(avatarValue(latest.settings), originalAvatar, 'User changed the avatar during the test; preserve their selection');
      const settings = withAvatar(latest.settings, uploaded.src);
      writeAttempted = true;
      const saved = await api(settingsRoute, { body: { revision: latest.revision, settings } });
      assert.equal(avatarValue(saved.payload.settings), uploaded.src);
      assert.deepEqual(saved.payload.settings, settings, 'Only the default avatar source should change; author name must be retained');
      const published = await waitPublicAvatar((sources) => hasAvatar(sources, uploaded.src), 'uploaded default avatar publication');
      const publicSrc = published.sources.find((source) => hasAvatar([source], uploaded.src));
      const publicImage = await request(publicSrc, { auth: false, requestOrigin: false });
      assert.equal(publicImage.status, 200);
      assert.match(publicImage.headers['content-type'] ?? '', /^image\/png\b/);
      assert(publicImage.bytes.equals(imageBytes), 'Public avatar must retain the uploaded original bytes');
      console.log(`PUBLISH PASS: public /bits/ avatar references /${uploaded.src}; public image HTTP 200 image/png; author name and other settings preserved`);
    }
  }
} catch (error) {
  failure = error;
} finally {
  try {
    if (writeAttempted && uploaded) {
      await restoreAvatar();
      if (restoration !== 'concurrent-user-avatar-preserved') {
        await waitPublicAvatar((sources) => !hasAvatar(sources, uploaded.src) && hasAvatar(sources, originalAvatar), 'original default avatar restoration');
        console.log('RESTORE PASS: original default avatar setting and public /bits/ restored; author name and all other current settings preserved');
      }
    }
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Avatar verification and restoration both failed') : error;
  } finally {
    if (uploaded) {
      const cleanup = { src: uploaded.src, path: uploaded.path, sha256: digest, uploadOnly, publicationSkipped, writeAttempted, restoration, sourceFileRetained: true };
      mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true });
      writeFileSync(new URL('../artifacts/avatar-upload-cleanup.json', import.meta.url), `${JSON.stringify(cleanup, null, 2)}\n`);
      console.log(`CLEANUP_JSON ${JSON.stringify(cleanup)}`);
    }
    agent.destroy();
  }
}
if (failure) throw failure;
console.log(uploadOnly || publicationSkipped
  ? 'AVATAR UPLOAD PASS: direct upload, validation, duplicate reuse, protected preview, unchanged settings; no temporary publication'
  : 'AVATAR PASS: direct upload, validation, duplicate reuse, protected preview, automatic public publication, original default avatar restored');
