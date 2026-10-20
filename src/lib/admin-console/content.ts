import {
  ADMIN_CONTENT_COLLECTION_PAGE_SIZE,
  ADMIN_CONTENT_COLLECTIONS,
  ADMIN_CONTENT_OVERVIEW_SECTION_LIMIT,
  ADMIN_CONTENT_SCOPE_OPTIONS,
  isAdminContentScopeKey,
  type AdminContentCollectionKey,
  type AdminContentScopeKey
} from './content-routes';
import {
  getAdminContentSourceCounts,
  loadAdminContentSourceIndex,
  loadAdminContentSourceIndexWithBody,
  loadAdminContentSourceManifest,
  type AdminContentSourceCountMap,
  type AdminContentSourceIndexItem,
  type AdminContentSourceManifest
} from './content-source-index';
import { getBitAnchorId } from '../bits-public-routing';
import { getTagKeys, isRoutableTagKey, toTagKey } from '../tags';
import { tokenizeSearchQuery } from '../../utils/format';
import { getAdminContentCollectionCapability } from './content-collections';

export type AdminContentDraftFilter = 'all' | 'draft' | 'published';
export type AdminContentVisibilityFilter = 'all' | 'public' | 'private';
export type AdminContentSortKey = 'recent' | 'title';
export type AdminContentConsoleMode = 'overview' | 'search' | 'collection' | 'entry';

export type AdminContentIndexItem = AdminContentSourceIndexItem & {
  collectionLabel: string;
};

export type AdminContentFilterOption = {
  value: string;
  label: string;
  count: number;
};

export type AdminContentScopeOption = {
  value: AdminContentScopeKey;
  label: string;
  count: number;
};

export type AdminContentCollectionSection = {
  collection: AdminContentCollectionKey;
  collectionLabel: string;
  totalCount: number;
  filteredCount: number;
  items: AdminContentIndexItem[];
};

export type AdminContentFilterState = {
  collection: AdminContentScopeKey;
  query: string;
  queryTokens: string[];
  draft: AdminContentDraftFilter;
  visibility?: AdminContentVisibilityFilter;
  tag: string;
  year: number | null;
  sort: AdminContentSortKey;
  entryId: string;
  page: number;
};

export type AdminContentFilterHrefUpdates = {
  collection?: AdminContentScopeKey;
  draft?: AdminContentDraftFilter;
  visibility?: AdminContentVisibilityFilter;
  sort?: AdminContentSortKey;
  year?: string | number | null;
};

export type AdminContentPagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
};

export type AdminContentConsolePageData = {
  mode: AdminContentConsoleMode;
  collection: AdminContentScopeKey;
  collectionLabel: string;
  totalCount: number;
  filteredCount: number;
  sections: AdminContentCollectionSection[];
  collectionOptions: AdminContentScopeOption[];
  yearOptions: AdminContentFilterOption[];
  filterState: AdminContentFilterState;
  pagination: AdminContentPagination | null;
  hasActiveFilters: boolean;
};

export {
  ADMIN_CONTENT_COLLECTION_PAGE_SIZE,
  ADMIN_CONTENT_COLLECTIONS,
  ADMIN_CONTENT_OVERVIEW_SECTION_LIMIT,
  ADMIN_CONTENT_SCOPE_OPTIONS,
  getAdminContentEntryEditHref,
  getAdminContentEntryListHref,
  isAdminContentCollectionKey,
  isAdminContentScopeKey
} from './content-routes';
export {
  getAdminContentCollectionCapability
} from './content-collections';
export type {
  AdminContentCollectionKey,
  AdminContentScopeKey
} from './content-routes';

export const ADMIN_CONTENT_SORT_OPTIONS = [
  { value: 'recent', label: '最近更新' },
  { value: 'title', label: '标题 A-Z' }
] as const satisfies readonly { value: AdminContentSortKey; label: string }[];

export const ADMIN_CONTENT_DRAFT_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'published', label: '已发布' },
  { value: 'draft', label: '仅草稿' }
] as const satisfies readonly { value: AdminContentDraftFilter; label: string }[];

const COLLECTION_ORDER = new Map<AdminContentCollectionKey, number>(
  ADMIN_CONTENT_COLLECTIONS.map((collection, index) => [collection, index])
);

const getCollectionLabel = (collection: AdminContentCollectionKey): string =>
  getAdminContentCollectionCapability(collection).label;

const shouldUseArticleFilters = (collection: AdminContentScopeKey): boolean =>
  collection !== 'all' && getAdminContentCollectionCapability(collection).articleFilters;

const isAdminContentDraftFilter = (value: string): value is AdminContentDraftFilter =>
  ADMIN_CONTENT_DRAFT_OPTIONS.some((option) => option.value === value);

