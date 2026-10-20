import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/admin-console/content-source-index', () => ({
  getAdminContentSourceCounts: vi.fn(),
  loadAdminContentSourceIndex: vi.fn(),
  loadAdminContentSourceIndexWithBody: vi.fn(),
  loadAdminContentSourceManifest: vi.fn()
}));

const sourceIndexModule = await import('../src/lib/admin-console/content-source-index');
const contentRoutesModule = await import('../src/lib/admin-console/content-routes');

const {
  filterAdminContentItems,
  getAdminContentConsolePageData,
  getAdminContentFilterHref,
  getAdminContentFilterState,
  getAdminContentPublicFallbackLabel
} = await import('../src/lib/admin-console/content');

type AdminContentIndexItem = import('../src/lib/admin-console/content').AdminContentIndexItem;
type AdminContentCollectionKey = import('../src/lib/admin-console/content').AdminContentCollectionKey;
type AdminContentSourceCountMap = import('../src/lib/admin-console/content-source-index').AdminContentSourceCountMap;
type AdminContentSourceIndexItem = import('../src/lib/admin-console/content-source-index').AdminContentSourceIndexItem;
type AdminContentSourceIndexItemWithBody =
  import('../src/lib/admin-console/content-source-index').AdminContentSourceIndexItemWithBody;
type AdminContentSourceManifest = import('../src/lib/admin-console/content-source-index').AdminContentSourceManifest;

const mockedSourceIndex = vi.mocked(sourceIndexModule);
const { getAdminContentEntryListHref } = contentRoutesModule;

const COLLECTION_LABELS: Record<AdminContentCollectionKey, string> = {
  essay: '随笔',
  bits: '絮语',
  memo: '小记',
  about: '关于'
};

const defaultManifest: AdminContentSourceManifest = {
  essay: ['src/content/essay/essay-a.md', 'src/content/essay/essay-b.md'],
  bits: ['src/content/bits/bits-a.md'],
  memo: ['src/content/memo/index.md'],
  about: ['src/content/about/index.md']
};

let sourceItemsByCollection: Record<AdminContentCollectionKey, AdminContentIndexItem[]>;
let bodyItemsByCollection: Record<AdminContentCollectionKey, AdminContentIndexItem[]>;
let sourceCounts: AdminContentSourceCountMap;

const createItem = (overrides: Partial<AdminContentIndexItem> = {}): AdminContentIndexItem => {
  const collection = overrides.collection ?? 'essay';
  return {
    collection,
    collectionLabel: COLLECTION_LABELS[collection],
    id: 'admin-console-guide',
    publicEntryId: 'admin-console-guide',
    title: 'Admin Console Guide',
    slug: 'admin-console-guide',
    relativePath: `src/content/${collection}/admin-console-guide.md`,
    publicHref: '/archive/admin-console-guide/',
    isDraft: false,
    archive: true,
    date: new Date('2026-04-01T00:00:00.000Z'),
    dateLabel: '2026-04-01',
    year: 2026,
    tags: ['admin'],
    searchHaystack: 'admin console guide admin admin-console-guide guide description',
    readonlyReason: null,
    sourceError: null,
    ...overrides
  };
};

describe('essay visibility filters', () => {
  it('filters private articles independently of draft state and preserves visibility in filter links', () => {
    const items = [
      createItem({ id: 'public', visibility: 'public' }),
      createItem({ id: 'private', visibility: 'private' }),
      createItem({ id: 'private-draft', visibility: 'private', isDraft: true })
    ];
    const state = getAdminContentFilterState(new URLSearchParams('collection=essay&visibility=private'));
    expect(filterAdminContentItems(items, state).map((item) => item.id)).toEqual(['private', 'private-draft']);
    expect(getAdminContentFilterHref(state, { sort: 'title' })).toContain('visibility=private');
    expect(filterAdminContentItems(items, { ...state, draft: 'published' }).map((item) => item.id)).toEqual(['private']);
    expect(filterAdminContentItems(items, { ...state, visibility: 'public' }).map((item) => item.id)).toEqual(['public']);
  });
});

