import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { createJsonRequest, setupAdminContentWriteFixture } from './admin-content-write-fixture';

const ENTRY_URL = 'http://127.0.0.1:4321/api/admin/content/entry/';
const CREATE_URL = 'http://127.0.0.1:4321/api/admin/content/create/';

describe('admin essay visibility contract', () => {
  const getTempRoot = setupAdminContentWriteFixture();
  const essayPath = () => path.join(getTempRoot(), 'src/content/essay/demo.md');

  const makePrivate = async () => {
    const source = await readFile(essayPath(), 'utf8');
    await writeFile(essayPath(), source.replace('draft: false', 'draft: false\nvisibility: private'), 'utf8');
  };

  const readEssay = async () => {
    const { readAdminContentEntryEditorPayload } = await import('../src/lib/admin-console/content-shared');
    const payload = await readAdminContentEntryEditorPayload('essay', 'demo');
    if (payload.collection !== 'essay') throw new Error('Expected essay');
    return payload;
  };

  const save = async (revision: string, frontmatter: unknown, body?: string) => {
    const { POST } = await import('../src/pages/api/admin/content/entry');
    return POST({
      request: createJsonRequest(ENTRY_URL, {
        collection: 'essay', entryId: 'demo', revision, frontmatter,
        ...(body === undefined ? {} : { body })
      }),
      url: new URL(ENTRY_URL)
    } as never);
  };

  it('defaults existing essays to public without adding visibility to unchanged files', async () => {
    const before = await readFile(essayPath(), 'utf8');
    const current = await readEssay();
    expect(current.values.visibility).toBe('public');
    const response = await save(current.revision, current.values);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result.changedFields).toEqual([]);
    expect(await readFile(essayPath(), 'utf8')).toBe(before);
  });

  it('round-trips private visibility independently of draft and archive', async () => {
    const current = await readEssay();
    const response = await save(current.revision, {
      ...current.values, visibility: 'private', draft: false, archive: false
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result.changedFields).toEqual(['visibility', 'archive']);
    const updated = await readEssay();
    expect(updated.values).toMatchObject({ visibility: 'private', draft: false, archive: false });
    expect(updated.bodyText).toBe(current.bodyText);
    const source = await readFile(essayPath(), 'utf8');
    expect(source).toContain('visibility: private');
    expect(source).toContain('archive: false');

    const publish = await save(updated.revision, { ...updated.values, visibility: 'public' });
    expect(publish.status).toBe(200);
    expect((await readEssay()).values.visibility).toBe('public');
  });

  it('preserves private visibility when an older editor omits visibility', async () => {
    await makePrivate();
    const current = await readEssay();
    const { visibility: _visibility, ...legacyValues } = current.values;
    const response = await save(current.revision, { ...legacyValues, title: 'Legacy edit' });
    expect(response.status).toBe(200);
    expect((await readEssay()).values).toMatchObject({ visibility: 'private', title: 'Legacy edit' });
    expect(await readFile(essayPath(), 'utf8')).toContain('visibility: private');
  });

  it.each(['hidden', '', null, true, 1, undefined])('rejects explicit invalid visibility %s without writing', async (visibility) => {
    await makePrivate();
    const current = await readEssay();
    const before = await readFile(essayPath(), 'utf8');
    // Undefined is not representable in JSON; exercise the parser directly for it.
    if (visibility === undefined) {
      const { parseAdminEssayEditorInput } = await import('../src/lib/admin-console/content-essay-frontmatter');
      const parsed = parseAdminEssayEditorInput({ ...current.values, visibility });
      expect(parsed.values).toBeUndefined();
      expect(parsed.issues).toContainEqual(expect.objectContaining({ path: 'visibility' }));
    } else {
      const response = await save(current.revision, { ...current.values, visibility });
      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.issues).toContainEqual(expect.objectContaining({ path: 'visibility' }));
    }
    expect(await readFile(essayPath(), 'utf8')).toBe(before);
  });

  it('creates a private essay as a draft and returns its visibility', async () => {
    const current = await readEssay();
    const { POST } = await import('../src/pages/api/admin/content/create');
    const response = await POST({
      request: createJsonRequest(CREATE_URL, {
        collection: 'essay', entryId: 'private-new',
        frontmatter: { ...current.values, visibility: 'private', draft: false }
      }),
      url: new URL(CREATE_URL)
    } as never);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.payload.values).toMatchObject({ visibility: 'private', draft: true });
    const createdSource = await readFile(path.join(getTempRoot(), 'src/content/essay/private-new.md'), 'utf8');
    expect(createdSource).toContain('visibility: private');
    expect(createdSource).toContain('draft: true');
  });

  it('rejects a stale visibility change and preserves the newer private source', async () => {
    const stale = await readEssay();
    await makePrivate();
    const before = await readFile(essayPath(), 'utf8');
    const response = await save(stale.revision, { ...stale.values, visibility: 'public' });
    expect(response.status).toBe(409);
    expect(await readFile(essayPath(), 'utf8')).toBe(before);
  });

  it('indexes private essays for the owner without an anonymous article link', async () => {
    await makePrivate();
    const { loadAdminContentSourceManifest, loadAdminContentSourceIndex } =
      await import('../src/lib/admin-console/content-source-index');
    const manifest = await loadAdminContentSourceManifest();
    const essays = await loadAdminContentSourceIndex(manifest, 'essay');
    expect(essays.find((entry) => entry.id === 'demo')).toMatchObject({
      visibility: 'private', isDraft: false, publicHref: null
    });
    expect(essays.find((entry) => entry.id === 'other')).toMatchObject({ visibility: 'public' });
    const bits = await loadAdminContentSourceIndex(manifest, 'bits');
    expect(bits[0]?.visibility).toBe('public');
  });

  it('retains private visibility through bulk draft updates and exact source exports', async () => {
    await makePrivate();
    const { POST: bulkStatus } = await import('../src/pages/api/admin/content/bulk-status');
    const current = await readEssay();
    const entry = { collection: 'essay', entryId: 'demo', expectedRelativePath: current.relativePath };
    const bulkUrl = 'http://127.0.0.1:4321/api/admin/content/bulk-status/';
    const response = await bulkStatus({
      request: createJsonRequest(bulkUrl, { targetDraft: true, entries: [entry] }), url: new URL(bulkUrl)
    } as never);
    expect(response.status).toBe(200);
    expect((await readEssay()).values).toMatchObject({ visibility: 'private', draft: true });

    const source = await readFile(essayPath(), 'utf8');
    const { GET: singleExport } = await import('../src/pages/api/admin/content/export');
    const singleResponse = await singleExport({
      url: new URL('http://127.0.0.1:4321/api/admin/content/export/?collection=essay&entryId=demo')
    } as never);
    expect(singleResponse.status).toBe(200);
    expect(await singleResponse.text()).toBe(source);

    const { POST: bulkExport } = await import('../src/pages/api/admin/content/bulk-export');
    const exportUrl = 'http://127.0.0.1:4321/api/admin/content/bulk-export/';
    const exportResponse = await bulkExport({
      request: createJsonRequest(exportUrl, { entries: [entry] }), url: new URL(exportUrl)
    } as never);
    expect(exportResponse.status).toBe(200);
    const zip = unzipSync(new Uint8Array(await exportResponse.arrayBuffer()));
    const markdownEntry = Object.entries(zip).find(([entryPath]) => entryPath.endsWith('/demo.md'));
    expect(markdownEntry).toBeDefined();
    expect(strFromU8(markdownEntry![1])).toBe(source);
  });
});
