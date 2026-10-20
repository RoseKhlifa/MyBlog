import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import sharp from 'sharp';

// Read-only live acceptance; never uploads an icon or writes theme settings.
// Run after deployment: node --use-env-proxy deploy/admin/verify-favicon-delivery.mjs
const origin = new URL(process.env.ADMIN_ORIGIN || 'https://blog.rosekhlifa.com').origin;
const agent = new https.Agent({ keepAlive: true, proxyEnv: process.env });
const credentials = readFileSync(new URL('../artifacts/online-admin-login.txt', import.meta.url), 'utf8');
const username = credentials.match(/^Username: (.+)$/m)?.[1].trim();
const password = credentials.match(/^Password: (.+)$/m)?.[1].trim();
assert(username && password, 'Expected local administrator credentials');
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const reportDirectory = new URL('../artifacts/favicon-live/', import.meta.url);
const reportPath = new URL('delivery.json', reportDirectory);
const expectedOriginalPath = new URL('uploaded-original.png', reportDirectory);
const expectedOriginal = readFileSync(expectedOriginalPath);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sizes = [16, 32, 48];
/** @type {Record<string, any>} */
const report = {
  startedAt: new Date().toISOString(), origin, readOnly: true,
  originalSha256: sha256(expectedOriginal), requests: [], pages: [], png: [], ico: [],
};

async function request(route, { auth = false, redirects = 0 } = {}) {
  const url = new URL(route, origin);
  assert.equal(url.origin, origin, 'Only this deployment origin may be requested');
  const response = await new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent,
      headers: {
        Accept: '*/*', 'Cache-Control': 'no-cache',
        ...(auth ? { Authorization: authorization } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`Request timed out: ${url.pathname}`)));
  });
  report.requests.push({
    route: `${url.pathname}${url.search}`, authenticated: auth,
    status: response.status, contentType: response.headers['content-type'] ?? null,
    cacheControl: response.headers['cache-control'] ?? null,
    cacheStatus: response.headers['cf-cache-status'] ?? null,
    byteLength: response.bytes.length, sha256: sha256(response.bytes),
  });
  if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
    assert(redirects < 4, `Excess redirects: ${url.pathname}`);
    const next = new URL(response.headers.location, url);
    assert.equal(next.origin, origin, 'Credentials must never be forwarded to another origin');
    return request(next, { auth, redirects: redirects + 1 });
  }
  return response;
}

function cacheBust(route) {
  const url = new URL(route, origin);
  url.searchParams.set('favicon-verification', String(Date.now()));
  return url;
}

async function readSettings() {
  const response = await request('/api/admin/settings/', { auth: true });
  assert.equal(response.status, 200, 'Authenticated settings GET');
  const data = JSON.parse(response.bytes.toString('utf8'));
  assert.equal(data.ok, true, 'Settings API reports success');
  assert(data.payload?.settings?.site?.favicon, 'Settings API provides favicon slots');
  return data.payload;
}

const decodeEntities = (text) => text.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
function iconLinks(html) {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
  assert(head, 'Page includes an HTML head');
  const links = [];
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = {};
    for (const [, name, value] of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) attrs[name.toLowerCase()] = decodeEntities(value);
    if (!['icon', 'apple-touch-icon', 'shortcut icon'].includes(attrs.rel)) continue;
    assert(attrs.href, 'Icon links provide a URL');
    const href = new URL(attrs.href, origin);
    assert.equal(href.origin, origin, 'Icon links stay on the deployment origin');
    links.push({ rel: attrs.rel, type: attrs.type ?? '', sizes: attrs.sizes ?? '', href: `${href.pathname}${href.search}` });
  }
  assert(links.length > 0, 'Page declares browser icons');
  return links;
}

async function expectedPixels(source, size) {
  return sharp(source).rotate().resize(size, size, {
    fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 },
  }).ensureAlpha().raw().toBuffer();
}

async function checkPng(bytes, size, source, label) {
  const metadata = await sharp(bytes, { failOn: 'warning' }).metadata();
  assert.equal(metadata.format, 'png', `${label}: valid PNG bytes`);
  assert.equal(metadata.width, size, `${label}: actual width`);
  assert.equal(metadata.height, size, `${label}: actual height`);
  const actual = await sharp(bytes, { failOn: 'warning' }).ensureAlpha().raw().toBuffer();
  const expected = await expectedPixels(source, size);
  assert(actual.equals(expected), `${label}: pixels must match resized saved original`);
  return { size, sha256: sha256(bytes), rgbaSha256: sha256(actual), matchesOriginalVisual: true };
}

