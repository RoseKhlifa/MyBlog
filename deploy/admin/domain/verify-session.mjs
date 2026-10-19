import assert from 'node:assert/strict';
import https from 'node:https';
import { readFileSync } from 'node:fs';

const origin = 'https://blog.rosekhlifa.com';
const agent = new https.Agent({ keepAlive: true, proxyEnv: process.env });
const login = readFileSync(new URL('../../artifacts/online-admin-login.txt', import.meta.url), 'utf8');
const username = login.match(/^Username: (.+)$/m)[1].trim();
const password = login.match(/^Password: (.+)$/m)[1].trim();
async function request(path, { cookie, method = 'GET', form, json, accept = '*/*', requestOrigin = origin } = {}) {
  const bytes = form ? Buffer.from(new URLSearchParams(form).toString()) : json ? Buffer.from(JSON.stringify(json)) : undefined;
  return await new Promise((resolve, reject) => {
    const req = https.request(origin + path, { agent, method, headers: {
      Accept: accept,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'POST' ? { Origin: requestOrigin, 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', 'Content-Length': bytes?.length || 0 } : {}),
    } }, (res) => {
      const data = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(data).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error(`Timeout: ${path}`)));
    req.on('error', reject);
    req.end(bytes);
  });
}
try {
  const publicHome = await request('/');
  assert.equal(publicHome.status, 200);
  console.log('PUBLIC PASS: homepage HTTP 200 without login');
  const before = await request('/admin/', { accept: 'text/html' });
  assert.equal(before.status, 303);
  assert.match(before.headers.location, /^\/admin\/login\//);
  assert(!before.headers['www-authenticate']);
  console.log('BASELINE PASS: /admin/ -> HTTP 303 /admin/login/; no browser authentication popup');
  const page = await request('/admin/login/');
  assert.equal(page.status, 200);
  assert(page.text.includes('name="password"') && page.text.includes('登录'));
  console.log('LOGIN PAGE PASS: HTTP 200; Chinese username/password form; trusted domain TLS');
  const posted = await request('/admin/login/', { method: 'POST', form: { username, password, next: '/admin/content/' } });
  assert.equal(posted.status, 303);
  assert.equal(posted.headers.location, '/admin/content/');
  const setCookie = posted.headers['set-cookie'][0];
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  console.log('MODIFIED PASS: form login HTTP 303 /admin/content/; secure HttpOnly session cookie issued');
  for (const path of ['/admin/content/', '/admin/content/essay/_edit/markdown-guide/', '/@vite/client', '/_publish/status', '/api/admin/content/entry/?collection=essay&entryId=markdown-guide']) {
    const response = await request(path, { cookie });
    assert.equal(response.status, 200, `${path}: ${response.status}`);
    console.log(`SESSION PASS: HTTP 200 ${path}`);
  }
  const foreign = await request('/admin/login/', { method: 'POST', requestOrigin: 'https://unrelated.example', form: { username: 'wrong', password: 'wrong' } });
  assert.equal(foreign.status, 403);
  console.log('CSRF PASS: foreign login Origin HTTP 403');
  const entry = JSON.parse((await request('/api/admin/content/entry/?collection=essay&entryId=markdown-guide', { cookie })).text).payload;
  const checked = await request('/api/admin/content/entry/?dryRun=1', { cookie, method: 'POST', json: {
    collection: 'essay', entryId: 'markdown-guide', revision: entry.revision, frontmatter: entry.values, body: entry.bodyText,
  } });
  assert.equal(checked.status, 200);
  assert.equal(JSON.parse(checked.text).dryRun, true);
  console.log('COOKIE WRITE PASS: authenticated same-origin article validation HTTP 200 (dry run, original article preserved)');
  const logout = await request('/admin/logout/', { cookie, method: 'POST', form: {} });
  assert.equal(logout.status, 303);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  console.log('LOGOUT PASS: HTTP 303 /admin/login/; browser session cookie cleared');
  console.log('DOMAIN SESSION PASS: public homepage, HTML login form, session-protected editor/modules/API, logout');
} finally {
  agent.destroy();
}
