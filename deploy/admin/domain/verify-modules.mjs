import https from 'node:https';
import { readFileSync } from 'node:fs';
import { init, parse } from 'es-module-lexer';

await init;

// Read credentials locally; never print the Authorization header or password.
const originArg = process.argv.indexOf('--origin');
const origin = new URL(originArg >= 0 ? process.argv[originArg + 1] : process.env.ADMIN_ORIGIN || 'https://blog.rosekhlifa.com').origin;
if (!origin.startsWith('https://')) throw new Error('The module verification origin must use HTTPS.');
const credentials = readFileSync(new URL('../../artifacts/online-admin-login.txt', import.meta.url), 'utf8');
const username = credentials.match(/^Username:\s*(.+)$/m)?.[1]?.trim();
const password = credentials.match(/^Password:\s*(.+)$/m)?.[1]?.trim();
if (!username || !password) throw new Error('Local online-admin-login.txt is missing Username or Password.');
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const agent = new https.Agent({ keepAlive: true, maxSockets: 6, proxyEnv: process.env });
const limit = 1200;
const queue = [];
const seen = new Set();
const failures = [];
const counts = new Map();
const pages = [];
let completed = 0;

const protectedPath = (pathname) => /^\/(?:admin(?:\/|$)|api\/admin(?:\/|$)|_publish(?:\/|$)|src(?:\/|$)|node_modules(?:\/|$)|@[^/]+(?:\/|$))/.test(pathname)
  || /^\/(?:site|astro)\.config\.[cm]?[jt]s$/.test(pathname);
