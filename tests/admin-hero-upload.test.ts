import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { withAdminSettingsWriteLock } from '../src/lib/admin-console/admin-api';
import {
  ADMIN_HERO_UPLOAD_DIRECTORY,
  ADMIN_HERO_UPLOAD_MAX_BYTES,
  type AdminHeroUploadResult
} from '../src/lib/admin-console/hero-upload';
import { invalidateAdminImageCaches } from '../src/lib/admin-console/image-shared';
import { GET, POST } from '../src/pages/api/admin/site-assets/hero';

const ENDPOINT = 'http://127.0.0.1:4321/api/admin/site-assets/hero/';
type UploadPayload = { ok: boolean; errors?: string[]; result?: AdminHeroUploadResult };

const createImage = (format: 'png' | 'jpeg' | 'webp' | 'avif' | 'gif' = 'png', background = '#cc8844') =>
  sharp({ create: { width: 24, height: 12, channels: 3, background } }).toFormat(format).toBuffer();

const upload = async (buffer: Buffer, name = 'hero.png', type = 'image/png', origin = 'http://127.0.0.1:4321') => {
  const body = new FormData();
  body.set('image', new File([new Uint8Array(buffer)], name, { type }));
  const request = new Request(ENDPOINT, { method: 'POST', headers: { origin }, body });
  const response = await POST({ request, url: new URL(ENDPOINT) } as never);
  return { response, payload: await response.json() as UploadPayload };
};

