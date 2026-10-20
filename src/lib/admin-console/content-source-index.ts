import { readFile, stat } from 'node:fs/promises';
import { PAGE_SIZE_BITS } from '../../../site.config.mjs';
import { deriveMarkdownText, truncateText } from '../../utils/excerpt';
import {
  buildSearchHaystack,
  formatDateTime,
  formatISODate,
  formatISODateUtc
} from '../../utils/format';
import { parseEssayDateInput } from '../../utils/date-only';
import {
  contentSourceEntryIdToPublicEntryId,
  flattenEntryIdToSlug
} from '../../utils/slug-rules';
import {
  buildPublishedBitsHrefMap,
  type BitPublicOrderItem
} from '../bits-public-routing';
import {
  ADMIN_CONTENT_COLLECTIONS,
  type AdminContentCollectionKey
} from './content-routes';
import {
  getAdminContentReadOnlyReason,
  listAdminCollectionSourceFiles,
  readAdminSourceFrontmatterRecord,
  resolveAdminContentEntryIdFromSourcePath,
  toAdminContentRelativeProjectPath
} from './content-entry-source';
import {
  parseMarkdownFrontmatterDocument,
  splitMarkdownFrontmatter
} from './frontmatter';

// Admin Content 列表跟随 src/content.config.ts 当前 glob 边界：仅索引 .md。
const ADMIN_CONTENT_SOURCE_INDEX_EXT_RE = /\.md$/i;
// 故意不与公开模块共享：Admin 与公开搜索语义未来可能分化。
const MAX_SEARCH_INDEX_TEXT = 600;
const ESSAY_EXCERPT_LIMIT = 120;
const BITS_EXCERPT_LIMIT = 180;
const UNTITLED_VALUE = '(未设置)';
const SOURCE_ERROR_DATE_LABEL = '源文件异常';

export type AdminContentSourceManifest = Record<AdminContentCollectionKey, string[]>;
export type AdminContentSourceCountMap = Record<AdminContentCollectionKey, number>;

export type AdminContentSourceBodyDerived = {
  plainText: string;
  excerpt: string;
  text: string;
};

export type AdminContentSourceIndexItem = {
  collection: AdminContentCollectionKey;
  id: string;
  publicEntryId: string;
  title: string;
  slug: string | null;
  relativePath: string;
  publicHref: string | null;
  isDraft: boolean;
  visibility?: 'public' | 'private';
  archive: boolean | null;
  date: Date | null;
  dateLabel: string;
  year: number | null;
  tags: string[];
  searchHaystack: string;
  readonlyReason: string | null;
  sourceError: string | null;
};

export type AdminContentSourceIndexItemWithBody = AdminContentSourceIndexItem & {
  bodyText: string;
  bodyDerived: AdminContentSourceBodyDerived;
};

type SourceRecord = {
  collection: AdminContentCollectionKey;
  sourcePath: string;
  relativePath: string;
  entryId: string;
  publicEntryId: string;
  frontmatter: Record<string, unknown>;
  sourceModifiedAt: Date | null;
  sourceError: string | null;
  bodyText?: string;
  bodyDerived?: AdminContentSourceBodyDerived;
};

type FrontmatterAdapterContext = {
  publicHrefByBitsId: ReadonlyMap<string, string>;
};

type FrontmatterAdapter = (
  record: SourceRecord,
  context: FrontmatterAdapterContext
) => AdminContentSourceIndexItem;

type SourceDateMeta = {
  label: string;
  year: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeOptionalText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const normalizeFieldValue = (value: unknown, fallback = UNTITLED_VALUE): string => {
  const normalized = normalizeOptionalText(value);
  return normalized || fallback;
};

const getStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
    : [];

const parseDateTimeInput = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isFinite(value.valueOf()) ? new Date(value.valueOf()) : null;
  }

  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date : null;
};

const getUnsetSourceDateMeta = (): SourceDateMeta => ({
  label: '未设置日期',
  year: null
});

const getEssaySourceDateMeta = (date: Date | null): SourceDateMeta =>
  date
    ? {
      label: formatISODateUtc(date),
      year: date.getUTCFullYear()
    }
    : getUnsetSourceDateMeta();

const getBitsSourceDateMeta = (date: Date | null): SourceDateMeta =>
  date
    ? {
      label: formatDateTime(date),
      year: date.getFullYear()
    }
    : getUnsetSourceDateMeta();

const getMemoSourceDateMeta = (date: Date | null): SourceDateMeta =>
  date
    ? {
      label: formatISODate(date),
      year: date.getFullYear()
    }
    : getUnsetSourceDateMeta();

const getFileSourceDateMeta = (date: Date | null): SourceDateMeta =>
  date
    ? {
      label: formatISODate(date),
      year: date.getFullYear()
    }
    : getUnsetSourceDateMeta();

