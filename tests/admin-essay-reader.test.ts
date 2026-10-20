import { describe, expect, it, vi } from 'vitest';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setupAdminContentWriteFixture } from './admin-content-write-fixture';

vi.mock('../src/lib/admin-console/preview', () => ({
  renderAdminMarkdownPreview: vi.fn(async ({ source }) => ({ html: `<p>${source}</p>` }))
}));

describe('authenticated essay reader saved source', () => {
  const getRoot = setupAdminContentWriteFixture();
  const sourcePath = () => path.join(getRoot(), 'src/content/essay/demo.md');
  const read = async (slug = 'demo') => (await import('../src/lib/admin-console/essay-reader')).readAdminEssayReader(slug);

  it('reads current private/public/private state without a collection cache', async () => {
    const original = await readFile(sourcePath(), 'utf8');
    for (const visibility of ['private', 'public', 'private']) {
      await writeFile(sourcePath(), original.replace('draft: false', `draft: false\nvisibility: ${visibility}`));
      const result = await read();
      expect(result?.entry.data.visibility).toBe(visibility);
      expect(result?.entry.data.draft).toBe(false);
      expect(result?.entry.body).toContain('正文保持不变。');
      expect(result?.html).toContain('正文保持不变。');
    }
  });

  it('returns no reader after the source is deleted', async () => {
    expect(await read()).not.toBeNull();
    await unlink(sourcePath());
    expect(await read()).toBeNull();
  });

  it('uses the latest custom slug and body instead of a stale route entry', async () => {
    const original = await readFile(sourcePath(), 'utf8');
    await writeFile(sourcePath(), original.replace('draft: false', 'draft: true\nvisibility: private\nslug: owner-only').replace('正文保持不变。', 'Updated owner body'));
    expect(await read('demo')).toBeNull();
    const result = await read('owner-only');
    expect(result?.entry.data).toMatchObject({ draft: true, visibility: 'private', slug: 'owner-only' });
    expect(result?.html).toContain('Updated owner body');
  });

  it('omits invalid source metadata from the reading route', async () => {
    const original = await readFile(sourcePath(), 'utf8');
    await writeFile(sourcePath(), original.replace('draft: false', 'draft: false\nvisibility: invalid'));
    expect(await read()).toBeNull();
  });
});