const isAdminContentSortKey = (value: string): value is AdminContentSortKey =>
  ADMIN_CONTENT_SORT_OPTIONS.some((option) => option.value === value);

const normalizePositiveInteger = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const normalizeOptionalText = (value: string | null | undefined): string =>
  typeof value === 'string' ? value.trim() : '';

const normalizePageNumber = (value: string | null): number => {
  const normalized = normalizeOptionalText(value);
  if (!/^[1-9]\d*$/.test(normalized)) return 1;
  return Number.parseInt(normalized, 10);
};

const normalizeAdminContentTagFilter = (value: string | null): string => {
  const key = toTagKey(normalizeOptionalText(value));
  return isRoutableTagKey(key) ? key : '';
};

const orderByNullableDateDesc = (left: Date | null, right: Date | null): number => {
  if (left && right) return right.valueOf() - left.valueOf();
  if (left) return -1;
  if (right) return 1;
  return 0;
};

const buildYearOptions = (items: readonly AdminContentIndexItem[]): AdminContentFilterOption[] => {
  const counts = new Map<number, number>();
  for (const item of items) {
    if (item.year === null) continue;
    counts.set(item.year, (counts.get(item.year) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[0] - left[0])
    .map(([value, count]) => ({
      value: String(value),
      label: String(value),
      count
    }));
};

const getContentCollectionTotalCount = (collectionCounts: AdminContentSourceCountMap): number =>
  ADMIN_CONTENT_COLLECTIONS.reduce((total, collection) => total + collectionCounts[collection], 0);

const buildCollectionOptions = (collectionCounts: AdminContentSourceCountMap): AdminContentScopeOption[] => {
  const totalCount = getContentCollectionTotalCount(collectionCounts);
  return ADMIN_CONTENT_SCOPE_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    count: option.value === 'all'
      ? totalCount
      : collectionCounts[option.value]
  }));
};

type LoadContentIndexItemsOptions = {
  includeSearchText: boolean;
};

const withCollectionLabel = (item: AdminContentSourceIndexItem): AdminContentIndexItem => ({
  ...item,
  collectionLabel: getCollectionLabel(item.collection)
});

const loadCollectionItems = async (
  manifest: AdminContentSourceManifest,
  collection: AdminContentCollectionKey,
  includeSearchText: boolean
): Promise<AdminContentIndexItem[]> => {
  const items = includeSearchText
    ? await loadAdminContentSourceIndexWithBody(manifest, collection)
    : await loadAdminContentSourceIndex(manifest, collection);
  return items.map(withCollectionLabel);
};

const loadContentIndexItems = async (
  manifest: AdminContentSourceManifest,
  collections: readonly AdminContentCollectionKey[],
  options: LoadContentIndexItemsOptions
): Promise<AdminContentIndexItem[]> => {
  const collectionItems = await Promise.all(
    collections.map((collection) => loadCollectionItems(manifest, collection, options.includeSearchText))
  );
  return collectionItems.flat();
};

const getAdminContentScopeLabel = (collection: AdminContentScopeKey): string =>
  collection === 'all' ? '全部内容' : getCollectionLabel(collection);

const getAdminContentVisibleCollections = (collection: AdminContentScopeKey): readonly AdminContentCollectionKey[] =>
  collection === 'all' ? ADMIN_CONTENT_COLLECTIONS : [collection];

const orderAdminContentItemsByRecent = (items: readonly AdminContentIndexItem[]): AdminContentIndexItem[] =>
  items.slice().sort((left, right) => {
    const dateOrder = orderByNullableDateDesc(left.date, right.date);
    if (dateOrder !== 0) return dateOrder;
    const collectionOrder = (COLLECTION_ORDER.get(left.collection) ?? 0) - (COLLECTION_ORDER.get(right.collection) ?? 0);
    if (collectionOrder !== 0) return collectionOrder;
    return left.id.localeCompare(right.id, 'en');
  });