const resolvePublicEntryId = (entryId: string): string =>
  contentSourceEntryIdToPublicEntryId(entryId) || entryId;

const resolveSourceRecordIdentity = (
  collection: AdminContentCollectionKey,
  sourcePath: string
) => {
  const relativePath = toAdminContentRelativeProjectPath(sourcePath);
  const entryId = resolveAdminContentEntryIdFromSourcePath(collection, relativePath);
  const publicEntryId = resolvePublicEntryId(entryId);
  return {
    relativePath,
    entryId,
    publicEntryId
  };
};

const getSearchIndexText = (plainText: string): string =>
  plainText.length > MAX_SEARCH_INDEX_TEXT ? plainText.slice(0, MAX_SEARCH_INDEX_TEXT) : plainText;

const buildBodyDerived = (bodyText: string, excerptLimit: number): AdminContentSourceBodyDerived => {
  const { plainText, excerptText } = deriveMarkdownText(bodyText);
  return {
    plainText,
    excerpt: truncateText(excerptText, excerptLimit),
    text: getSearchIndexText(plainText)
  };
};

const getBodyExcerptLimit = (collection: AdminContentCollectionKey): number =>
  collection === 'bits' ? BITS_EXCERPT_LIMIT : ESSAY_EXCERPT_LIMIT;

const mergeSourceError = (...messages: Array<string | null | undefined>): string | null => {
  const normalized = messages
    .map((message) => normalizeOptionalText(message))
    .filter(Boolean);
  return normalized.length > 0 ? normalized.join('；') : null;
};

const getSourceRecordErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : 'unknown error';
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';

  return ['ENOENT', 'EACCES', 'EPERM'].includes(code)
    ? `源文件读取失败：${message}`
    : `frontmatter 解析失败：${message}`;
};

const getBodyDerived = (record: SourceRecord): AdminContentSourceBodyDerived | null =>
  record.bodyDerived ?? null;

const createBaseItem = (
  record: SourceRecord,
  values: Omit<AdminContentSourceIndexItem, 'collection' | 'id' | 'publicEntryId' | 'relativePath' | 'readonlyReason'>
): AdminContentSourceIndexItem => ({
  collection: record.collection,
  id: record.entryId,
  publicEntryId: record.publicEntryId,
  relativePath: record.relativePath,
  readonlyReason: getAdminContentReadOnlyReason(record.collection),
  visibility: 'public',
  ...values
});

const createEssaySourceIndexItem: FrontmatterAdapter = (record) => {
  const frontmatter = record.frontmatter;
  const hasSourceError = record.sourceError !== null;
  const title = normalizeFieldValue(frontmatter.title, record.entryId);
  const dateResult = parseEssayDateInput(frontmatter.date);
  const date = dateResult?.date ?? null;
  const { label, year } = getEssaySourceDateMeta(date);
  const tags = getStringArray(frontmatter.tags);
  const explicitSlug = normalizeOptionalText(frontmatter.slug);
  const slug = explicitSlug || flattenEntryIdToSlug(record.publicEntryId);
  const bodyDerived = getBodyDerived(record);
  const sourceError = mergeSourceError(
    record.sourceError,
    !hasSourceError && !normalizeOptionalText(frontmatter.title) ? 'essay.title 缺失或不是字符串' : null,
    !hasSourceError && !dateResult ? 'essay.date 缺失或格式无效' : null,
    !hasSourceError && frontmatter.visibility !== undefined
      && frontmatter.visibility !== 'public' && frontmatter.visibility !== 'private'
      ? 'essay.visibility 必须是 public 或 private' : null
  );

  return createBaseItem(record, {
    title,
    slug,
    publicHref: frontmatter.draft === true || (frontmatter.visibility !== undefined && frontmatter.visibility !== 'public')
      ? null : `/archive/${slug}/`,
    isDraft: frontmatter.draft === true,
    visibility: frontmatter.visibility === 'private' ? 'private' : 'public',
    archive: frontmatter.archive !== false,
    date,
    dateLabel: hasSourceError ? SOURCE_ERROR_DATE_LABEL : label,
    year,
    tags,
    searchHaystack: buildSearchHaystack([
      title,
      record.entryId,
      record.publicEntryId,
      slug,
      normalizeOptionalText(frontmatter.description),
      tags,
      bodyDerived?.text,
      sourceError
    ]),
    sourceError
  });
};

