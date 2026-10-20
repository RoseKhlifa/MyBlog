import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';

// Creates and removes only its unique acceptance article. Run from this checkout.
// node --use-env-proxy deploy/admin/verify-visibility.mjs [--private-only] [--verify-origin-ssh]
// --verify-origin-ssh records domain cache observations and checks the current
// origin release over the existing SSH connection for this specific deployment.
const origin = new URL(process.env.ADMIN_ORIGIN || 'https://blog.rosekhlifa.com').origin;
const publicOrigin = new URL(process.env.VERIFY_PUBLIC_ORIGIN || origin).origin;
const credentials = readFileSync(new URL('../artifacts/online-admin-login.txt', import.meta.url), 'utf8');
const username = credentials.match(/^Username: (.+)$/m)?.[1].trim();
const password = credentials.match(/^Password: (.+)$/m)?.[1].trim();
assert(username && password, 'Expected the local administrator login file');
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const agents = new Map();
const privateOnly = process.argv.includes('--private-only');
const entryId = `visibility-smoke-${Date.now()}-${randomBytes(3).toString('hex')}`;
const title = `Temporary visibility verification ${entryId}`;
const marker = `VISIBILITY-BODY-${randomBytes(16).toString('hex')}`;
const privateTag = `visibility-only-${randomBytes(6).toString('hex')}`;
const readerRoute = `/admin/reader/${entryId}/`;
const entryRoute = `/api/admin/content/entry/?${new URLSearchParams({ collection: 'essay', entryId })}`;
const articleRoute = `/archive/${entryId}/`;
const maxAttempts = Number(process.env.VISIBILITY_VERIFY_ATTEMPTS || 180);
const reportPath = new URL('../artifacts/visibility-cleanup.json', import.meta.url);
const publicImageUrls = new Set();
const attachmentRemovalResults = [];
let current;
let created = false;
let uploaded;
let privateImageUrl;
let removed;
let failure;
let cleanupFailure;
let lastPublication;

const width = 47;
const height = 41;
const imageBytes = await sharp(randomBytes(width * height * 3), {
  raw: { width, height, channels: 3 },
}).png().toBuffer();
const imageSha256 = createHash('sha256').update(imageBytes).digest('hex');

function agentFor(target) {
  if (agents.has(target.origin)) return agents.get(target.origin);
  const options = { keepAlive: true, proxyEnv: process.env };
  if (target.protocol === 'https:' && target.hostname === '51.83.101.143') {
    options.ca = readFileSync(new URL('../artifacts/online-admin-server.crt', import.meta.url));
  }
  const agent = target.protocol === 'https:' ? new https.Agent(options) : new http.Agent(options);
  agents.set(target.origin, agent);
  return agent;
}

async function request(route, { body, auth = true, base = origin, accept = '*/*', redirects = 0, follow = false } = {}) {
  const target = new URL(route, base);
  assert(['http:', 'https:'].includes(target.protocol), 'Only HTTP(S) requests are supported');
  assert([origin, publicOrigin].includes(target.origin), 'Verification does not contact a third party');
  assert(!auth || target.origin === origin, 'Administrator credentials must remain on the administrator origin');
  const headers = { Accept: accept, 'Cache-Control': 'no-cache' };
  if (auth) headers.Authorization = authorization;
  if (body !== undefined) headers.Origin = origin;
  let bytes;
  if (body instanceof FormData) {
    const form = new Response(body);
    bytes = Buffer.from(await form.arrayBuffer());
    headers['Content-Type'] = form.headers.get('content-type');
  } else if (body !== undefined) {
    bytes = Buffer.from(JSON.stringify(body));
    headers['Content-Type'] = 'application/json';
  }
  if (bytes) headers['Content-Length'] = String(bytes.length);
  const response = await new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, { agent: agentFor(target), headers, method: bytes ? 'POST' : 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseBytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes: responseBytes, text: responseBytes.toString('utf8'), url: target.href });
      });
      res.on('error', reject);
    });
    req.setTimeout(45000, () => req.destroy(new Error(`Timeout requesting ${target.pathname}`)));
    req.on('error', reject);
    req.end(bytes);
  });
  if (follow && response.headers.location && [301, 302, 303, 307, 308].includes(response.status)) {
    assert(body === undefined && redirects < 4, 'Unexpected write redirect or redirect loop');
    const next = new URL(response.headers.location, target);
    assert.equal(next.origin, target.origin, 'Verification must not forward credentials across origins');
    return request(next, { auth, base, accept, follow, redirects: redirects + 1 });
  }
  return response;
}

function json(response, label) {
  try { return JSON.parse(response.text); }
  catch { throw new Error(`${label}: HTTP ${response.status}; expected JSON: ${response.text.slice(0, 180)}`); }
}

