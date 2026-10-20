import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  getAdminFaviconPreviewSrc,
  parseAdminFaviconUploadResult
} from '../src/lib/admin-console/favicon-preview';
import { uploadAdminSiteFavicon } from '../src/lib/admin-console/site-assets';
import { ALL, GET, getStaticPaths } from '../src/pages/api/admin/site-assets/favicon-preview/[file]';

describe('live favicon previews', () => {
  let tempRoot = '';
  let png: Buffer;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'whono-favicon-preview-'));
    vi.stubEnv('ASTRO_WHONO_INTERNAL_TEST_PROJECT_ROOT', tempRoot);
    png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 29, g: 80, b: 146, alpha: 1 } }
    }).png().toBuffer();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it.each(['png', 'appleTouchIcon'] as const)('reads an uploaded %s immediately before a static publication exists', async (slot) => {
    const uploaded = await uploadAdminSiteFavicon({
      slot,
      file: new File([new Uint8Array(png)], 'logo.png', { type: 'image/png' })
    });
    const preview = await GET({ params: { file: uploaded.fileName } } as never);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/png');
    expect(preview.headers.get('cache-control')).toBe('private, no-store');
    expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
    expect(preview.headers.get('content-length')).toBe(String(png.length));
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(png);
    expect(existsSync(path.join(tempRoot, 'dist'))).toBe(false);
    expect(getAdminFaviconPreviewSrc(uploaded.path)).toBe(`/api/admin/site-assets/favicon-preview/${uploaded.fileName}/`);
    expect(uploaded.path).toBe(`/images/site/${uploaded.fileName}`);
  });

  it('maps only generated upload paths, includes a trailing slash and applies the site base once', () => {
    const file = 'favicon-64x63-a1b2c3d4.png';
    expect(getAdminFaviconPreviewSrc(`/images/site/${file}`, '/blog/')).toBe(`/blog/api/admin/site-assets/favicon-preview/${file}/`);
    expect(getAdminFaviconPreviewSrc(`/images/site/${file}`, '/blog')).toBe(`/blog/api/admin/site-assets/favicon-preview/${file}/`);
    for (const value of [
      '/favicon-32x32.png',
      '/apple-touch-icon.png',
      '/images/site/favicon-brand.png',
      '/images/site/favicon-64x64-aaaaaaaa.svg',
      '/images/site/favicon-64x64-aaaaaaaa.png?cache=1',
      '/images/site/favicon-64x64-aaaaaaaa.png\n',
      '/images/site/../favicon-64x64-aaaaaaaa.png',
      '/images/site/%2e%2e/favicon-64x64-aaaaaaaa.png',
      '//images/site/favicon-64x64-aaaaaaaa.png'
    ]) {
      expect(getAdminFaviconPreviewSrc(value, '/blog/'), value).toBe(value);
    }
  });

  it('does not expose unrelated files or traversal paths through the live preview route', async () => {
    await mkdir(path.join(tempRoot, 'public', 'images', 'site'), { recursive: true });
    await writeFile(path.join(tempRoot, 'public', 'images', 'site', 'manual.png'), png);
    await writeFile(path.join(tempRoot, 'secret.png'), png);
    for (const file of [
      undefined,
      'manual.png',
      '../../../secret.png',
      '..%2f..%2f..%2fsecret.png',
      'favicon-64x64-aaaaaaaa.svg',
      'favicon-64x64-aaaaaaaa.png/',
      'favicon-64x64-aaaaaaaa.png?cache=1',
      'favicon-64x64-aaaaaaaa.png\n',
      'favicon-64x64-aaaaaaaa.png',
      'apple-touch-icon-180x180-aaaaaaaa.png'
    ]) {
      const response = await GET({ params: { file } } as never);
      expect(response.status, String(file)).toBe(404);
      expect(await response.text()).toBe('Not Found');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  it('supports GET only and does not produce any static preview pages', async () => {
    const response = await ALL({} as never);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(getStaticPaths()).toEqual([]);
  });

  it('hides preview handlers in production even when an uploaded icon exists', async () => {
    const uploaded = await uploadAdminSiteFavicon({
      slot: 'png',
      file: new File([new Uint8Array(png)], 'logo.png', { type: 'image/png' })
    });
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITEST', '');
    expect((await GET({ params: { file: uploaded.fileName } } as never)).status).toBe(404);
    expect((await ALL({} as never)).status).toBe(404);
  });

  it('accepts the upload API result without changing its public setting path', async () => {
    const uploaded = await uploadAdminSiteFavicon({
      slot: 'png',
      file: new File([new Uint8Array(png)], 'logo.png', { type: 'image/png' })
    });
    const result = parseAdminFaviconUploadResult({ ok: true, result: uploaded }, 'png');
    expect(result).toEqual({ path: uploaded.path, width: 64, height: 64 });
    expect(result?.path).not.toContain('/api/admin/');
    expect(parseAdminFaviconUploadResult({ ok: true, result: uploaded }, 'appleTouchIcon')).toBeNull();
  });

  it('rejects malformed responses before the editor overwrites the current icon', () => {
    const valid = { path: '/images/site/favicon-64x64-aaaaaaaa.png', width: 64, height: 64 };
    for (const payload of [
      null,
      { ok: false, result: valid },
      { ok: true, result: null },
      { ok: true, result: { ...valid, path: 'https://another.example/logo.png' } },
      { ok: true, result: { ...valid, path: '/images/site/../favicon-64x64-aaaaaaaa.png' } },
      { ok: true, result: { ...valid, path: '/images/site/apple-touch-icon-64x64-aaaaaaaa.png' } },
      { ok: true, result: { ...valid, width: '64' } },
      { ok: true, result: { ...valid, height: 63 } },
      { ok: true, result: { ...valid, path: '/images/site/favicon-8x8-aaaaaaaa.png', width: 8, height: 8 } },
      { ok: true, result: { ...valid, path: '/images/site/favicon-1024x1024-aaaaaaaa.png', width: 1024, height: 1024 } }
    ]) {
      expect(parseAdminFaviconUploadResult(payload, 'png')).toBeNull();
    }
  });
});
