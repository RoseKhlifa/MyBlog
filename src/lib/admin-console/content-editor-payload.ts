import { parseEssayDateInput } from '../../utils/date-only';
import {
  buildAdminAboutEditorPayload,
  type AdminAboutEditorPayload,
  type AdminAboutEditorValues
} from './content-about-contract';
import {
  getAdminContentCollectionCapability,
  type AdminContentEntryWriteCollectionKey
} from './content-collections';
import {
  AdminContentEntryResolutionError,
  getAdminContentReadOnlyReason,
  loadAdminContentSourceState,
  type AdminContentSourceState
} from './content-entry-source';
import { isRecord, normalizeOptionalText } from './content-entry-utils';

export type AdminEssayEditorValues = {
  title: string;
  description: string;
  date: string;
  publishedAt: string;
  updatedAt: string;
  tagsText: string;
  draft: boolean;
  /** Older editor clients may omit this field; API responses always include it. */
  visibility?: 'public' | 'private';
  archive: boolean;
  slug: string;
  cover: string;
  badge: string;
};

export type AdminBitsEditorValues = {
  title: string;
  description: string;
  date: string;
  tagsText: string;
  draft: boolean;
  authorName: string;
  authorAvatar: string;
  imagesText: string;
};

export type AdminMemoEditorValues = {
  title: string;
  subtitle: string;
  date: string;
  draft: boolean;
  slug: string;
};

export type AdminContentEditorValues =
  | AdminEssayEditorValues
  | AdminBitsEditorValues
  | AdminMemoEditorValues
  | AdminAboutEditorValues;

export type AdminContentWorkspaceEditorValues =
  | AdminEssayEditorValues
  | AdminBitsEditorValues
  | AdminMemoEditorValues
  | AdminAboutEditorValues;

export type AdminEssayEditorPayload = {
  collection: 'essay';
  entryId: string;
  publicEntryId: string;
  defaultPublicSlug: string;
  revision: string;
  relativePath: string;
  writable: true;
  readonlyReason: null;
  bodyText: string;
  values: AdminEssayEditorValues;
};

export type AdminBitsEditorPayload = {
  collection: 'bits';
  entryId: string;
  publicEntryId: string;
  defaultPublicSlug: string;
  revision: string;
  relativePath: string;
  writable: true;
  readonlyReason: null;
  bodyText: string;
  values: AdminBitsEditorValues;
};

export type AdminMemoEditorPayload = {
  collection: 'memo';
  entryId: string;
  publicEntryId: string;
  defaultPublicSlug: string;
  revision: string;
  relativePath: string;
  writable: true;
  readonlyReason: null;
  bodyText: string;
  values: AdminMemoEditorValues;
};

export type AdminContentEditorPayload =
  | AdminEssayEditorPayload
  | AdminBitsEditorPayload
  | AdminMemoEditorPayload
  | AdminAboutEditorPayload;

export type AdminContentWorkspaceEditorPayload =
  | AdminEssayEditorPayload
  | AdminBitsEditorPayload
  | AdminMemoEditorPayload
  | AdminAboutEditorPayload;

const getStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
    : [];

const getDateString = (frontmatter: Record<string, unknown>, key: string, fallback: string): string => {
  const value = frontmatter[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
};

const getEssayDateText = (value: unknown): string => {
  const parsed = parseEssayDateInput(value);
  return parsed?.dateText ?? normalizeOptionalText(value);
};

const toEssayEditorValues = (state: AdminContentSourceState): AdminEssayEditorValues => {
  const frontmatter = state.rawFrontmatter;
  const rawDate = getDateString(frontmatter, 'date', '');
  const rawPublishedAt = normalizeOptionalText(frontmatter.publishedAt);
  const dateResult = parseEssayDateInput(rawDate);

  return {
    title: normalizeOptionalText(frontmatter.title),
    description: normalizeOptionalText(frontmatter.description),
    date: dateResult?.dateText ?? rawDate,
    publishedAt: rawPublishedAt || dateResult?.publishedAtText || '',
    updatedAt: getEssayDateText(frontmatter.updatedAt),
    tagsText: getStringArray(frontmatter.tags).join('\n'),
    draft: frontmatter.draft === true,
    visibility: frontmatter.visibility === 'private' ? 'private' : 'public',
    archive: frontmatter.archive !== false,
    slug: normalizeOptionalText(frontmatter.slug),
    cover: normalizeOptionalText(frontmatter.cover),
    badge: normalizeOptionalText(frontmatter.badge)
  };
};

const toBitsEditorValues = (state: AdminContentSourceState): AdminBitsEditorValues => {
  const frontmatter = state.rawFrontmatter;
  const author = isRecord(frontmatter.author) ? frontmatter.author : null;

  return {
    title: normalizeOptionalText(frontmatter.title),
    description: normalizeOptionalText(frontmatter.description),
    date: getDateString(frontmatter, 'date', ''),
    tagsText: getStringArray(frontmatter.tags).join('\n'),
    draft: frontmatter.draft === true,
    authorName: normalizeOptionalText(author?.name),
    authorAvatar: normalizeOptionalText(author?.avatar),
    imagesText: Array.isArray(frontmatter.images) ? JSON.stringify(frontmatter.images, null, 2) : ''
  };
};

const toMemoEditorValues = (state: AdminContentSourceState): AdminMemoEditorValues => {
  const frontmatter = state.rawFrontmatter;
  return {
    title: normalizeOptionalText(frontmatter.title),
    subtitle: normalizeOptionalText(frontmatter.subtitle),
    date: normalizeOptionalText(frontmatter.date),
    draft: frontmatter.draft === true,
    slug: normalizeOptionalText(frontmatter.slug)
  };
};

export const buildAdminContentEntryEditorPayloadFromState = (
  state: AdminContentSourceState
): AdminContentEditorPayload => {
  const { collection } = state;
  if (collection === 'essay') {
    return {
      collection,
      entryId: state.entryId,
      publicEntryId: state.publicEntryId,
      defaultPublicSlug: state.defaultPublicSlug,
      revision: state.revision,
      relativePath: state.relativePath,
      writable: true,
      readonlyReason: null,
      bodyText: state.bodyText,
      values: toEssayEditorValues(state)
    };
  }

  if (collection === 'bits') {
    return {
      collection,
      entryId: state.entryId,
      publicEntryId: state.publicEntryId,
      defaultPublicSlug: state.defaultPublicSlug,
      revision: state.revision,
      relativePath: state.relativePath,
      writable: true,
      readonlyReason: null,
      bodyText: state.bodyText,
      values: toBitsEditorValues(state)
    };
  }

  if (collection === 'about') {
    return buildAdminAboutEditorPayload(state);
  }

  return {
    collection,
    entryId: state.entryId,
    publicEntryId: state.publicEntryId,
    defaultPublicSlug: state.defaultPublicSlug,
    revision: state.revision,
    relativePath: state.relativePath,
    writable: true,
    readonlyReason: null,
    bodyText: state.bodyText,
    values: toMemoEditorValues(state)
  };
};

export const readAdminContentEntryEditorPayload = async (
  collection: AdminContentEntryWriteCollectionKey,
  entryId: string
): Promise<AdminContentEditorPayload> => {
  if (!getAdminContentCollectionCapability(collection).entryWritable) {
    throw new AdminContentEntryResolutionError(
      'invalid-entry-id',
      getAdminContentReadOnlyReason(collection) ?? `当前 collection 暂不支持写盘：${collection}`
    );
  }

  return buildAdminContentEntryEditorPayloadFromState(await loadAdminContentSourceState(collection, entryId));
};
