import assert from 'node:assert/strict';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const login = readFileSync(new URL('../artifacts/online-admin-login.txt', import.meta.url), 'utf8');
const username = login.match(/^Username: (.+)$/m)[1].trim();
const password = login.match(/^Password: (.+)$/m)[1].trim();
const authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
const origin = process.env.ADMIN_ORIGIN || 'https://blog.rosekhlifa.com';
const agent = new https.Agent(new URL(origin).hostname === '51.83.101.143' ? { ca: readFileSync(new URL('../artifacts/online-admin-server.crt', import.meta.url)) } : { proxyEnv: process.env });
try {
  const client = await new Promise((resolve, reject) => {
    https.get(origin + '/@vite/client', { agent, headers: { Authorization: authorization } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { assert.equal(res.statusCode, 200); resolve(text); });
      res.on('error', reject);
    }).on('error', reject);
  });
  const token = client.match(/const wsToken = "([^"]+)"/)?.[1];
  assert(token, 'Expected the protected Vite WebSocket token');
  await new Promise((resolve, reject) => {
    const req = https.request(`${origin}/admin/_hmr/?token=${encodeURIComponent(token)}`, { agent, headers: {
      Authorization: authorization, Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      'Sec-WebSocket-Protocol': 'vite-hmr',
    } });
    req.setTimeout(15000, () => req.destroy(new Error('WebSocket handshake timed out')));
    req.on('upgrade', (res, socket) => { socket.destroy(); assert.equal(res.statusCode, 101); resolve(); });
    req.on('response', (res) => { res.resume(); reject(new Error(`WebSocket HTTP ${res.statusCode}`)); });
    req.on('error', reject);
    req.end();
  });
  console.log('CONNECTION PASS: authenticated HTTPS module load and WSS WebSocket handshake HTTP 101');
  for (const route of ['/admin/content/', '/_publish/status', '/api/admin/content/entry/?collection=essay&entryId=markdown-guide']) {
    const response = await new Promise((resolve, reject) => {
      https.get(origin + route, { agent, headers: { Authorization: authorization } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
        res.on('error', reject);
      }).on('error', reject);
    });
    assert.equal(response.status, 200);
    if (route === '/_publish/status') assert.equal(JSON.parse(response.text).state, 'published');
    console.log(`RESTART PASS: 200 ${route}`);
  }
} finally {
  agent.destroy();
}