const createDefaultItems = (): Record<AdminContentCollectionKey, AdminContentIndexItem[]> => ({
  essay: [createItem()],
  bits: [
    createItem({
      collection: 'bits',
      collectionLabel: '絮语',
      id: 'bits-2026-02-03-2230',
      publicEntryId: 'bits-2026-02-03-2230',
      title: 'Bits Note',
      slug: 'bits-2026-02-03-2230',
      relativePath: 'src/content/bits/bits-2026-02-03-2230.md',
      publicHref: '/bits/#bit-bits-2026-02-03-2230',
      archive: null,
      date: new Date('2026-02-03T14:30:00.000Z'),
      dateLabel: '2026-02-03',
      tags: ['bits'],
      searchHaystack: 'bits note bits-2026-02-03-2230 bits description'
    })
  ],
  memo: [
    createItem({
      collection: 'memo',
      collectionLabel: '小记',
      id: 'index',
      publicEntryId: 'index',
      title: 'Memo',
      slug: 'memo',
      relativePath: 'src/content/memo/index.md',
      publicHref: '/memo/',
      archive: null,
      date: new Date('2026-01-01T00:00:00.000Z'),
      dateLabel: '2026-01-01',
      tags: [],
      searchHaystack: 'memo memo subtitle index'
    })
  ],
  about: [
    createItem({
      collection: 'about',
      collectionLabel: '关于',
      id: 'index',
      publicEntryId: 'index',
      title: '关于',
      slug: 'about',
      relativePath: 'src/content/about/index.md',
      publicHref: '/about/',
      archive: null,
      date: null,
      dateLabel: '固定单页',
      year: null,
      tags: [],
      searchHaystack: '关于 about index friends contact'
    })
  ]
});

const toSourceItem = (item: AdminContentIndexItem): AdminContentSourceIndexItem => {
  const { collectionLabel: _collectionLabel, tags, ...sourceItem } = item;
  return {
    ...sourceItem,
    tags: tags.slice()
  };
};

const toSourceItemWithBody = (item: AdminContentIndexItem): AdminContentSourceIndexItemWithBody => ({
  ...toSourceItem(item),
  bodyText: 'Body text',
  bodyDerived: {
    plainText: 'Body text',
    excerpt: 'Body text',
    text: 'body text'
  }
});

const setSourceItems = (
  items: Partial<Record<AdminContentCollectionKey, AdminContentIndexItem[]>>,
  bodyItems: Partial<Record<AdminContentCollectionKey, AdminContentIndexItem[]>> = {}
) => {
  const defaults = createDefaultItems();
  sourceItemsByCollection = {
    ...defaults,
    ...items
  };
  bodyItemsByCollection = {
    essay: sourceItemsByCollection.essay.map((item) => ({
      ...item,
      searchHaystack: `${item.searchHaystack} essay body text`
    })),
    bits: sourceItemsByCollection.bits.map((item) => ({
      ...item,
      searchHaystack: `${item.searchHaystack} bits body text`
    })),
    memo: sourceItemsByCollection.memo.map((item) => ({
      ...item,
      searchHaystack: `${item.searchHaystack} memo body text`
    })),
    about: sourceItemsByCollection.about.map((item) => ({
      ...item,
      searchHaystack: `${item.searchHaystack} about body text`
    })),
    ...bodyItems
  };
};

const setSourceCounts = (counts: Partial<AdminContentSourceCountMap> = {}) => {
  sourceCounts = {
    essay: 2,
    bits: 1,
    memo: 1,
    about: 1,
    ...counts
  };
};