export const getAdminContentFilterState = (searchParams: URLSearchParams): AdminContentFilterState => {
  const collectionValue = normalizeOptionalText(searchParams.get('collection'));
  const collection: AdminContentScopeKey = isAdminContentScopeKey(collectionValue) ? collectionValue : 'all';
  const query = normalizeOptionalText(searchParams.get('q'));
  const queryTokens = tokenizeSearchQuery(query);
  const entryId = normalizeOptionalText(searchParams.get('entryId'));
  const page = normalizePageNumber(searchParams.get('page'));

  if (collection === 'all') {
    // 全部内容只支持 q 元信息搜索；状态、标签、年份、排序和分页属于具体 collection scope。
    return {
      collection,
      query,
      queryTokens,
      draft: 'all',
      tag: '',
      year: null,
      sort: 'recent',
      entryId: '',
      page: 1
    };
  }

  if (entryId) {
    // entryId 是源文件精确定位模式，优先于筛选和搜索，避免公开 slug 与源文件身份混用。
    return {
      collection,
      query: '',
      queryTokens: [],
      draft: 'all',
      tag: '',
      year: null,
      sort: 'recent',
      entryId,
      page: 1
    };
  }

  if (!shouldUseArticleFilters(collection)) {
    return {
      collection,
      query,
      queryTokens: tokenizeSearchQuery(query),
      draft: 'all',
      tag: '',
      year: null,
      sort: 'recent',
      entryId: '',
      page: 1
    };
  }

  const draftValue = normalizeOptionalText(searchParams.get('draft'));
  const sortValue = normalizeOptionalText(searchParams.get('sort'));
  const year = normalizePositiveInteger(searchParams.get('year'));

  return {
    collection,
    query,
    queryTokens: tokenizeSearchQuery(query),
    draft: isAdminContentDraftFilter(draftValue) ? draftValue : 'all',
    visibility: collection === 'essay' && searchParams.get('visibility') === 'private'
      ? 'private'
      : collection === 'essay' && searchParams.get('visibility') === 'public' ? 'public' : 'all',
    tag: normalizeAdminContentTagFilter(searchParams.get('tag')),
    year,
    sort: isAdminContentSortKey(sortValue) ? sortValue : 'recent',
    entryId: '',
    page
  };
};

export const filterAdminContentItems = (
  items: readonly AdminContentIndexItem[],
  filterState: AdminContentFilterState
): AdminContentIndexItem[] => {
  if (filterState.entryId) {
    return items.filter((item) => item.collection === filterState.collection && item.id === filterState.entryId);
  }

  const tagKey = normalizeAdminContentTagFilter(filterState.tag);
  const queryTokens = filterState.queryTokens;

  const filteredItems = items.filter((item) => {
    if (filterState.collection !== 'all' && item.collection !== filterState.collection) return false;
    if (filterState.collection === 'essay' && filterState.visibility && filterState.visibility !== 'all'
      && (item.visibility ?? 'public') !== filterState.visibility) return false;
    const articleFilters = getAdminContentCollectionCapability(item.collection).articleFilters;
    if (articleFilters && filterState.draft === 'draft' && !item.isDraft) return false;
    if (articleFilters && filterState.draft === 'published' && item.isDraft) return false;
    if (articleFilters && tagKey && !getTagKeys(item.tags).includes(tagKey)) return false;
    if (articleFilters && filterState.year !== null && item.year !== filterState.year) return false;
    if (queryTokens.length > 0 && !queryTokens.every((token) => item.searchHaystack.includes(token))) return false;
    return true;
  });

  if (filterState.sort === 'title') {
    return filteredItems.slice().sort((left, right) => {
      const titleOrder = left.title.localeCompare(right.title, 'zh-Hans-CN');
      if (titleOrder !== 0) return titleOrder;
      return left.id.localeCompare(right.id, 'en');
    });
  }

  return orderAdminContentItemsByRecent(filteredItems);
};

export const getAdminContentFilterHref = (
  filterState: Pick<AdminContentFilterState, 'collection' | 'query' | 'draft' | 'sort' | 'year' | 'visibility'>,
  updates: AdminContentFilterHrefUpdates = {},
  contentHref = '/admin/content/'
): string => {
  const nextCollection = updates.collection ?? filterState.collection;
  const params = new URLSearchParams();
  if (filterState.query) params.set('q', filterState.query);

  if (nextCollection !== 'all') {
    const nextCapability = getAdminContentCollectionCapability(nextCollection);
    const nextDraft = updates.draft ?? filterState.draft;
    const nextSort = updates.sort ?? filterState.sort;
    const nextYear = updates.year !== undefined ? updates.year : filterState.year;

    params.set('collection', nextCollection);
    const visibility = updates.visibility ?? filterState.visibility ?? 'all';
    if (nextCollection === 'essay' && visibility !== 'all') params.set('visibility', visibility);
    if (nextCapability.articleFilters) {
      if (nextDraft !== 'all') params.set('draft', nextDraft);
      if (nextSort !== 'recent') params.set('sort', nextSort);
      if (nextYear !== null && nextYear !== '') params.set('year', String(nextYear));
    }
  }

  const queryString = params.toString();
  return queryString ? `${contentHref}?${queryString}` : contentHref;
};

