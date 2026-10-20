import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ICON_SIZES = [16, 32, 48];
const GENERATED_DIR = '/images/site/generated';
const GENERATOR_VERSION = 'favicon-bgra-v1';

/** @typedef {{png?: string|null, svg?: string|null}} FaviconSettings */
/** @typedef {{rel: 'icon', type: string, sizes: string, href: string}} FaviconLink */

/** Resolve only public local paths, including legacy settings written before uploads existed. */
const localFile = (projectRoot, value) => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\?#\0]/.test(value)) return null;
  if (value.split('/').some((part) => part === '.' || part === '..')) return null;
  const publicRoot = path.join(projectRoot, 'public');
  const result = path.resolve(publicRoot, `.${value}`);
  return result.startsWith(`${publicRoot}${path.sep}`) && existsSync(result) ? result : null;
};

/** @param {string} projectRoot @param {FaviconSettings} favicon */
const selectSource = (projectRoot, favicon) => {
  const png = localFile(projectRoot, favicon.png);
  const svg = localFile(projectRoot, favicon.svg);
  const file = png || svg || localFile(projectRoot, '/favicon-32x32.png');
  if (!file) throw new Error('No readable site favicon source was found in public/.');
  const bytes = readFileSync(file);
  const hash = createHash('sha256').update(GENERATOR_VERSION).update(bytes).digest('hex').slice(0, 20);
  return { bytes, hash, custom: Boolean(png || svg) };
};

const variantPaths = (hash) => ({
  png: ICON_SIZES.map((size) => ({ size, href: `${GENERATED_DIR}/favicon-${hash}-${size}x${size}.png` })),
  ico: `${GENERATED_DIR}/favicon-${hash}.ico`
});

/** Synchronous head rendering uses derived files only when the complete current set exists.
 * @param {FaviconSettings} favicon
 * @param {string} [projectRoot]
 * @returns {FaviconLink[] | null}
 */
export const getGeneratedSiteFaviconLinks = (favicon, projectRoot = process.env.ASTRO_WHONO_INTERNAL_TEST_PROJECT_ROOT?.trim() || process.cwd()) => {
  let source;
  try { source = selectSource(projectRoot, favicon); } catch { return null; }
  if (!source.custom) return null;
  const variants = variantPaths(source.hash);
  if (![variants.ico, ...variants.png.map((item) => item.href)].every((href) => localFile(projectRoot, href))) return null;
  return [
    ...variants.png.map(({ size, href }) => (/** @type {FaviconLink} */ ({ rel: 'icon', type: 'image/png', sizes: `${size}x${size}`, href }))),
    { rel: 'icon', type: 'image/x-icon', sizes: ICON_SIZES.map((size) => `${size}x${size}`).join(' '), href: variants.ico }
  ];
};

// Classic 32-bit DIB frames also work in consumers that do not support PNG-in-ICO.
const encodeIco = (frames) => {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  const bitmaps = frames.map(({ size, rgba }, index) => {
    const maskStride = Math.ceil(size / 32) * 4;
    const xorLength = size * size * 4;
    const bitmap = Buffer.alloc(40 + xorLength + maskStride * size);
    bitmap.writeUInt32LE(40, 0);
    bitmap.writeInt32LE(size, 4);
    bitmap.writeInt32LE(size * 2, 8);
    bitmap.writeUInt16LE(1, 12);
    bitmap.writeUInt16LE(32, 14);
    bitmap.writeUInt32LE(xorLength, 20);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const from = (y * size + x) * 4;
        const to = 40 + ((size - y - 1) * size + x) * 4;
        bitmap[to] = rgba[from + 2];
        bitmap[to + 1] = rgba[from + 1];
        bitmap[to + 2] = rgba[from];
        bitmap[to + 3] = rgba[from + 3];
        if (rgba[from + 3] === 0) bitmap[40 + xorLength + (size - y - 1) * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    const entry = 6 + index * 16;
    header[entry] = size;
    header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bitmap.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bitmap.length;
    return bitmap;
  });
  return Buffer.concat([header, ...bitmaps]);
};

// Avoid rewriting identical files: generated files must not cause an endless publish loop.
const writeChangedFile = async (file, bytes) => {
  try { if ((await readFile(file)).equals(bytes)) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
};

/** Generate real small PNGs and a fallback ICO from current settings without rewriting them.
 * Explicit decode/write errors fail the build so an old or unrelated icon cannot be published.
 * @param {string} [projectRoot]
 * @returns {Promise<{hash: string, custom: boolean, files: string[]}>}
 */
export const prepareSiteFaviconAssets = async (projectRoot = process.cwd()) => {
  let favicon = {};
  try {
    favicon = JSON.parse(await readFile(path.join(projectRoot, 'src/data/settings/site.json'), 'utf8')).favicon || {};
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = selectSource(projectRoot, favicon);
  const frames = await Promise.all(ICON_SIZES.map(async (size) => {
    const image = sharp(source.bytes, { limitInputPixels: 4096 * 4096 }).rotate().resize(size, size, {
      fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }
    }).toColourspace('srgb').ensureAlpha();
    const [png, rgba] = await Promise.all([image.clone().png().toBuffer(), image.clone().raw().toBuffer()]);
    return { size, png, rgba };
  }));
  const ico = encodeIco(frames);
  const files = ['/favicon.ico'];
  if (source.custom) {
    const variants = variantPaths(source.hash);
    for (let index = 0; index < frames.length; index++) {
      const href = variants.png[index].href;
      await writeChangedFile(path.join(projectRoot, 'public', `.${href}`), frames[index].png);
      files.push(href);
    }
    await writeChangedFile(path.join(projectRoot, 'public', `.${variants.ico}`), ico);
    files.push(variants.ico);
  }
  await writeChangedFile(path.join(projectRoot, 'public/favicon.ico'), ico);
  return { hash: source.hash, custom: source.custom, files };
};

/** @returns {import('astro').AstroIntegration} */
export const siteFaviconAssetsIntegration = () => {
  let projectRoot = process.cwd();
  return {
    name: 'site-favicon-assets',
    hooks: {
      'astro:config:done': ({ config }) => { projectRoot = fileURLToPath(config.root); },
      // Astro 7 runs this before viteBuild, which copies public/ and renders page heads.
      'astro:build:start': async () => { await prepareSiteFaviconAssets(projectRoot); },
      'astro:server:setup': async ({ server, logger }) => {
        await prepareSiteFaviconAssets(projectRoot);
        let pending = Promise.resolve();
        const refresh = (file) => {
          const relative = path.relative(projectRoot, file).replaceAll('\\', '/');
          if (relative !== 'src/data/settings/site.json' && !/^public\/(?:images\/site\/[^/]+\.(?:png|svg)|favicon(?:-32x32)?\.(?:png|svg))$/.test(relative)) return;
          pending = pending.then(async () => {
            await prepareSiteFaviconAssets(projectRoot);
          }).catch((error) => logger.error(`Favicon generation failed: ${error.message}`));
        };
        server.watcher.on('add', refresh);
        server.watcher.on('change', refresh);
        server.watcher.on('unlink', refresh);
        server.httpServer?.once('close', () => {
          server.watcher.off('add', refresh);
          server.watcher.off('change', refresh);
          server.watcher.off('unlink', refresh);
        });
      }
    }
  };
};