describe('admin-console/content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSourceItems({});
    setSourceCounts();
    mockedSourceIndex.loadAdminContentSourceManifest.mockResolvedValue(defaultManifest);
    mockedSourceIndex.getAdminContentSourceCounts.mockImplementation(() => sourceCounts);
    mockedSourceIndex.loadAdminContentSourceIndex.mockImplementation(async (_manifest, collection) =>
      sourceItemsByCollection[collection].map(toSourceItem)
    );
    mockedSourceIndex.loadAdminContentSourceIndexWithBody.mockImplementation(async (_manifest, collection) =>
      bodyItemsByCollection[collection].map(toSourceItemWithBody)
    );
  });

  it('normalizes content filter state from URL search params', () => {
    const state = getAdminContentFilterState(new URLSearchParams([
      ['q', '  Astro   Admin  '],
      ['collection', 'bits'],
      ['draft', 'draft'],
      ['tag', 'Astro Build'],
      ['year', '2026'],
      ['sort', 'title']
    ]));

    expect(state.query).toBe('Astro   Admin');
    expect(state.queryTokens).toEqual(['astro', 'admin']);
    expect(state.collection).toBe('bits');
    expect(state.draft).toBe('draft');
    expect(state.tag).toBe('astro-build');
    expect(state.year).toBe(2026);
    expect(state.sort).toBe('title');
    expect(state.entryId).toBe('');
    expect(state.page).toBe(1);
  });

  it('normalizes malformed page params to the first page', () => {
    expect(getAdminContentFilterState(new URLSearchParams([
      ['collection', 'essay'],
      ['page', '2']
    ])).page).toBe(2);
    expect(getAdminContentFilterState(new URLSearchParams([
      ['collection', 'essay'],
      ['page', '2abc']
    ])).page).toBe(1);
    expect(getAdminContentFilterState(new URLSearchParams([
      ['collection', 'essay'],
      ['page', '1.5']
    ])).page).toBe(1);
  });

  it('builds content list hrefs with source entryId query identity', () => {
    expect(getAdminContentEntryListHref('essay')).toBe('/admin/content/?collection=essay');
    expect(getAdminContentEntryListHref('essay', { entryId: 'drafts/my note.md' }))
      .toBe('/admin/content/?collection=essay&entryId=drafts%2Fmy+note.md');
  });

  it('filters content items by query, draft, tag and year', () => {
    const items = [
      createItem(),
      createItem({
        id: 'essay/draft',
        title: 'Draft Entry',
        slug: 'draft-entry',
        isDraft: true,
        tags: ['draft'],
        year: 2025,
        searchHaystack: 'draft entry draft-entry draft'
      }),
      createItem({
        collection: 'bits',
        collectionLabel: '絮语',
        id: 'bits/note',
        title: 'Bits Note',
        slug: 'bits-note',
        relativePath: 'src/content/bits/note.md',
        tags: ['bits'],
        searchHaystack: 'bits note bits-note bits'
      })
    ];

    const filtered = filterAdminContentItems(items, {
      collection: 'all',
      query: 'admin',
      queryTokens: ['admin'],
      draft: 'published',
      tag: 'admin',
      year: 2026,
      sort: 'recent',
      entryId: '',
      page: 1
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('admin-console-guide');
  });

  it('filters content items by collection scope before other filters', () => {
    const items = [
      createItem(),
      createItem({
        collection: 'bits',
        collectionLabel: '絮语',
        id: 'bits/note',
        title: 'Bits Note',
        slug: 'bits-note',
        relativePath: 'src/content/bits/note.md',
        tags: ['admin'],
        searchHaystack: 'bits note bits-note admin'
      })
    ];

    const filtered = filterAdminContentItems(items, {
      collection: 'bits',
      query: '',
      queryTokens: [],
      draft: 'all',
      tag: 'admin',
      year: null,
      sort: 'recent',
      entryId: '',
      page: 1
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.collection).toBe('bits');
  });

  it('loads source index data only for the selected collection scope', async () => {
    const pageData = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'essay']
    ]));

    expect(mockedSourceIndex.loadAdminContentSourceManifest).toHaveBeenCalledTimes(1);
    expect(mockedSourceIndex.getAdminContentSourceCounts).toHaveBeenCalledWith(defaultManifest);
    expect(mockedSourceIndex.loadAdminContentSourceIndex).toHaveBeenCalledTimes(1);
    expect(mockedSourceIndex.loadAdminContentSourceIndex).toHaveBeenCalledWith(defaultManifest, 'essay');
    expect(mockedSourceIndex.loadAdminContentSourceIndexWithBody).not.toHaveBeenCalled();
    expect(pageData.totalCount).toBe(5);
    expect(pageData.mode).toBe('collection');
    expect(pageData.pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 1,
      totalPages: 1,
      hasPrev: false,
      hasNext: false
    });
    expect(pageData.collectionOptions).toEqual([
      { value: 'all', label: '全部内容', count: 5 },
      { value: 'essay', label: '随笔', count: 2 },
      { value: 'bits', label: '絮语', count: 1 },
      { value: 'memo', label: '小记', count: 1 },
      { value: 'about', label: '关于', count: 1 }
    ]);
    expect('tagOptions' in pageData).toBe(false);
    expect(pageData.sections).toHaveLength(1);
    expect(pageData.sections[0]?.collection).toBe('essay');
    expect(pageData.sections[0]?.totalCount).toBe(2);
  });

  it('keeps legacy URL tag filters compatible without exposing tag options', async () => {
    const pageData = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'essay'],
      ['tag', 'Missing Tag']
    ]));

    expect(pageData.filterState.tag).toBe('missing-tag');
    expect(pageData.filteredCount).toBe(0);
    expect(pageData.hasActiveFilters).toBe(true);
    expect('tagOptions' in pageData).toBe(false);
  });

  it('loads body search text only when a scoped query is active', async () => {
    const pageData = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'essay'],
      ['q', 'body']
    ]));

    expect(mockedSourceIndex.loadAdminContentSourceIndex).not.toHaveBeenCalled();
    expect(mockedSourceIndex.loadAdminContentSourceIndexWithBody).toHaveBeenCalledTimes(1);
    expect(mockedSourceIndex.loadAdminContentSourceIndexWithBody).toHaveBeenCalledWith(defaultManifest, 'essay');
    expect(pageData.filteredCount).toBe(1);
    expect(pageData.sections[0]?.items[0]?.id).toBe('admin-console-guide');
  });

  it('searches all collections in metadata mode without loading body search text', async () => {
    const pageData = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'all'],
      ['q', 'admin'],
      ['draft', 'draft'],
      ['page', '2']
    ]));

    expect(pageData.mode).toBe('search');
    expect(pageData.filterState.query).toBe('admin');
    expect(pageData.filterState.draft).toBe('all');
    expect(pageData.filterState.page).toBe(1);
    expect(pageData.pagination).toBeNull();
    expect(mockedSourceIndex.loadAdminContentSourceIndexWithBody).not.toHaveBeenCalled();
    expect(mockedSourceIndex.loadAdminContentSourceIndex).toHaveBeenCalledTimes(4);
    expect(pageData.filteredCount).toBe(1);
    expect(pageData.sections.find((section) => section.collection === 'essay')?.items[0]?.id)
      .toBe('admin-console-guide');
  });

  it('keeps untitled bits out of body-derived all content search', async () => {
    const metadataItem = createItem({
      collection: 'bits',
      collectionLabel: '絮语',
      id: 'untitled-bit',
      publicEntryId: 'untitled-bit',
      title: 'untitled-bit',
      slug: 'untitled-bit',
      relativePath: 'src/content/bits/untitled-bit.md',
      publicHref: '/bits/#bit-untitled-bit',
      archive: null,
      tags: [],
      searchHaystack: 'untitled-bit'
    });
    const bodyItem = {
      ...metadataItem,
      searchHaystack: 'untitled-bit body-only-marker'
    };
    setSourceItems({ bits: [metadataItem] }, { bits: [bodyItem] });

    const pageData = await getAdminContentConsolePageData(new URLSearchParams([
      ['q', 'body-only-marker']
    ]));
    const bitsSection = pageData.sections.find((section) => section.collection === 'bits');

    expect(pageData.mode).toBe('search');
    expect(mockedSourceIndex.loadAdminContentSourceIndexWithBody).not.toHaveBeenCalled();
    expect(bitsSection?.items).toEqual([]);
  });

  it('loads untitled bits body text only for collection search', async () => {
    const metadataItem = createItem({
      collection: 'bits',
      collectionLabel: '絮语',
      id: 'untitled-bit',
      publicEntryId: 'untitled-bit',
      title: 'untitled-bit',
      slug: 'untitled-bit',
      relativePath: 'src/content/bits/untitled-bit.md',
      publicHref: '/bits/#bit-untitled-bit',
      archive: null,
      tags: [],
      searchHaystack: 'untitled-bit'
    });
    const bodyItem = {
      ...metadataItem,
      searchHaystack: 'untitled-bit body-only-marker'
    };
    setSourceItems({ bits: [metadataItem] }, { bits: [bodyItem] });

    const pageData = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'bits'],
      ['q', 'body-only-marker']
    ]));

    expect(pageData.mode).toBe('collection');
    expect(mockedSourceIndex.loadAdminContentSourceIndexWithBody).toHaveBeenCalledTimes(1);
    expect(pageData.sections[0]?.items[0]?.id).toBe('untitled-bit');
  });

  it('uses entryId as an exact source identity without public slug fallback', async () => {
    setSourceItems({
      essay: [
        createItem({
          id: 'source file',
          publicEntryId: 'public-slug',
          relativePath: 'src/content/essay/source file.md'
        })
      ]
    });

    const matched = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'essay'],
      ['entryId', 'source file'],
      ['q', 'body']
    ]));
    const unmatched = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'essay'],
      ['entryId', 'public-slug']
    ]));

    expect(matched.mode).toBe('entry');
    expect(matched.filterState.entryId).toBe('source file');
    expect(matched.filterState.query).toBe('');
    expect(matched.sections[0]?.items[0]?.id).toBe('source file');
    expect(matched.pagination).toBeNull();
    expect(unmatched.filteredCount).toBe(0);
    expect(unmatched.sections[0]?.items).toEqual([]);
    expect(mockedSourceIndex.loadAdminContentSourceIndexWithBody).not.toHaveBeenCalled();
  });

  it('ignores legacy entry query params', async () => {
    const pageData = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'essay'],
      ['entry', 'admin-console-guide']
    ]));

    expect(pageData.mode).toBe('collection');
    expect(pageData.filterState.entryId).toBe('');
    expect(pageData.filteredCount).toBe(1);
  });

  it('uses the source file path as the admin entry id when the public id is normalized', async () => {
    setSourceItems({
      essay: [
        createItem({
          id: 'admin-console-guide copy',
          publicEntryId: 'admin-console-guide-copy',
          relativePath: 'src/content/essay/admin-console-guide copy.md',
          publicHref: '/archive/admin-console-guide-copy/'
        })
      ]
    });

    const pageData = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'essay']
    ]));
    const item = pageData.sections[0]?.items[0];

    expect(item?.id).toBe('admin-console-guide copy');
    expect(item?.publicEntryId).toBe('admin-console-guide-copy');
    expect(item?.relativePath).toBe('src/content/essay/admin-console-guide copy.md');
    expect(item?.publicHref).toBe('/archive/admin-console-guide-copy/');
  });

  it('paginates collection scope data in the page data layer', async () => {
    const entries = Array.from({ length: 25 }, (_, index) => createItem({
      id: `essay-${String(index + 1).padStart(2, '0')}`,
      publicEntryId: `essay-${String(index + 1).padStart(2, '0')}`,
      title: `Essay ${index + 1}`
    }));
    setSourceItems({ essay: entries });
    setSourceCounts({ essay: 25, bits: 0, memo: 0, about: 0 });

    const secondPage = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'essay'],
      ['page', '2']
    ]));
    const overBoundPage = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'essay'],
      ['page', '99']
    ]));

    expect(secondPage.pagination).toEqual({
      page: 2,
      pageSize: 20,
      totalItems: 25,
      totalPages: 2,
      hasPrev: true,
      hasNext: false
    });
    expect(secondPage.sections[0]?.filteredCount).toBe(25);
    expect(secondPage.sections[0]?.items).toHaveLength(5);
    expect(overBoundPage.pagination?.page).toBe(2);
  });

  it('limits overview sections without paginating in the template layer', async () => {
    const entries = Array.from({ length: 10 }, (_, index) => createItem({
      id: `overview-${index + 1}`,
      publicEntryId: `overview-${index + 1}`
    }));
    setSourceItems({ essay: entries, bits: [], memo: [], about: [] });
    setSourceCounts({ essay: 10, bits: 0, memo: 0, about: 0 });

    const pageData = await getAdminContentConsolePageData(new URLSearchParams());
    const essaySection = pageData.sections.find((section) => section.collection === 'essay');

    expect(pageData.mode).toBe('overview');
    expect(pageData.pagination).toBeNull();
    expect(essaySection?.filteredCount).toBe(10);
    expect(essaySection?.items).toHaveLength(8);
  });

  it('uses source-index public hrefs in the bits list without loading body index', async () => {
    const pageData = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'bits']
    ]));

    expect(mockedSourceIndex.loadAdminContentSourceIndex).toHaveBeenCalledTimes(1);
    expect(mockedSourceIndex.loadAdminContentSourceIndexWithBody).not.toHaveBeenCalled();
    expect(pageData.sections[0]?.items[0]?.publicHref).toBe('/bits/#bit-bits-2026-02-03-2230');
  });

  it('preserves draft and published bits hrefs from the source index', async () => {
    const draftItem = createItem({
      collection: 'bits',
      collectionLabel: '絮语',
      id: 'draft',
      publicEntryId: 'draft',
      title: 'Draft Bits',
      slug: 'draft',
      relativePath: 'src/content/bits/draft.md',
      publicHref: null,
      isDraft: true,
      archive: null,
      searchHaystack: 'draft bits'
    });
    const publishedEntries = Array.from({ length: 20 }, (_, index) => {
      const id = `published-${String(index + 1).padStart(2, '0')}`;
      return createItem({
        collection: 'bits',
        collectionLabel: '絮语',
        id,
        publicEntryId: id,
        title: `Published ${index + 1}`,
        slug: id,
        relativePath: `src/content/bits/${id}.md`,
        publicHref: id === 'published-20' ? '/bits/page/2/#bit-published-20' : `/bits/#bit-${id}`,
        archive: null,
        searchHaystack: `published ${index + 1}`
      });
    });
    setSourceItems({ bits: [draftItem, ...publishedEntries] });
    setSourceCounts({ essay: 0, bits: 21, memo: 0, about: 0 });

    const firstPage = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'bits']
    ]));
    const secondPage = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'bits'],
      ['page', '2']
    ]));
    const draft = firstPage.sections[0]?.items.find((item) => item.id === 'draft');
    const lastPublishedItem = secondPage.sections[0]?.items.find((item) => item.id === 'published-20');

    expect(draft?.publicHref).toBeNull();
    expect(lastPublishedItem?.publicHref).toBe('/bits/page/2/#bit-published-20');
  });

  it('returns readable public fallback labels for non-public entries', () => {
    expect(getAdminContentPublicFallbackLabel(createItem({ isDraft: true, publicHref: null }))).toContain('draft');
    expect(
      getAdminContentPublicFallbackLabel(createItem({
        collection: 'memo',
        collectionLabel: '小记',
        id: 'index',
        publicHref: null,
        relativePath: 'src/content/memo/index.md'
      }))
    ).toContain('/memo/');
    expect(
      getAdminContentPublicFallbackLabel(createItem({
        collection: 'about',
        collectionLabel: '关于',
        id: 'index',
        publicHref: null,
        relativePath: 'src/content/about/index.md'
      }))
    ).toContain('/about/');
    expect(
      getAdminContentPublicFallbackLabel(createItem({
        collection: 'bits',
        collectionLabel: '絮语',
        id: 'example',
        slug: 'bits-example',
        publicHref: null,
        relativePath: 'src/content/bits/example.md'
      }))
    ).toContain('bit-bits-example');
  });

  it('keeps fixed-page about scope out of article filters and pagination', async () => {
    const pageData = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'about'],
      ['draft', 'draft'],
      ['tag', 'Admin'],
      ['year', '2026'],
      ['sort', 'title'],
      ['page', '3']
    ]));

    expect(pageData.mode).toBe('collection');
    expect(pageData.filterState).toMatchObject({
      collection: 'about',
      draft: 'all',
      tag: '',
      year: null,
      sort: 'recent',
      page: 1
    });
    expect(pageData.pagination).toBeNull();
    expect(pageData.sections).toHaveLength(1);
    expect(pageData.sections[0]?.collection).toBe('about');
    expect(pageData.sections[0]?.items[0]).toMatchObject({
      collection: 'about',
      title: '关于',
      publicHref: '/about/',
      readonlyReason: null
    });
  });

  it('drops article-only filter params when building fixed-page scope links', () => {
    const filterState = getAdminContentFilterState(new URLSearchParams([
      ['collection', 'essay'],
      ['q', 'about body'],
      ['draft', 'draft'],
      ['tag', 'Admin'],
      ['year', '2026'],
      ['sort', 'title'],
      ['page', '3']
    ]));

    expect(getAdminContentFilterHref(filterState, { collection: 'about' }))
      .toBe('/admin/content/?q=about+body&collection=about');
    expect(getAdminContentFilterHref(filterState, { collection: 'memo' }))
      .toBe('/admin/content/?q=about+body&collection=memo');
    expect(getAdminContentFilterHref(filterState, { collection: 'bits' }))
      .toBe('/admin/content/?q=about+body&collection=bits&draft=draft&sort=title&year=2026');
    expect(getAdminContentFilterHref(filterState, { collection: 'all' }))
      .toBe('/admin/content/?q=about+body');
  });

  it('loads about body search text through the fixed-page bodySearch capability', async () => {
    const pageData = await getAdminContentConsolePageData(new URLSearchParams([
      ['collection', 'about'],
      ['q', 'body']
    ]));

    expect(mockedSourceIndex.loadAdminContentSourceIndex).not.toHaveBeenCalled();
    expect(mockedSourceIndex.loadAdminContentSourceIndexWithBody).toHaveBeenCalledTimes(1);
    expect(mockedSourceIndex.loadAdminContentSourceIndexWithBody).toHaveBeenCalledWith(defaultManifest, 'about');
    expect(pageData.filteredCount).toBe(1);
    expect(pageData.sections[0]?.items[0]?.collection).toBe('about');
  });
});