describe('standalone Hero image upload', () => {
  let tempRoot = '';
  let png: Buffer;
  const originalProjectRoot = process.env.ASTRO_WHONO_INTERNAL_TEST_PROJECT_ROOT;
  const uploadDirectory = () => path.join(tempRoot, ...ADMIN_HERO_UPLOAD_DIRECTORY.split('/'));

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'astro-whono-hero-upload-'));
    process.env.ASTRO_WHONO_INTERNAL_TEST_PROJECT_ROOT = tempRoot;
    png = await createImage();
    invalidateAdminImageCaches();
  });

  afterEach(async () => {
    if (originalProjectRoot === undefined) delete process.env.ASTRO_WHONO_INTERNAL_TEST_PROJECT_ROOT;
    else process.env.ASTRO_WHONO_INTERNAL_TEST_PROJECT_ROOT = originalProjectRoot;
    invalidateAdminImageCaches();
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('uploads directly without creating a content entry or changing settings', async () => {
    const settingsDirectory = path.join(tempRoot, 'src', 'data', 'settings');
    await mkdir(settingsDirectory, { recursive: true });
    const settingsPath = path.join(settingsDirectory, 'home.json');
    const settings = '{"heroImage":{"src":"src/assets/original.png"}}\n';
    await writeFile(settingsPath, settings);

    const { response, payload } = await upload(png);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(payload.ok).toBe(true);
    expect(payload.result).toMatchObject({ width: 24, height: 12, size: png.length, mimeType: 'image/png' });
    expect(payload.result?.src).toMatch(/^src\/assets\/hero-uploads\/hero-[0-9a-f]{64}\.png$/);
    expect(payload.result?.path).toBe(payload.result?.src);
    expect(await readFile(path.join(uploadDirectory(), payload.result!.fileName))).toEqual(png);
    expect(await readFile(settingsPath, 'utf8')).toBe(settings);
    expect(existsSync(path.join(tempRoot, 'src', 'content'))).toBe(false);
  });

  it.each([
    ['jpeg', 'hero.jpeg', 'image/jpeg', '.jpg'],
    ['webp', 'hero.webp', 'image/webp', '.webp'],
    ['avif', 'hero.avif', 'image/avif', '.avif'],
    ['gif', 'hero.gif', 'image/gif', '.gif']
  ] as const)('accepts a real %s image with complete metadata', async (format, name, mime, extension) => {
    const buffer = await createImage(format);
    const { response, payload } = await upload(buffer, name, mime);
    expect(response.status).toBe(200);
    expect(payload.result).toMatchObject({ width: 24, height: 12, size: buffer.length, mimeType: mime });
    expect(payload.result?.fileName.endsWith(extension)).toBe(true);
    expect(await readFile(path.join(uploadDirectory(), payload.result!.fileName))).toEqual(buffer);
  });

  it('rejects malformed image bytes and a truncated image despite a readable dimension header', async () => {
    for (const buffer of [Buffer.from('not an image'), png.subarray(0, 40)]) {
      const { response, payload } = await upload(buffer);
      expect(response.status).toBe(400);
      expect(payload.ok).toBe(false);
      expect(payload.errors?.[0]).toContain('损坏');
    }
    expect(existsSync(uploadDirectory())).toBe(false);
  });

  it('rejects renamed image formats, inconsistent MIME types, and SVG', async () => {
    const cases: [Buffer, string, string][] = [
      [png, 'fake.jpg', 'image/jpeg'],
      [png, 'fake.png', 'image/jpeg'],
      [png, 'fake.png', 'text/plain'],
      [png, 'fake.svg', 'image/svg+xml'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"/>'), 'fake.png', 'image/png']
    ];
    for (const [buffer, name, type] of cases) {
      const { response, payload } = await upload(buffer, name, type);
      expect(response.status).toBe(400);
      expect(payload.ok).toBe(false);
    }
    expect(existsSync(uploadDirectory())).toBe(false);
  });

  it('rejects empty and oversized files before writing any assets', async () => {
    expect((await upload(Buffer.alloc(0))).response.status).toBe(400);
    expect((await upload(Buffer.alloc(ADMIN_HERO_UPLOAD_MAX_BYTES + 1))).response.status).toBe(413);
    expect(existsSync(uploadDirectory())).toBe(false);
  });

  it('deduplicates identical uploads and keeps previous images when a different image is uploaded', async () => {
    const first = await upload(png);
    const second = await upload(png, '../../other-name.png');
    const third = await upload(await createImage('png', '#446688'));
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(third.response.status).toBe(200);
    expect(second.payload.result).toEqual(first.payload.result);
    expect(third.payload.result?.path).not.toBe(first.payload.result?.path);
    expect(await readdir(uploadDirectory())).toHaveLength(2);
    expect(await readFile(path.join(uploadDirectory(), first.payload.result!.fileName))).toEqual(png);
  });

  it('generates server-side names inside the upload directory regardless of client path', async () => {
    for (const name of ['../../../outside.png', '..\\..\\outside.png']) {
      const { response, payload } = await upload(png, name);
      expect(response.status).toBe(200);
      const filePath = path.resolve(tempRoot, payload.result!.path);
      expect(path.dirname(filePath)).toBe(uploadDirectory());
      expect(payload.result!.fileName).not.toContain('outside');
    }
    expect(existsSync(path.join(tempRoot, 'outside.png'))).toBe(false);
  });

  it('never overwrites an existing asset with conflicting contents', async () => {
    const first = await upload(png);
    const filePath = path.join(uploadDirectory(), first.payload.result!.fileName);
    const changedBytes = Buffer.from('a manually changed pre-existing file');
    await writeFile(filePath, changedBytes);
    const second = await upload(png);
    expect(second.response.status).toBe(409);
    expect(await readFile(filePath)).toEqual(changedBytes);
  });

  it('requires same-origin multipart requests and an image file; GET is POST-only', async () => {
    expect((await upload(png, 'hero.png', 'image/png', 'https://other.example')).response.status).toBe(403);
    expect((await upload(png, 'hero.png', 'image/png', '')).response.status).toBe(403);
    const request = new Request(ENDPOINT, {
      method: 'POST',
      headers: { origin: new URL(ENDPOINT).origin, 'content-type': 'application/json' },
      body: '{}'
    });
    expect((await POST({ request, url: new URL(ENDPOINT) } as never)).status).toBe(415);
    const emptyForm = new Request(ENDPOINT, {
      method: 'POST', headers: { origin: new URL(ENDPOINT).origin }, body: new FormData()
    });
    expect((await POST({ request: emptyForm, url: new URL(ENDPOINT) } as never)).status).toBe(400);
    const get = await GET({} as never);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(existsSync(uploadDirectory())).toBe(false);
  });

  it('waits for the settings write lock and preserves the settings just saved', async () => {
    const settingsPath = path.join(tempRoot, 'home.json');
    await writeFile(settingsPath, 'original');
    let unlock!: () => void;
    let lockStarted!: () => void;
    const entered = new Promise<void>((resolve) => { lockStarted = resolve; });
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const save = withAdminSettingsWriteLock(async () => {
      lockStarted();
      await gate;
      await writeFile(settingsPath, 'just saved');
    });
    await entered;
    let completed = false;
    const pending = upload(png).then((result) => { completed = true; return result; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      expect(existsSync(uploadDirectory())).toBe(false);
    } finally {
      unlock();
    }
    await save;
    expect((await pending).response.status).toBe(200);
    expect(await readFile(settingsPath, 'utf8')).toBe('just saved');
  });

  it('reports unexpected filesystem failures without returning internal paths', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mkdir(path.dirname(uploadDirectory()), { recursive: true });
    await writeFile(uploadDirectory(), 'existing file blocks the directory');
    const { response, payload } = await upload(png);
    expect(response.status).toBe(500);
    expect(payload.errors).toEqual(['Hero 图片上传失败，请稍后重试']);
    expect(JSON.stringify(payload)).not.toContain(tempRoot);
    expect(errorLog).toHaveBeenCalledOnce();
  });
});
