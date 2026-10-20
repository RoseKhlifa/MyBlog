import { describe, expect, it } from 'vitest';
import {
  getContentEditorAdapter
} from '../src/components/admin/editor/shared/content-editor-adapters';
import {
  getPayloadEditorBody,
  getPayloadEditorValues
} from '../src/scripts/admin-content/entry-transport';
import type { AdminAboutEditorValues } from '../src/lib/admin-console/content-about-contract';
import type {
  AdminBitsEditorValues,
  AdminEssayEditorValues,
  AdminContentWriteCollectionKey,
  AdminMemoEditorValues
} from '../src/lib/admin-console/content-shared';
import { getAdminContentCollectionCapability } from '../src/lib/admin-console/content-collections';

describe('content editor adapters', () => {
  it('preserves private visibility when cloning essay values and detects visibility-only changes', () => {
    const adapter = getContentEditorAdapter('essay');
    const privateValues: AdminEssayEditorValues = {
      title: 'Private article',
      description: '',
      date: '2026-10-20',
      publishedAt: '',
      updatedAt: '',
      tagsText: '',
      draft: false,
      visibility: 'private',
      archive: true,
      slug: 'private-article',
      cover: '',
      badge: ''
    };
    const cloned = adapter.cloneValues(privateValues);
    expect(cloned.visibility).toBe('private');
    expect(adapter.isEqualValues(cloned, privateValues)).toBe(true);
    expect(adapter.isEqualValues(cloned, { ...cloned, visibility: 'public' })).toBe(false);
    expect(adapter.isFrontmatterIssuePath('visibility')).toBe(true);
    expect(adapter.getWriteFieldLabel('visibility')).toBe('可见性');

    const { visibility: _visibility, ...legacyValues } = privateValues;
    expect(adapter.cloneValues(legacyValues).visibility).toBe('public');
  });

  it('keeps essay body image tools separate from bits image array tools', () => {
    const essay = getContentEditorAdapter('essay');
    const bits = getContentEditorAdapter('bits');
    const memo = getContentEditorAdapter('memo');
    const about = getContentEditorAdapter('about');

    expect(essay.capabilities.bodyImageInsert).toBe(true);
    expect(essay.capabilities.imageArray).toBe(false);
    expect(essay.capabilities.delete).toBe(true);

    expect(bits.capabilities.body).toBe(true);
    expect(bits.capabilities.preview).toBe(true);
    expect(bits.capabilities.bodyImageInsert).toBe(false);
    expect(bits.capabilities.bodyGalleryInsert).toBe(false);
    expect(bits.capabilities.imageArray).toBe(true);
    expect(bits.capabilities.delete).toBe(true);
    expect(bits.isFrontmatterIssuePath('images[0].src')).toBe(true);
    expect(essay.isFrontmatterIssuePath('images[0].src')).toBe(false);

    expect(memo.capabilities.body).toBe(true);
    expect(memo.capabilities.preview).toBe(true);
    expect(memo.capabilities.bodyImageInsert).toBe(true);
    expect(memo.capabilities.bodyGalleryInsert).toBe(false);
    expect(memo.capabilities.imageArray).toBe(false);
    expect(memo.capabilities.delete).toBe(false);
    expect(memo.isFrontmatterIssuePath('title')).toBe(false);
    expect(memo.isFrontmatterIssuePath('images[0].src')).toBe(false);

    expect(about.capabilities.body).toBe(true);
    expect(about.capabilities.preview).toBe(true);
    expect(about.capabilities.bodyImageInsert).toBe(false);
    expect(about.capabilities.bodyGalleryInsert).toBe(false);
    expect(about.capabilities.imageArray).toBe(false);
    expect(about.capabilities.delete).toBe(false);
    expect(about.frontmatterIssuePaths.size).toBe(0);
    expect(about.isFrontmatterIssuePath('friends[0].url')).toBe(false);
    expect(about.isFrontmatterIssuePath('faq[0].answer')).toBe(false);
    expect(about.isFrontmatterIssuePath('title')).toBe(false);
  });

  it('derives delete affordance from collection capabilities', () => {
    const collections: AdminContentWriteCollectionKey[] = ['essay', 'bits', 'memo', 'about'];

    for (const collection of collections) {
      const adapter = getContentEditorAdapter(collection);
      const capability = getAdminContentCollectionCapability(collection);
      expect(adapter.capabilities.delete).toBe(capability.deletable);
    }
  });

  it('ignores editor payloads for the wrong collection', () => {
    const bitsValues: AdminBitsEditorValues = {
      title: 'Bit',
      description: '',
      date: '2026-05-26T10:00:00+08:00',
      tagsText: '',
      draft: false,
      authorName: '',
      authorAvatar: '',
      imagesText: ''
    };
    const payload = {
      ok: true,
      payload: {
        collection: 'bits',
        entryId: '2026-05-26-bit',
        publicEntryId: '2026-05-26-bit',
        defaultPublicSlug: '2026-05-26-bit',
        revision: 'rev',
        relativePath: 'src/content/bits/2026-05-26-bit.md',
        writable: true,
        readonlyReason: null,
        bodyText: 'Bit body',
        values: bitsValues
      }
    };

    expect(getPayloadEditorValues(payload, 'bits')).toEqual(bitsValues);
    expect(getPayloadEditorValues(payload, 'essay')).toBeNull();
    expect(getPayloadEditorBody(payload, 'bits')).toBe('Bit body');
    expect(getPayloadEditorBody(payload, 'essay')).toBeNull();
  });

  it('accepts writable memo payloads with body text', () => {
    const memoValues: AdminMemoEditorValues = {
      title: 'Memo',
      subtitle: '',
      date: '',
      draft: false,
      slug: ''
    };
    const payload = {
      ok: true,
      payload: {
        collection: 'memo',
        entryId: 'index',
        publicEntryId: 'index',
        defaultPublicSlug: 'index',
        revision: 'rev',
        relativePath: 'src/content/memo/index.md',
        writable: true,
        readonlyReason: null,
        bodyText: 'Memo body',
        values: memoValues
      }
    };

    expect(getPayloadEditorValues(payload, 'memo')).toEqual(memoValues);
    expect(getPayloadEditorValues(payload, 'bits')).toBeNull();
    expect(getPayloadEditorBody(payload, 'memo')).toBe('Memo body');
  });

  it('accepts writable about payloads with body-only values', () => {
    const aboutValues: AdminAboutEditorValues = {};
    const payload = {
      ok: true,
      payload: {
        collection: 'about',
        entryId: 'index',
        publicEntryId: 'index',
        defaultPublicSlug: 'index',
        revision: 'rev',
        relativePath: 'src/content/about/index.md',
        writable: true,
        readonlyReason: null,
        bodyText: 'About body',
        values: aboutValues
      }
    };

    expect(getPayloadEditorValues(payload, 'about')).toEqual(aboutValues);
    expect(getPayloadEditorValues(payload, 'memo')).toBeNull();
    expect(getPayloadEditorBody(payload, 'about')).toBe('About body');
  });
});