const createBitsSourceIndexItem: FrontmatterAdapter = (record, context) => {
  const frontmatter = record.frontmatter;
  const hasSourceError = record.sourceError !== null;
  const bodyDerived = getBodyDerived(record);
  const fallbackTitle = bodyDerived
    ? truncateText(bodyDerived.excerpt || bodyDerived.plainText, 48) || record.entryId
    : record.entryId;
  const title = normalizeFieldValue(frontmatter.title, fallbackTitle);
  const date = parseDateTimeInput(frontmatter.date);
  const { label, year } = getBitsSourceDateMeta(date);
  const tags = getStringArray(frontmatter.tags);
  const slug = normalizeOptionalText(frontmatter.slug) || record.publicEntryId;
  const author = isRecord(frontmatter.author) ? frontmatter.author : null;
  const authorName = normalizeOptionalText(author?.name);
  const authorAvatar = normalizeOptionalText(author?.avatar);
  const sourceError = mergeSourceError(
    record.sourceError,
    !hasSourceError && !date ? 'bits.date 缺失或格式无效' : null
  );

  return createBaseItem(record, {
    title,
    slug,
    publicHref: frontmatter.draft === true ? null : context.publicHrefByBitsId.get(record.publicEntryId) ?? null,
    isDraft: frontmatter.draft === true,
    archive: null,
    date,
    dateLabel: hasSourceError ? SOURCE_ERROR_DATE_LABEL : label,
    year,
    tags,
    searchHaystack: buildSearchHaystack([
      title,
      record.entryId,
      record.publicEntryId,
      slug,
      normalizeOptionalText(frontmatter.description),
      tags,
      authorName,
      authorAvatar,
      bodyDerived?.text,
      sourceError
    ]),
    sourceError
  });
};

const createMemoSourceIndexItem: FrontmatterAdapter = (record) => {
  const frontmatter = record.frontmatter;
  const hasSourceError = record.sourceError !== null;
  const title = normalizeFieldValue(frontmatter.title, record.entryId);
  const date = parseDateTimeInput(frontmatter.date);
  const { label, year } = getMemoSourceDateMeta(date);
  const slug = normalizeOptionalText(frontmatter.slug) || null;
  const subtitle = normalizeOptionalText(frontmatter.subtitle);
  const bodyDerived = getBodyDerived(record);
  const sourceError = record.sourceError;

  return createBaseItem(record, {
    title,
    slug,
    publicHref: frontmatter.draft === true ? null : '/memo/',
    isDraft: frontmatter.draft === true,
    archive: null,
    date,
    dateLabel: hasSourceError ? SOURCE_ERROR_DATE_LABEL : label,
    year,
    tags: [],
    searchHaystack: buildSearchHaystack([
      title,
      record.entryId,
      record.publicEntryId,
      slug,
      subtitle,
      bodyDerived?.text,
      sourceError
    ]),
    sourceError
  });
};

const createAboutSourceIndexItem: FrontmatterAdapter = (record) => {
  const bodyDerived = getBodyDerived(record);
  const sourceError = record.sourceError;
  const { label } = getFileSourceDateMeta(record.sourceModifiedAt);
  const hasSourceError = record.sourceError !== null;

  return createBaseItem(record, {
    title: '关于',
    slug: 'about',
    publicHref: '/about/',
    isDraft: false,
    archive: null,
    date: null,
    dateLabel: hasSourceError ? SOURCE_ERROR_DATE_LABEL : label,
    year: null,
    tags: [],
    searchHaystack: buildSearchHaystack([
      '关于',
      record.entryId,
      record.publicEntryId,
      'about',
      bodyDerived?.text,
      sourceError
    ]),
    sourceError
  });
};

const FRONTMATTER_ADAPTERS: Record<AdminContentCollectionKey, FrontmatterAdapter> = {
  essay: createEssaySourceIndexItem,
  bits: createBitsSourceIndexItem,
  memo: createMemoSourceIndexItem,
  about: createAboutSourceIndexItem
};

// Manifest 排序不决定最终列表顺序，仅保证不同系统上的请求快照顺序稳定。
const orderSourceFiles = (files: readonly string[]): string[] =>
  files.slice().sort((left, right) =>
    toAdminContentRelativeProjectPath(left).localeCompare(toAdminContentRelativeProjectPath(right), 'en')
  );

const readSourceRecord = async (
  collection: AdminContentCollectionKey,
  sourcePath: string,
  includeBody: boolean
): Promise<SourceRecord> => {
  const identity = resolveSourceRecordIdentity(collection, sourcePath);
  let sourceModifiedAt: Date | null = null;

  try {
    if (collection === 'about') {
      const sourceStats = await stat(sourcePath);
      sourceModifiedAt = sourceStats.mtime;
    }

    if (!includeBody) {
      return {
        collection,
        sourcePath,
        ...identity,
        frontmatter: await readAdminSourceFrontmatterRecord(sourcePath),
        sourceModifiedAt,
        sourceError: null
      };
    }

    const sourceText = await readFile(sourcePath, 'utf8');
    const section = splitMarkdownFrontmatter(sourceText);
    const document = parseMarkdownFrontmatterDocument(section.frontmatterText);
    const rawFrontmatter = document.toJS();
    const bodyText = section.bodyText;

    return {
      collection,
      sourcePath,
      ...identity,
      frontmatter: isRecord(rawFrontmatter) ? rawFrontmatter : {},
      sourceModifiedAt,
      sourceError: null,
      bodyText,
      bodyDerived: buildBodyDerived(bodyText, getBodyExcerptLimit(collection))
    };
  } catch (error) {
    const bodyText = '';
    return {
      collection,
      sourcePath,
      ...identity,
      frontmatter: {},
      sourceModifiedAt,
      sourceError: getSourceRecordErrorMessage(error),
      ...(includeBody
        ? {
          bodyText,
          bodyDerived: buildBodyDerived(bodyText, getBodyExcerptLimit(collection))
        }
        : {})
    };
  }
};