async function api(route, body) {
  const response = await request(route, { body });
  const data = json(response, route);
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(data)}`);
  assert.equal(data.ok, true, `${route}: ${JSON.stringify(data)}`);
  return data;
}

async function publisherState() {
  const response = await request(`/_publish/status?visibility-check=${Date.now()}`);
  assert.equal(response.status, 200, 'Authenticated publication status');
  return json(response, 'Publisher status');
}

async function waitPublication(previousRelease, label, expectedPublic) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const state = await publisherState();
    const ready = ['published', 'idle'].includes(state.state ?? state.status)
      && state.releaseId && state.releaseId !== previousRelease;
    if (ready) {
      const article = await request(`${articleRoute}?visibility-check=${Date.now()}`, { auth: false, base: publicOrigin });
      if ((expectedPublic && article.status === 200 && article.text.includes(marker))
        || (!expectedPublic && article.status === 404)) {
        // A second observation avoids accepting a momentary intermediate release.
        await delay(2500);
        const stable = await publisherState();
        if (['published', 'idle'].includes(stable.state ?? stable.status) && stable.releaseId === state.releaseId) {
          lastPublication = stable;
          console.log(`PUBLICATION PASS ${label}: release=${stable.releaseId}; article HTTP ${article.status}`);
          return article;
        }
      }
    }
    if (attempt % 15 === 0) console.log(`WAIT ${label}: publisher=${state.state ?? state.status}; release=${state.releaseId ?? 'none'}`);
    await delay(2000);
  }
  throw new Error(`Publisher did not reach ${label} with a new release`);
}

function assertNoPrivateText(response, label) {
  for (const value of [entryId, title, marker, privateTag]) {
    assert(!response.text.includes(value), `${label} disclosed acceptance article ${value === marker ? 'body' : value}`);
  }
}

async function publicSurfaces(expectedVisible) {
  const routes = ['/', '/essay/', '/archive/', '/essay/index.json', '/archive/index.json', '/rss.xml', '/essay/rss.xml', '/archive/rss.xml'];
  for (const route of routes) {
    const response = await request(`${route}${route.includes('?') ? '&' : '?'}visibility-check=${Date.now()}`, { auth: false, base: publicOrigin });
    assert.equal(response.status, 200, `${route}: public HTTP ${response.status}`);
    if (!expectedVisible) assertNoPrivateText(response, route);
    if (expectedVisible && ['/essay/index.json', '/archive/index.json', '/rss.xml', '/essay/rss.xml', '/archive/rss.xml'].includes(route)) {
      assert(response.text.includes(entryId), `${route} omitted the now-public article`);
    }
  }
  const sitemap = await request(`/sitemap-index.xml?visibility-check=${Date.now()}`, { auth: false, base: publicOrigin });
  assert.equal(sitemap.status, 200, 'Sitemap index');
  if (!expectedVisible) assertNoPrivateText(sitemap, 'sitemap-index.xml');
  const sitemapUrls = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(decodeXml(match[1]), publicOrigin));
  assert(sitemapUrls.length > 0, 'Expected at least one child sitemap');
  for (const url of sitemapUrls) {
    // Production canonical URLs are mapped to the selected public test origin.
    assert.equal(url.origin, origin, 'Sitemap child must stay on the configured blog domain');
    const child = await request(`${url.pathname}?visibility-check=${Date.now()}`, { auth: false, base: publicOrigin });
    assert.equal(child.status, 200, `Sitemap ${url.pathname}`);
    if (!expectedVisible) assertNoPrivateText(child, url.pathname);
    else assert(child.text.includes(`/archive/${entryId}/`), 'Public article missing from sitemap');
  }
  if (!expectedVisible) {
    for (const route of [articleRoute, `/essay/${entryId}/`, `/archive/tag/${privateTag}/`]) {
      const response = await request(`${route}?visibility-check=${Date.now()}`, { auth: false, base: publicOrigin });
      assert.equal(response.status, 404, `${route}: private public route must return 404`);
      assertNoPrivateText(response, route);
    }
  }
  console.log(`SURFACES PASS: ${expectedVisible ? 'public article is present' : 'private article/title/body/tag are absent'} in lists/search/RSS/sitemap`);
}

function decodeXml(value) {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function uploadedImageSource(html) {
  const sources = [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/g)].map((match) => decodeXml(match[1]));
  return sources.find((value) => decodeURIComponent(value).includes(uploaded.fileName)
    || decodeURIComponent(value).includes(entryId));
}

async function verifyReader({ privateVisibility = true } = {}) {
  const anonymous = await request(readerRoute, { auth: false });
  assert.equal(anonymous.status, 401, 'Anonymous private reader request must require authentication');
  const anonymousHtml = await request(readerRoute, { auth: false, accept: 'text/html' });
  assert.equal(anonymousHtml.status, 303, 'Browser private reader must redirect to login');
  assert.match(anonymousHtml.headers.location || '', /^\/admin\/login\//);
  assertNoPrivateText(anonymous, 'anonymous reader');
  assert(!anonymousHtml.text.includes(marker), 'Anonymous login redirect disclosed article body');

  const response = await request(readerRoute);
  assert.equal(response.status, 200, `Authenticated reader: ${response.text.slice(0, 120)}`);
  assert(response.text.includes(marker), 'Authenticated reader omitted article body');
  assert(response.text.includes(title), 'Authenticated reader omitted article title');
  assert.match(response.headers['cache-control'] || '', /private/);
  assert.match(response.headers['cache-control'] || '', /no-store/);
  const noindex = `${response.headers['x-robots-tag'] || ''} ${response.text.match(/<meta\b[^>]*name=["']robots["'][^>]*>/i)?.[0] || ''}`;
  assert.match(noindex, /noindex/i, 'Owner reader must discourage indexing');

  const editor = (await api(entryRoute)).payload;
  assert.equal(editor.values.visibility, privateVisibility ? 'private' : 'public');
  assert.equal(editor.values.draft, false, 'Visibility must remain independent from the draft state');
  assert(editor.bodyText.includes(marker), 'Owner editor omitted private content');

  const src = uploadedImageSource(response.text);
  assert(src, 'Owner reader did not render the uploaded image');
  const imageUrl = new URL(src, origin);
  assert.equal(imageUrl.origin, origin, 'Reader attachment must remain on the authenticated origin');
  assert.match(imageUrl.pathname, /^\/(?:_image|src\/|@fs\/|api\/admin\/)/, 'Reader attachment must use a protected source route');
  privateImageUrl = imageUrl.href;
  const image = await request(imageUrl, { follow: true });
  assert.equal(image.status, 200, `Authenticated reader attachment ${imageUrl.href}: ${image.text.slice(0, 160)}`);
  assert.match(image.headers['content-type'] || '', /^image\//);
  assert(image.bytes.length > 0, 'Reader image is empty');
  const anonymousImage = await request(imageUrl, { auth: false });
  assert.equal(anonymousImage.status, 401, 'Private source attachment must require authentication');
  console.log('READER PASS: login required; owner sees title/body/attachment; private no-store/noindex; source image anonymous HTTP 401');
}

async function saveVisibility(visibility) {
  current = (await api(entryRoute)).payload;
  current = (await api('/api/admin/content/entry/', {
    collection: 'essay', entryId, revision: current.revision,
    frontmatter: { ...current.values, draft: false, visibility },
    body: `# Visibility acceptance\n\n${marker}\n\n![${entryId}](${uploaded.src})\n`,
  })).payload;
  assert.equal(current.values.visibility, visibility);
  assert.equal(current.values.draft, false);
}

function writeReport() {
  mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    entryId, title, privateTag, mode: privateOnly ? 'private-only' : 'private-public-private',
    uploadedPath: uploaded?.path, uploadedSrc: uploaded?.src,
    uploadedImageSha256: imageSha256, privateImageUrl,
    publicImageUrls: [...publicImageUrls], attachmentRemovalResults, trashedPath: removed?.trashedPath,
    deletionConfirmed: removed?.deleted === true, lastPublication,
    failure: failure?.message, cleanupFailure: cleanupFailure?.message,
    cleanupNote: 'Only the unique acceptance Markdown is deleted by this script. Move the exact uploadedPath out of source after checking this report; other user images are preserved.',
    updatedAt: new Date().toISOString(),
  }, null, 2) + '\n');
}