async function decodeIco(bytes, original) {
  assert(bytes.length >= 6, 'ICO header exists');
  assert.equal(bytes.readUInt16LE(0), 0, 'ICO reserved field');
  assert.equal(bytes.readUInt16LE(2), 1, 'ICO type is icon');
  const count = bytes.readUInt16LE(4);
  assert.equal(count, sizes.length, 'ICO supplies each expected frame');
  assert(bytes.length >= 6 + count * 16, 'ICO directory is complete');
  const frames = [];
  let previousEnd = 6 + count * 16;
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16;
    const width = bytes[offset] || 256;
    const height = bytes[offset + 1] || 256;
    const byteLength = bytes.readUInt32LE(offset + 8);
    const imageOffset = bytes.readUInt32LE(offset + 12);
    assert.equal(width, sizes[index], 'ICO frame width/order');
    assert.equal(height, sizes[index], 'ICO frame height/order');
    assert(imageOffset >= previousEnd, 'ICO frame payloads must not overlap');
    assert(byteLength > 0 && imageOffset + byteLength <= bytes.length, 'ICO frame payload stays inside file');
    const frame = bytes.subarray(imageOffset, imageOffset + byteLength);
    let pixels;
    let encoding;
    if (frame.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      await checkPng(frame, width, original, `ICO ${width}x${height} PNG frame`);
      pixels = await sharp(frame).ensureAlpha().raw().toBuffer();
      encoding = 'png';
    } else {
      assert(frame.length >= 40, 'ICO DIB header exists');
      assert.equal(frame.readUInt32LE(0), 40, 'ICO DIB uses BITMAPINFOHEADER');
      assert.equal(frame.readInt32LE(4), width, 'ICO DIB actual width');
      assert.equal(frame.readInt32LE(8), height * 2, 'ICO DIB includes XOR and AND heights');
      assert.equal(frame.readUInt16LE(12), 1, 'ICO DIB plane count');
      assert.equal(frame.readUInt16LE(14), 32, 'ICO DIB has BGRA pixels');
      assert.equal(frame.readUInt32LE(16), 0, 'ICO DIB is uncompressed');
      const xorLength = width * height * 4;
      const maskStride = Math.ceil(width / 32) * 4;
      assert.equal(frame.length, 40 + xorLength + maskStride * height, 'ICO DIB has complete color and alpha masks');
      pixels = Buffer.alloc(xorLength);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const from = 40 + ((height - y - 1) * width + x) * 4;
          const to = (y * width + x) * 4;
          pixels[to] = frame[from + 2];
          pixels[to + 1] = frame[from + 1];
          pixels[to + 2] = frame[from];
          pixels[to + 3] = frame[from + 3];
          const mask = frame[40 + xorLength + (height - y - 1) * maskStride + (x >> 3)] & (0x80 >> (x & 7));
          assert.equal(Boolean(mask), pixels[to + 3] === 0, 'ICO AND mask matches transparent pixels');
        }
      }
      encoding = 'bgra-dib';
    }
    assert(pixels.equals(await expectedPixels(original, width)), `ICO ${width}x${height}: visual matches saved original`);
    frames.push({ width, height, encoding, byteLength, rgbaSha256: sha256(pixels), matchesOriginalVisual: true });
    previousEnd = imageOffset + byteLength;
  }
  assert.equal(previousEnd, bytes.length, 'ICO has no unexpected trailing payload');
  return frames;
}

