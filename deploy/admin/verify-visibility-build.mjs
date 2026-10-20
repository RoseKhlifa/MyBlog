import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../../', import.meta.url));
const id = `visibility-build-${randomBytes(8).toString('hex')}`;
const entry = path.join(root, `src/content/essay/${id}.md`);
const attachments = path.join(root, `src/content/essay/${id}-assets`);
const imageName = `${id}-attachment.png`;
const marker = `CONFIDENTIAL_BODY_${randomBytes(12).toString('hex')}`;
const title = `PRIVATE_TITLE_${randomBytes(8).toString('hex')}`;
const logs = path.join(root, 'deploy/artifacts/visibility');
mkdirSync(logs, { recursive: true });
const image = await sharp(randomBytes(32 * 24 * 3), { raw: { width: 32, height: 24, channels: 3 } }).png().toBuffer();
const imageHash = createHash('sha256').update(image).digest('hex');

function writeEntry(visibility) {
  writeFileSync(entry, `---\ntitle: ${title}\ndate: 2026-10-20\nslug: ${id}\ndraft: false\nvisibility: ${visibility}\ntags: [${id}]\n---\n\n${marker}\n\n![Private attachment](./${id}-assets/${imageName})\n`, { flag: 'w' });
}
async function build(label) {
  const chunks = [];
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/astro/bin/astro.mjs', 'build'], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production', SITE_URL: 'https://blog.rosekhlifa.com', ASTRO_WHONO_BASE_PATH: '/' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timeout = setTimeout(() => child.kill(), 180000);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timeout); resolve(code); });
  });
  writeFileSync(path.join(logs, `${label}.log`), Buffer.concat(chunks));
  assert.equal(status, 0, `${label} build failed; inspect its log`);
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
function assertPrivate(label) {
  assert(!existsSync(path.join(root, `dist/archive/${id}/index.html`)));
  assert(!existsSync(path.join(root, `dist/essay/${id}/index.html`)));
  for (const file of files(path.join(root, 'dist'))) {
    assert(!path.basename(file).includes(id), `Private attachment emitted: ${file}`);
    const bytes = readFileSync(file);
    assert(!bytes.includes(Buffer.from(marker)), `Private body leaked: ${file}`);
    assert(!bytes.includes(Buffer.from(title)), `Private title leaked: ${file}`);
    assert(!bytes.includes(Buffer.from(id)), `Private slug, tag or asset reference leaked: ${file}`);
    assert.notEqual(createHash('sha256').update(bytes).digest('hex'), imageHash, `Private image copied: ${file}`);
  }
  console.log(`${label} PASS: private title/body/slug/tag/attachment absent from every public artifact`);
}

assert(!existsSync(entry) && !existsSync(attachments));
mkdirSync(attachments);
writeFileSync(path.join(attachments, imageName), image);
try {
  writeEntry('private');
  await build('private-initial');
  assertPrivate('INITIAL PRIVATE');
  writeEntry('public');
  await build('public-transition');
  assert(readFileSync(path.join(root, `dist/archive/${id}/index.html`), 'utf8').includes(marker));
  assert(files(path.join(root, 'dist/_astro')).some((file) => path.basename(file).includes(id)));
  console.log('PUBLIC TRANSITION PASS: public article and its image are emitted');
  writeEntry('private');
  await build('private-after-public');
  assertPrivate('PUBLIC TO PRIVATE');
} finally {
  rmSync(entry, { force: true });
  rmSync(attachments, { recursive: true, force: true });
}
console.log('BUILD PRIVACY PASS: private/public/private lifecycle; original source fixtures removed');