const getManifestFiles = (
  manifest: AdminContentSourceManifest,
  collection: AdminContentCollectionKey
): string[] => manifest[collection] ?? [];

const buildBitsHrefMap = (records: readonly SourceRecord[]): Map<string, string> => {
  const routingItems: BitPublicOrderItem[] = [];

  for (const record of records) {
    const date = parseDateTimeInput(record.frontmatter.date);
    if (!date) continue;

    routingItems.push({
      id: record.publicEntryId,
      date,
      draft: record.frontmatter.draft === true
    });
  }

  return buildPublishedBitsHrefMap(routingItems, PAGE_SIZE_BITS);
};

const orderByNullableDateDesc = (left: Date | null, right: Date | null): number => {
  if (left && right) return right.valueOf() - left.valueOf();
  if (left) return -1;
  if (right) return 1;
  return 0;
};

const orderSourceIndexItemsByRecent = <T extends AdminContentSourceIndexItem>(items: readonly T[]): T[] =>
  items.slice().sort((left, right) => {
    const dateOrder = orderByNullableDateDesc(left.date, right.date);
    if (dateOrder !== 0) return dateOrder;
    return left.id.localeCompare(right.id, 'en');
  });

const loadSourceRecords = async (
  manifest: AdminContentSourceManifest,
  collection: AdminContentCollectionKey,
  includeBody: boolean
): Promise<SourceRecord[]> =>
  Promise.all(
    getManifestFiles(manifest, collection).map((sourcePath) =>
      readSourceRecord(collection, sourcePath, includeBody)
    )
  );

const createSourceIndexItems = (
  collection: AdminContentCollectionKey,
  records: readonly SourceRecord[]
): AdminContentSourceIndexItem[] => {
  const publicHrefByBitsId = collection === 'bits' ? buildBitsHrefMap(records) : new Map<string, string>();
  return orderSourceIndexItemsByRecent(
    records.map((record) =>
      FRONTMATTER_ADAPTERS[collection](record, {
        publicHrefByBitsId
      })
    )
  );
};

export const loadAdminContentSourceManifest = async (): Promise<AdminContentSourceManifest> => {
  const entries = await Promise.all(
    ADMIN_CONTENT_COLLECTIONS.map(async (collection) => {
      const files = (await listAdminCollectionSourceFiles(collection))
        .filter((filePath) => ADMIN_CONTENT_SOURCE_INDEX_EXT_RE.test(filePath));
      return [collection, orderSourceFiles(files)] as const;
    })
  );

  return Object.fromEntries(entries) as AdminContentSourceManifest;
};

export const getAdminContentSourceCounts = (
  manifest: AdminContentSourceManifest
): AdminContentSourceCountMap =>
  Object.fromEntries(
    ADMIN_CONTENT_COLLECTIONS.map((collection) => [
      collection,
      getManifestFiles(manifest, collection).length
    ])
  ) as AdminContentSourceCountMap;

export const loadAdminContentSourceIndex = async (
  manifest: AdminContentSourceManifest,
  collection: AdminContentCollectionKey
): Promise<AdminContentSourceIndexItem[]> => {
  const records = await loadSourceRecords(manifest, collection, false);
  return createSourceIndexItems(collection, records);
};

export const loadAdminContentSourceIndexWithBody = async (
  manifest: AdminContentSourceManifest,
  collection: AdminContentCollectionKey
): Promise<AdminContentSourceIndexItemWithBody[]> => {
  const records = await loadSourceRecords(manifest, collection, true);
  const items = createSourceIndexItems(collection, records);
  const recordByEntryId = new Map(records.map((record) => [record.entryId, record]));

  return items.map((item) => {
    const record = recordByEntryId.get(item.id);
    if (record?.bodyText === undefined || !record.bodyDerived) {
      throw new Error(`Missing body-augmented source record: ${item.collection}/${item.id}`);
    }

    return {
      ...item,
      bodyText: record.bodyText,
      bodyDerived: record.bodyDerived
    };
  });
};