try {
  const baseline = await publisherState();
  console.log(`BASELINE: publisher=${baseline.state ?? baseline.status}; release=${baseline.releaseId ?? 'none'}; mode=${privateOnly ? 'private-only' : 'full'}`);
  const frontmatter = {
    title, description: '', date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
    publishedAt: '', updatedAt: '', tagsText: privateTag,
    draft: true, visibility: 'private', archive: true, slug: entryId, cover: '', badge: '',
  };
  current = (await api('/api/admin/content/create/', { collection: 'essay', entryId, frontmatter })).payload;
  created = true;
  assert.equal(current.values.draft, true, 'New articles must initially remain drafts');
  assert.equal(current.values.visibility, 'private', 'Create must preserve private visibility');

  const form = new FormData();
  form.set('collection', 'essay');
  form.set('entryId', entryId);
  form.set('image', new Blob([imageBytes], { type: 'image/png' }), `${entryId}.png`);
  uploaded = (await api('/api/admin/images/upload/', form)).result;
  assert.match(uploaded.path, new RegExp(`^src/content/essay/${entryId}-assets/`), 'Private upload must remain beside its source article');
  assert.match(uploaded.src, /^\.\//);
  writeReport();

  const beforePrivate = await publisherState();
  await saveVisibility('private');
  await waitPublication(beforePrivate.releaseId, 'initial private article', false);
  await verifyReader();
  await publicSurfaces(false);

  if (!privateOnly) {
    const beforePublic = await publisherState();
    await saveVisibility('public');
    const publicArticle = await waitPublication(beforePublic.releaseId, 'private to public', true);
    await publicSurfaces(true);
    const publicSrc = uploadedImageSource(publicArticle.text);
    assert(publicSrc, 'Published article omitted the uploaded image');
    const imageUrl = new URL(publicSrc, publicOrigin);
    assert.equal(imageUrl.origin, publicOrigin, 'Public attachment must remain on the selected blog origin');
    publicImageUrls.add(imageUrl.href);
    const image = await request(imageUrl, { auth: false, base: publicOrigin });
    assert.equal(image.status, 200, 'Published article image');
    assert.match(image.headers['content-type'] || '', /^image\//);
    console.log('PUBLIC PASS: the same saved article and its image are accessible anonymously');

    const beforeHidden = await publisherState();
    await saveVisibility('private');
    await waitPublication(beforeHidden.releaseId, 'public to private', false);
    await publicSurfaces(false);
    await verifyReader();
    for (const url of publicImageUrls) {
      const image = await request(url, { auth: false, base: publicOrigin });
      // Immutable public assets can remain at a CDN after the current release
      // removes them. Check the actual origin independently; retain both results.
      const target = new URL(url);
      assert.equal(target.origin, publicOrigin);
      assert.match(target.pathname, /^\/_astro\/[a-zA-Z0-9._-]+$/);
      let originStatus = image.status;
      if (process.argv.includes('--verify-origin-ssh')) {
        assert.equal(origin, 'https://blog.rosekhlifa.com', 'SSH origin verification belongs to this deployment');
        originStatus = Number(execFileSync('ssh', [
          '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'root@51.83.101.143',
          `curl --max-time 20 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18180${target.pathname}`,
        ], { encoding: 'utf8', timeout: 40000 }).trim());
      }
      attachmentRemovalResults.push({ url, domainStatus: image.status, currentOriginStatus: originStatus,
        cacheControl: image.headers['cache-control'], cacheStatus: image.headers['cf-cache-status'] });
      assert.equal(originStatus, 404, 'Image emitted by the old public version must leave the current origin release when hidden');
      assert([200, 404].includes(image.status), 'Unexpected domain attachment status');
      if (image.status === 200) {
        assert(process.argv.includes('--verify-origin-ssh'), 'Cached public image needs independent origin verification');
        console.log(`CACHE OBSERVATION: formerly public image domain HTTP 200; current origin HTTP 404; cache=${image.headers['cf-cache-status'] ?? 'unspecified'}`);
      }
    }
    console.log('HIDE PASS: public article HTTP 404; emitted image current origin HTTP 404; owner reader still works; past public cache observations retained');
  }
} catch (error) {
  failure = error;
} finally {
  if (created) {
    try {
      const latestResponse = await request(entryRoute);
      if (latestResponse.status === 404) {
        removed = { deleted: true, alreadyRemoved: true };
      } else {
        assert.equal(latestResponse.status, 200, 'Read latest acceptance revision for cleanup');
        current = json(latestResponse, 'Cleanup editor payload').payload;
        assert.equal(current.entryId, entryId, 'Cleanup identity must match the unique acceptance article');
        const beforeDelete = await publisherState();
        removed = (await api('/api/admin/content/delete/', {
          collection: 'essay', entryId, revision: current.revision, expectedRelativePath: current.relativePath,
        })).result;
        assert.equal(removed.deleted, true);
        await waitPublication(beforeDelete.releaseId, 'temporary article deletion', false);
      }
      const deletedEditor = await request(entryRoute);
      assert.equal(deletedEditor.status, 404, 'Deleted source must not remain editable');
      const deletedReader = await request(readerRoute);
      assert.equal(deletedReader.status, 404, 'Deleted source must not remain readable through a cached entry');
      await publicSurfaces(false);
      console.log('CLEANUP PASS: temporary source deleted; owner reader/editor and public routes HTTP 404; user articles/settings unchanged');
    } catch (error) {
      cleanupFailure = error;
    }
  }
  writeReport();
  for (const agent of agents.values()) agent.destroy();
  console.log(`Cleanup record: ${reportPath.pathname}`);
  if (uploaded?.path) console.log(`Temporary image requiring source cleanup: ${uploaded.path}`);
}

if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], 'Visibility verification and cleanup failed; inspect visibility-cleanup.json');
if (failure) throw failure;
if (cleanupFailure) throw cleanupFailure;
console.log(`VISIBILITY PASS: ${privateOnly ? 'private owner reading' : 'private/public/private roundtrip'}; authentication; protected attachment; public 404; list/search/RSS/sitemap exclusion; temporary article cleanup`);