const decodeHtml = (value) => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const normalize = (specifier, base, allowBare = false) => {
  if (!specifier || /^(?:data:|blob:|javascript:|#)/i.test(specifier)) return null;
  // Vite's client contains source templates as strings. Only resolved literals
  // describe requests: placeholders and string-concatenation fragments do not.
  if (/\$\{|%24(?:%7b|\{)|['"`]\s*\+/i.test(specifier)) return null;
  // Bare ESM package imports are not browser URLs. Vite rewrites them before delivery.
  if (!allowBare && !/^(?:\.{1,2}\/|\/|https?:\/\/)/i.test(specifier)) return null;
  const url = new URL(decodeHtml(specifier), base);
  if (url.origin !== origin || url.username || url.password) return null;
  url.hash = '';
  if (/^\d+$/.test(url.searchParams.get('t') || '')) url.searchParams.delete('t');
  return url;
};
const enqueue = (specifier, base, kind = 'js', parent = '') => {
  const url = normalize(specifier, base, kind !== 'js');
  if (!url) return;
  const key = `${kind}:${url.href}`;
  if (seen.has(key)) return;
  if (seen.size >= limit) throw new Error(`Module/resource limit ${limit} reached at ${url.href}`);
  seen.add(key);
  queue.push({ url, kind, parent });
};
const requestOnce = (url, kind, redirects = 0) => new Promise((resolve, reject) => {
  const headers = {
    Accept: kind === 'css' ? 'text/css,*/*;q=0.1' : kind === 'html' ? 'text/html' : '*/*',
    'User-Agent': 'RoseKhlifa-admin-module-verification/1.0',
  };
  if (protectedPath(url.pathname)) headers.Authorization = authorization;
  const req = https.get(url, { agent, headers }, (res) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) req.destroy(new Error(`Response exceeded 16 MiB: ${url.href}`));
      else chunks.push(chunk);
    });
    res.on('error', reject);
    res.on('end', async () => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const target = normalize(res.headers.location, url, true);
        if (!target || redirects >= 3) return reject(new Error(`Unexpected redirect ${res.statusCode}: ${url.href}`));
        try { resolve(await request(target, kind, redirects + 1)); } catch (error) { reject(error); }
        return;
      }
      resolve({ status: res.statusCode, mime: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), body: Buffer.concat(chunks).toString('utf8') });
    });
  });
  req.setTimeout(30000, () => req.destroy(new Error(`Request timed out: ${url.href}`)));
  req.on('error', reject);
});
const request = async (url, kind, redirects = 0) => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await requestOnce(url, kind, redirects);
    if (![502, 503, 504].includes(response.status) || attempt >= 2) return response;
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
};
const validate = (job, response) => {
  if (response.status !== 200) throw new Error(`HTTP ${response.status} ${job.url.href}`);
  const { mime } = response;
  if (job.kind === 'js' && !/^(?:text|application)\/(?:javascript|ecmascript)$/.test(mime)) {
    throw new Error(`Expected JavaScript, received ${mime || '(missing MIME)'}: ${job.url.href}`);
  }
  if (job.kind === 'css' && mime !== 'text/css') throw new Error(`Expected CSS, received ${mime || '(missing MIME)'}: ${job.url.href}`);
  if (job.kind === 'html' && mime !== 'text/html') throw new Error(`Expected HTML, received ${mime || '(missing MIME)'}: ${job.url.href}`);
  if (job.kind === 'json') {
    if (!/(?:application|text)\/(?:[\w.+-]*\+)?json$/.test(mime)) throw new Error(`Expected JSON, received ${mime || '(missing MIME)'}: ${job.url.href}`);
    JSON.parse(response.body);
  }
  if (job.kind === 'resource' && mime === 'text/html') throw new Error(`Asset returned HTML: ${job.url.href}`);
};
const scanJs = (body, url) => {
  const [imports] = parse(body, url.href);
  // The lexer ignores comments, strings containing example imports, import.meta,
  // and computed dynamic imports. `n` contains only a resolved literal specifier.
  for (const imported of imports) {
    if (typeof imported.n === 'string') enqueue(imported.n, url, 'js', url.href);
  }
};
const scanCss = (body, url) => {
  for (const match of body.matchAll(/@import\s+(?:url\(\s*)?(['"])([^'"]+)\1/g)) enqueue(match[2], url, 'css', url.href);
  for (const match of body.matchAll(/url\(\s*(?:['"])?([^'"\s)]+)(?:['"])?\s*\)/g)) enqueue(match[1], url, 'resource', url.href);
};
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2];
const scanHtml = (body, url) => {
  for (const match of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = attribute(match[1], 'src');
    if (src) enqueue(src, url, 'js', url.href);
    else scanJs(match[2], url);
  }
  for (const match of body.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(match[0], 'rel');
    const href = attribute(match[0], 'href');
    if (rel?.split(/\s+/).includes('stylesheet')) enqueue(href, url, 'css', url.href);
    if (rel?.split(/\s+/).includes('modulepreload')) enqueue(href, url, 'js', url.href);
  }
  for (const match of body.matchAll(/\b(?:component-url|renderer-url)\s*=\s*(['"])(.*?)\1/gi)) enqueue(match[2], url, 'js', url.href);
};

try {
  const seeds = [
    ['/admin/theme/', 'html'],
    ['/admin/content/', 'html'],
    ['/admin/content/essay/_edit/markdown-guide/', 'html'],
    ['/api/admin/content/entry/?collection=essay&entryId=markdown-guide', 'json'],
    ['/@vite/client', 'js'],
    ['/site.config.mjs', 'js'],
    ['/_publish/status.js', 'js'],
    ['/_publish/status', 'json'],
  ];
  for (const [path, kind] of seeds) {
    const url = new URL(path, origin);
    const response = await request(url, kind);
    validate({ url, kind }, response);
    console.log(`SEED PASS: 200 ${path}`);
    if (kind === 'html') { pages.push(path); scanHtml(response.body, url); }
    if (kind === 'js') scanJs(response.body, url);
  }
  // Each batch waits for at most six requests; discovered imports enter the next batch.
  while (queue.length) {
    const batch = queue.splice(0, 6);
    await Promise.all(batch.map(async (job) => {
      try {
        const response = await request(job.url, job.kind);
        validate(job, response);
        const root = '/' + job.url.pathname.split('/').filter(Boolean)[0];
        counts.set(root, (counts.get(root) || 0) + 1);
        completed += 1;
        if (job.kind === 'js') scanJs(response.body, job.url);
        if (job.kind === 'css') scanCss(response.body, job.url);
      } catch (error) {
        failures.push(`${error.message}${job.parent ? ` (imported by ${job.parent})` : ''}`);
      }
    }));
  }
  console.log(`MODULE ROOTS: ${JSON.stringify(Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))))}`);
  if (failures.length) {
    for (const failure of failures.slice(0, 40)) console.error(`MODULE FAIL: ${failure}`);
    if (failures.length > 40) console.error(`MODULE FAIL: ${failures.length - 40} additional failures omitted.`);
    process.exitCode = 1;
  } else {
    console.log(`MODULE PASS: ${pages.length} authenticated admin pages; ${completed} same-origin JavaScript/CSS/assets; all HTTP 200 with expected MIME; system TLS validation enabled`);
  }
} catch (error) {
  console.error(`MODULE FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  agent.destroy();
}