try {
  const before = await readSettings();
  const favicon = before.settings.site.favicon;
  report.favicon = favicon;
  assert.equal(favicon.svg, null, 'Current PNG selection must suppress an obsolete SVG');
  assert.match(favicon.png, /^\/images\/site\/favicon-\d+x\d+-[0-9a-f]{8}\.png$/, 'Saved icon is the selected uploaded PNG');
  const sourceResponse = await request(cacheBust(favicon.png));
  assert.equal(sourceResponse.status, 200, 'Public saved original GET');
  assert.match(sourceResponse.headers['content-type'] ?? '', /^image\/png(?:;|$)/i);
  assert(sourceResponse.bytes.equals(expectedOriginal), 'Original uploaded PNG bytes/hash remain unchanged');
  const originalMetadata = await sharp(sourceResponse.bytes, { failOn: 'warning' }).metadata();
  assert.equal(originalMetadata.format, 'png');
  report.original = { path: favicon.png, width: originalMetadata.width, height: originalMetadata.height, byteLength: sourceResponse.bytes.length, sha256: sha256(sourceResponse.bytes) };
  console.log('ORIGINAL PASS: saved uploaded PNG bytes and SHA256 unchanged');

  let sharedLinks;
  for (const [route, auth] of [['/', false], ['/archive/content-console-guide/', false], ['/admin/theme/', true]]) {
    const response = await request(cacheBust(route), { auth });
    assert.equal(response.status, 200, `${route}: page GET`);
    assert.match(response.headers['content-type'] ?? '', /^text\/html(?:;|$)/i);
    const links = iconLinks(response.bytes.toString('utf8'));
    if (sharedLinks) assert.deepEqual(links, sharedLinks, `${route}: icon links match homepage`);
    else sharedLinks = links;
    report.pages.push({ route, authenticated: auth, status: response.status, icons: links });
  }
  const pngLinks = sharedLinks.filter((link) => link.rel === 'icon' && link.type === 'image/png');
  assert.deepEqual(pngLinks.map((link) => link.sizes), sizes.map((size) => `${size}x${size}`), 'Head supplies correctly labeled 16/32/48 PNG icons');
  const icoLinks = sharedLinks.filter((link) => link.rel === 'icon' && /image\/(?:x-icon|vnd\.microsoft\.icon)/.test(link.type));
  assert.equal(icoLinks.length, 1, 'Head provides one versioned ICO');
  assert.equal(icoLinks[0].sizes, sizes.map((size) => `${size}x${size}`).join(' '));
  assert(!sharedLinks.some((link) => link.rel === 'icon' && link.type === 'image/svg+xml'), 'Custom PNG selection has no competing SVG');
  const apple = sharedLinks.filter((link) => link.rel === 'apple-touch-icon');
  assert.equal(apple.length, 1, 'Head retains the touch icon');
  assert.equal(apple[0].href, favicon.appleTouchIcon, 'Saved touch icon selection is preserved');
  const hash = pngLinks[0].href.match(/^\/images\/site\/generated\/favicon-([0-9a-f]{20})-16x16\.png$/)?.[1];
  assert(hash, 'Generated icon path has a versioned content hash');
  for (let index = 0; index < sizes.length; index++) {
    const size = sizes[index];
    assert.equal(pngLinks[index].href, `/images/site/generated/favicon-${hash}-${size}x${size}.png`);
    const response = await request(cacheBust(pngLinks[index].href));
    assert.equal(response.status, 200, `Public ${size}px PNG GET`);
    assert.match(response.headers['content-type'] ?? '', /^image\/png(?:;|$)/i);
    report.png.push({ path: pngLinks[index].href, ...await checkPng(response.bytes, size, expectedOriginal, `${size}px public icon`) });
  }
  console.log('HEAD/PNG PASS: homepage/article/admin share versioned 16/32/48 PNG links; every decoded pixel matches saved original');

  assert.equal(icoLinks[0].href, `/images/site/generated/favicon-${hash}.ico`);
  const icoResponse = await request(cacheBust(icoLinks[0].href));
  assert.equal(icoResponse.status, 200, 'Public versioned ICO GET');
  assert.match(icoResponse.headers['content-type'] ?? '', /^image\/(?:x-icon|vnd\.microsoft\.icon)(?:;|$)/i);
  report.ico = await decodeIco(icoResponse.bytes, expectedOriginal);
  const rootIcoResponse = await request(cacheBust('/favicon.ico'));
  assert.equal(rootIcoResponse.status, 200, 'Public root favicon.ico cache-busted GET');
  assert.match(rootIcoResponse.headers['content-type'] ?? '', /^image\/(?:x-icon|vnd\.microsoft\.icon)(?:;|$)/i);
  assert(rootIcoResponse.bytes.equals(icoResponse.bytes), 'Root and versioned ICO have identical bytes/hash');
  report.icoSha256 = sha256(icoResponse.bytes);
  console.log('ICO PASS: versioned ICO and /favicon.ico HTTP 200; valid 16/32/48 frames match saved original; hashes identical');

  for (const path of [...new Set([favicon.png, favicon.appleTouchIcon].filter(Boolean))]) {
    const preview = `/api/admin/site-assets/favicon-preview/${path.split('/').at(-1)}/`;
    const publicOriginal = await request(cacheBust(path));
    assert.equal(publicOriginal.status, 200, 'Saved original public GET');
    const loggedIn = await request(preview, { auth: true });
    assert.equal(loggedIn.status, 200, 'Authenticated favicon preview GET');
    assert.match(loggedIn.headers['content-type'] ?? '', /^image\/png(?:;|$)/i);
    assert.match(loggedIn.headers['cache-control'] ?? '', /private/);
    assert.match(loggedIn.headers['cache-control'] ?? '', /no-store/);
    assert(loggedIn.bytes.equals(publicOriginal.bytes), 'Protected preview preserves original bytes');
    await sharp(loggedIn.bytes, { failOn: 'warning' }).raw().toBuffer();
    const loggedOut = await request(preview);
    assert.equal(loggedOut.status, 401, 'Anonymous protected favicon preview GET');
  }
  const after = await readSettings();
  assert.equal(after.revision, before.revision, 'Theme revision remains unchanged throughout read-only verification');
  assert.deepEqual(after.settings, before.settings, 'All theme settings remain unchanged');
  console.log('PREVIEW PASS: authenticated PNG preview HTTP 200 private/no-store; anonymous HTTP 401; saved settings unchanged');
  report.result = 'PASS';
  console.log('FAVICON DELIVERY PASS: selected original preserved; public/admin heads consistent; 16/32/48 PNG and valid ICO delivered; protected preview authenticated');
} catch (error) {
  report.result = 'FAIL';
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(`FAVICON DELIVERY FAIL: ${report.error}`);
} finally {
  report.finishedAt = new Date().toISOString();
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  agent.destroy();
}