const buildAdminContentCollectionSections = (
  collectionCounts: AdminContentSourceCountMap,
  filteredItems: readonly AdminContentIndexItem[],
  collection: AdminContentScopeKey,
  options: { limit?: number; startIndex?: number; endIndex?: number } = {}
): AdminContentCollectionSection[] => {
  const visibleCollections = getAdminContentVisibleCollections(collection);

  return visibleCollections.map((sectionCollection) => {
    const sectionItems = filteredItems.filter((item) => item.collection === sectionCollection);
    const visibleItems = options.startIndex !== undefined && options.endIndex !== undefined
      ? sectionItems.slice(options.startIndex, options.endIndex)
      : options.limit !== undefined
        ? sectionItems.slice(0, options.limit)
        : sectionItems;
    const totalCount = collectionCounts[sectionCollection];

    return {
      collection: sectionCollection,
      collectionLabel: getCollectionLabel(sectionCollection),
      totalCount,
      filteredCount: sectionItems.length,
      items: visibleItems
    };
  });
};

const getAdminContentConsoleMode = (filterState: AdminContentFilterState): AdminContentConsoleMode => {
  if (filterState.entryId) return 'entry';
  if (filterState.collection === 'all') {
    return filterState.queryTokens.length > 0 ? 'search' : 'overview';
  }
  return 'collection';
};

const buildAdminContentPagination = (
  totalItems: number,
  requestedPage: number,
  pageSize: number
): { pagination: AdminContentPagination; startIndex: number; endIndex: number } => {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(Math.max(requestedPage, 1), totalPages);
  const startIndex = (page - 1) * pageSize;

  return {
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages
    },
    startIndex,
    endIndex: startIndex + pageSize
  };
};

export const getAdminContentConsolePageData = async (
  searchParams: URLSearchParams
): Promise<AdminContentConsolePageData> => {
  const filterState = getAdminContentFilterState(searchParams);
  const mode = getAdminContentConsoleMode(filterState);
  const visibleCollections = getAdminContentVisibleCollections(filterState.collection);
  // 正文派生文本成本较高，只在单 collection 搜索时加载；全部内容搜索仅匹配元信息。
  const includeSearchText = mode === 'collection'
    && filterState.queryTokens.length > 0
    && filterState.collection !== 'all'
    && getAdminContentCollectionCapability(filterState.collection).bodySearch;
  const manifest = await loadAdminContentSourceManifest();
  const collectionCounts = getAdminContentSourceCounts(manifest);
  const items = await loadContentIndexItems(manifest, visibleCollections, { includeSearchText });
  const filteredItems = filterAdminContentItems(items, filterState);
  // 分页在数据层完成，页面模板只渲染已经截断后的 sections，避免再出现视图层 slice。
  const shouldPaginate = filterState.collection !== 'all'
    && getAdminContentCollectionCapability(filterState.collection).pagination;
  const pageWindow = mode === 'collection' && shouldPaginate
    ? buildAdminContentPagination(filteredItems.length, filterState.page, ADMIN_CONTENT_COLLECTION_PAGE_SIZE)
    : null;
  const sections = buildAdminContentCollectionSections(
    collectionCounts,
    filteredItems,
    filterState.collection,
    mode === 'overview'
      ? { limit: ADMIN_CONTENT_OVERVIEW_SECTION_LIMIT }
      : pageWindow
        ? { startIndex: pageWindow.startIndex, endIndex: pageWindow.endIndex }
        : {}
  );

  return {
    mode,
    collection: filterState.collection,
    collectionLabel: getAdminContentScopeLabel(filterState.collection),
    totalCount: getContentCollectionTotalCount(collectionCounts),
    filteredCount: filteredItems.length,
    sections,
    collectionOptions: buildCollectionOptions(collectionCounts),
    yearOptions: buildYearOptions(items),
    filterState,
    pagination: pageWindow?.pagination ?? null,
    hasActiveFilters:
      mode !== 'overview'
      || filterState.query.length > 0
      || filterState.draft !== 'all'
      || (filterState.visibility !== undefined && filterState.visibility !== 'all')
      || filterState.tag.length > 0
      || filterState.year !== null
      || filterState.sort !== 'recent'
      || filterState.entryId.length > 0
  };
};

export const getAdminContentPublicFallbackLabel = (item: AdminContentIndexItem): string => {
  if (item.isDraft) {
    return 'draft 条目默认不暴露公开页';
  }

  if (item.collection === 'memo') {
    return 'memo 当前使用固定公开路由 /memo/';
  }

  if (item.collection === 'about') {
    return 'about 当前使用固定公开路由 /about/';
  }

  if (item.collection === 'bits') {
    const anchorId = getBitAnchorId(item.slug ?? item.id);
    return `公开定位依赖 /bits/ 分页与锚点（${anchorId}）`;
  }

  return '当前条目未生成公开页链接';
};
