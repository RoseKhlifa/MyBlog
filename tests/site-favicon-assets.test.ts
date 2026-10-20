import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGeneratedSiteFaviconLinks, prepareSiteFaviconAssets } from '../src/lib/site-favicon-assets.mjs';
import { getSiteFaviconLinks } from '../src/lib/theme-settings';

describe('site favicon browser delivery', () => {
  let root = '';
  let original: Buffer;
  const originalPath = '/images/site/favicon-180x180-legacyhash.png';
  const local = (href: string): string => path.join(root, 'public', `.${href}`);
  const configure = async (png: string | null = originalPath) => {
    await writeFile(path.join(root, 'src/data/settings/site.json'), `${JSON.stringify({ favicon: { png, svg: null, appleTouchIcon: null } })}\n`);
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'whono-browser-favicon-'));
    vi.stubEnv('ASTRO_WHONO_INTERNAL_TEST_PROJECT_ROOT', root);
    await Promise.all([
      mkdir(path.join(root, 'src/data/settings'), { recursive: true }),
      mkdir(path.join(root, 'public/images/site'), { recursive: true })
    ]);
    original = await sharp({ create: { width: 180, height: 180, channels: 4, background: { r: 27, g: 88, b: 166, alpha: 1 } } }).png().toBuffer();
    await writeFile(local(originalPath), original);
    await writeFile(local('/favicon-32x32.png'), await sharp(original).resize(32, 32).png().toBuffer());
    await configure();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('generates real 16/32/48 PNGs and a current-image multi-size ICO from a legacy 180px upload', async () => {
    const settingsBefore = await readFile(path.join(root, 'src/data/settings/site.json'));
    const result = await prepareSiteFaviconAssets(root);
    const links = getSiteFaviconLinks({ svg: null, png: originalPath, appleTouchIcon: null });
    expect(result.custom).toBe(true);
    expect(result.hash).toMatch(/^[0-9a-f]{20}$/);
    expect(links.filter((link) => link.type === 'image/png').map((link) => link.sizes)).toEqual(['16x16', '32x32', '48x48']);
    for (const size of [16, 32, 48]) {
      const link = links.find((link) => link.sizes === `${size}x${size}`)!;
      const image = sharp(await readFile(local(link.href)));
      expect(await image.metadata()).toMatchObject({ format: 'png', width: size, height: size });
      const pixel = await image.raw().toBuffer();
      expect([...pixel.subarray(0, 4)]).toEqual([27, 88, 166, 255]);
    }
    const icoLink = links.find((link) => link.type === 'image/x-icon')!;
    expect(icoLink.sizes).toBe('16x16 32x32 48x48');
    expect(icoLink.href).toMatch(new RegExp(`/favicon-${result.hash}\\.ico$`));
    const ico = await readFile(local('/favicon.ico'));
    expect(ico.equals(await readFile(local(icoLink.href)))).toBe(true);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    for (const [index, size] of [16, 32, 48].entries()) {
      const entry = 6 + index * 16;
      expect(ico[entry]).toBe(size);
      expect(ico[entry + 1]).toBe(size);
      expect(ico.readUInt16LE(entry + 6)).toBe(32);
      const offset = ico.readUInt32LE(entry + 12);
      expect(ico.readUInt32LE(offset)).toBe(40);
      expect(ico.readInt32LE(offset + 4)).toBe(size);
      expect(ico.readInt32LE(offset + 8)).toBe(size * 2);
      expect([...ico.subarray(offset + 40, offset + 44)]).toEqual([166, 88, 27, 255]);
      expect(offset + ico.readUInt32LE(entry + 8)).toBeLessThanOrEqual(ico.length);
    }
    expect((await readFile(path.join(root, 'src/data/settings/site.json'))).equals(settingsBefore)).toBe(true);
    expect((await readFile(local(originalPath))).equals(original)).toBe(true);
    expect(links.some((link) => link.href === 'favicon.svg')).toBe(false);
  });

  it('changes every variant URL when configured icon bytes change and replaces the root fallback', async () => {
    const first = await prepareSiteFaviconAssets(root);
    const firstRoot = await readFile(local('/favicon.ico'));
    const next = await sharp({ create: { width: 180, height: 180, channels: 4, background: '#cc2255' } }).png().toBuffer();
    await writeFile(local(originalPath), next);
    expect(getGeneratedSiteFaviconLinks({ png: originalPath }, root)).toBeNull();
    const second = await prepareSiteFaviconAssets(root);
    expect(second.hash).not.toBe(first.hash);
    expect(firstRoot.equals(await readFile(local('/favicon.ico')))).toBe(false);
    const links = getGeneratedSiteFaviconLinks({ png: originalPath }, root)!;
    expect(links.every((link) => link.href.includes(second.hash))).toBe(true);
    expect(first.files.filter((href) => href !== '/favicon.ico').every((href) => existsSync(local(href)))).toBe(true);
  });

  it('does not rewrite already-current files or change existing default icons', async () => {
    await prepareSiteFaviconAssets(root);
    const before = await stat(local('/favicon.ico'));
    await prepareSiteFaviconAssets(root);
    expect((await stat(local('/favicon.ico'))).mtimeMs).toBe(before.mtimeMs);
    await configure(null);
    const defaultBefore = await readFile(local('/favicon-32x32.png'));
    const result = await prepareSiteFaviconAssets(root);
    expect(result.custom).toBe(false);
    expect(result.files).toEqual(['/favicon.ico']);
    expect(getGeneratedSiteFaviconLinks({ png: null, svg: null }, root)).toBeNull();
    expect((await readFile(local('/favicon-32x32.png'))).equals(defaultBefore)).toBe(true);
  });

  it('rejects corrupt configured PNGs before replacing any previously valid fallback', async () => {
    await prepareSiteFaviconAssets(root);
    const previous = await readFile(local('/favicon.ico'));
    await writeFile(local(originalPath), 'not a decoded PNG');
    await expect(prepareSiteFaviconAssets(root)).rejects.toThrow();
    expect((await readFile(local('/favicon.ico'))).equals(previous)).toBe(true);
  });

  it('normalizes grayscale to RGBA and encodes transparent pixels in both alpha and ICO masks', async () => {
    const gray = await sharp({ create: { width: 180, height: 180, channels: 3, background: '#888888' } }).toColourspace('b-w').png().toBuffer();
    await writeFile(local(originalPath), gray);
    await prepareSiteFaviconAssets(root);
    let ico = await readFile(local('/favicon.ico'));
    let offset = ico.readUInt32LE(18);
    expect([...ico.subarray(offset + 40, offset + 44)]).toEqual([136, 136, 136, 255]);
    const transparent = await sharp({ create: { width: 180, height: 180, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    await writeFile(local(originalPath), transparent);
    await prepareSiteFaviconAssets(root);
    ico = await readFile(local('/favicon.ico'));
    offset = ico.readUInt32LE(18);
    expect(ico[offset + 43]).toBe(0);
    expect(ico[offset + 40 + 16 * 16 * 4]).toBe(255);
  });

  it('keeps original PNG links until the complete corresponding derived set is ready', async () => {
    expect(getSiteFaviconLinks({ png: originalPath, svg: null, appleTouchIcon: null })[0]?.href).toBe(originalPath);
    const result = await prepareSiteFaviconAssets(root);
    const generated = getGeneratedSiteFaviconLinks({ png: originalPath }, root)!;
    await rm(local(generated[0]!.href));
    expect(getGeneratedSiteFaviconLinks({ png: originalPath }, root)).toBeNull();
    expect(getSiteFaviconLinks({ png: originalPath, svg: null, appleTouchIcon: null })[0]?.href).toBe(originalPath);
    expect(result.files.every((href) => href.startsWith('/'))).toBe(true);
  });
});
