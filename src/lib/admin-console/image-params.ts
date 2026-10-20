import {
  ADMIN_IMAGE_DEFAULT_LIST_LIMIT,
  isAdminImageOrigin,
  isAdminImageScopeKey,
  type AdminImageOrigin,
  type AdminImageScopeKey
} from './image-contract';
import {
  normalizeAdminImageBrowseGroup,
  normalizeAdminImageBrowseSubgroup
} from './image-browse';
import {
  normalizeBitsAvatarPath,
  normalizeHeroImageSrc,
  toSafeHttpUrl
} from '../../utils/format';
import {
  normalizeBitsImageSource,
  normalizeBitsLocalImageSource
} from '../bits-image-source';

export type AdminImageFieldContext =
  | 'bits.images'
  | 'home.heroImageSrc'
  | 'page.bits.defaultAuthor.avatar';

export type AdminImageDirectory =
  | ''
  | 'public'
  | 'public/author'
  | 'public/bits'
  | 'public/images'
  | 'src/assets'
  | 'src/content';

export type AdminImageDirectoryOption = {
  value: AdminImageDirectory;
  label: string;
  description: string;
};

export type AdminImageListRequest = {
  field: AdminImageFieldContext | null;
  directory: AdminImageDirectory;
  owner: string;
  origin: AdminImageOrigin | '';
  scope: AdminImageScopeKey | '';
  group: string;
  subgroup: string;
  query: string;
  page: number;
  limit: number;
};

export type AdminImageMetaInput =
  | {
      field: AdminImageFieldContext;
      value: string;
      path?: string;
    }
  | {
      path: string;
      field?: AdminImageFieldContext;
      value?: string;
    };

type AdminImageFieldConfig = {
  allowedOrigins: readonly AdminImageOrigin[];
  preferredPrefixes: readonly string[];
  toValue: (assetPath: string, origin: AdminImageOrigin) => string | null;
};

const IMAGE_LOCAL_EXT_RE = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

const FIELD_CONFIG: Record<AdminImageFieldContext, AdminImageFieldConfig> = {
  'bits.images': {
    allowedOrigins: ['public'],
    preferredPrefixes: ['public/bits/', 'public/images/', 'public/author/', 'public/'],
    toValue: (assetPath, origin) => (origin === 'public' ? assetPath.slice('public/'.length) : null)
  },
  'home.heroImageSrc': {
    allowedOrigins: ['src/assets', 'public'],
    preferredPrefixes: ['src/assets/', 'public/images/', 'public/'],
    toValue: (assetPath, origin) => {
      if (origin === 'src/assets') return assetPath;
      if (origin === 'public') return `/${assetPath.slice('public/'.length)}`;
      return null;
    }
  },
  'page.bits.defaultAuthor.avatar': {
    allowedOrigins: ['public'],
    preferredPrefixes: ['public/author/', 'public/bits/', 'public/images/', 'public/'],
    toValue: (assetPath, origin) => (origin === 'public' ? assetPath.slice('public/'.length) : null)
  }
};

const ADMIN_IMAGE_FIELD_CONTEXTS = Object.freeze(Object.keys(FIELD_CONFIG) as AdminImageFieldContext[]);
const ADMIN_IMAGE_ALL_ORIGINS = ['public', 'src/assets', 'src/content'] as const satisfies readonly AdminImageOrigin[];

export const ADMIN_IMAGE_DIRECTORY_OPTIONS = [
  {
    value: '',
    label: '全部资源',
    description: '查看站点里可用的本地图片。'
  },
  {
    value: 'public/author',
    label: '头像资源',
    description: '查看作者头像和默认头像图片。'
  },
  {
    value: 'public/bits',
    label: '絮语配图',
    description: '查看絮语常用的公开配图。'
  },
  {
    value: 'public/images',
    label: '页面插图',
    description: '查看首页和普通页面使用的插图。'
  },
  {
    value: 'public',
    label: '公开图片',
    description: '查看 public 下的全部公开图片。'
  },
  {
    value: 'src/assets',
    label: '站点素材',
    description: '查看站点主题和首页使用的本地素材。'
  },
  {
    value: 'src/content',
    label: '文章附件',
    description: '查看文章或笔记同目录下的图片附件。'
  }
] as const satisfies readonly AdminImageDirectoryOption[];

export class AdminImageError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AdminImageError';
    this.status = status;
  }
}

const normalizePositiveInteger = (
  value: string | null,
  { fallback, min = 1, max = Number.MAX_SAFE_INTEGER }: { fallback: number; min?: number; max?: number }
): number => {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const normalizeSearchQuery = (value: string | null): string => (value ?? '').trim().toLowerCase();

export const normalizeAdminImageOwnerValue = (value: string | null | undefined): string =>
  (value ?? '').trim().replace(/\\/g, '/');

export const isAdminImageFieldContext = (value: string): value is AdminImageFieldContext =>
  value in FIELD_CONFIG;

export const isAdminImageDirectory = (value: string): value is AdminImageDirectory =>
  ADMIN_IMAGE_DIRECTORY_OPTIONS.some((option) => option.value === value);

export const normalizeAdminImageDirectory = (value: string | null | undefined): AdminImageDirectory => {
  const normalized = (value ?? '').trim().replace(/\\/g, '/');
  return isAdminImageDirectory(normalized) ? normalized : '';
};

export const getAdminImageFieldValue = (
  field: AdminImageFieldContext | null,
  assetPath: string,
  origin: AdminImageOrigin
): string | null => {
  if (!field) return assetPath;
  const config = FIELD_CONFIG[field];
  if (!config.allowedOrigins.includes(origin)) return null;
  return config.toValue(assetPath, origin);
};

export const getAdminImageFieldAllowedOrigins = (
  field: AdminImageFieldContext | null
): readonly AdminImageOrigin[] => (field ? FIELD_CONFIG[field].allowedOrigins : ADMIN_IMAGE_ALL_ORIGINS);

export const getAdminImageFieldSortRank = (
  field: AdminImageFieldContext | null,
  assetPath: string
): number => {
  if (!field) return 999;
  const prefixes = FIELD_CONFIG[field].preferredPrefixes;
  const index = prefixes.findIndex((prefix) => assetPath.startsWith(prefix));
  return index === -1 ? prefixes.length : index;
};

export const getAdminImageCompatibleFieldValues = (
  assetPath: string,
  origin: AdminImageOrigin
): string[] =>
  Array.from(
    new Set(
      ADMIN_IMAGE_FIELD_CONTEXTS
        .map((field) => getAdminImageFieldValue(field, assetPath, origin))
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  );

export const normalizeAdminLocalImageSource = normalizeBitsLocalImageSource;

export const normalizeAdminBitsImageSource = normalizeBitsImageSource;

const withAdminPreviewBase = (base: string, path: string): string => {
  const normalizedBase = base.trim().replace(/\/+$/, '');
  const basePath = normalizedBase && normalizedBase !== '/' ? `/${normalizedBase.replace(/^\/+/, '')}` : '';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (!basePath || normalizedPath === basePath || normalizedPath.startsWith(`${basePath}/`)) {
    return normalizedPath;
  }
  return `${basePath}${normalizedPath}`;
};

const normalizeRenderedLocalImagePreviewPath = (value: string, base: string): { path: string; search: string } | null => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (
    !normalized
    || !normalized.startsWith('/')
    || normalized.startsWith('//')
    || normalized.includes('#')
  ) {
    return null;
  }

  const searchIndex = normalized.indexOf('?');
  const pathPart = searchIndex === -1 ? normalized : normalized.slice(0, searchIndex);
  const search = searchIndex === -1 ? '' : normalized.slice(searchIndex);
  if (!pathPart || /(^|\/)\.\.(?:\/|$)/.test(pathPart)) return null;

  // Astro's trailingSlash setting also applies to this development-only image endpoint.
  // Keep the exception limited to generated avatar previews, including a configured site base.
  const avatarPreviewPrefix = '/api/admin/site-assets/avatar-preview/';
  const isAvatarPreview = [avatarPreviewPrefix, withAdminPreviewBase(base, avatarPreviewPrefix)]
    .some((prefix) => pathPart.startsWith(prefix)
      && /^avatar-[0-9a-f]{64}\.(?:png|jpg|webp|avif|gif)\/$/.test(pathPart.slice(prefix.length)));
  return IMAGE_LOCAL_EXT_RE.test(pathPart) || isAvatarPreview ? { path: pathPart, search } : null;
};

export const getAdminRenderedImagePreviewSrc = (value: string, base = '/'): string | null => {
  const safeRemoteUrl = toSafeHttpUrl(value);
  if (safeRemoteUrl.startsWith('https://')) return safeRemoteUrl;

  const localPath = normalizeRenderedLocalImagePreviewPath(value, base);
  return localPath ? `${withAdminPreviewBase(base, localPath.path)}${localPath.search}` : null;
};

export const getAdminImageFieldPreviewSrc = (
  field: AdminImageFieldContext,
  value: string,
  base = '/'
): string | null => {
  if (field === 'bits.images') {
    const normalized = normalizeAdminBitsImageSource(value);
    if (!normalized) return null;
    return normalized.startsWith('https://') ? normalized : withAdminPreviewBase(base, normalized);
  }

  if (field === 'page.bits.defaultAuthor.avatar') {
    const normalized = normalizeBitsAvatarPath(value);
    return normalized ? withAdminPreviewBase(base, normalized) : null;
  }

  const normalized = normalizeHeroImageSrc(value);
  if (!normalized) return null;
  if (normalized.startsWith('https://')) return normalized;
  if (normalized.startsWith('src/assets/')) return null;
  return withAdminPreviewBase(base, normalized);
};

export const getAdminImageListRequest = (searchParams: URLSearchParams): AdminImageListRequest => {
  const rawField = (searchParams.get('field') ?? '').trim();
  const field = isAdminImageFieldContext(rawField) ? rawField : null;
  const rawOrigin = (searchParams.get('origin') ?? '').trim();
  const origin = isAdminImageOrigin(rawOrigin) && getAdminImageFieldAllowedOrigins(field).includes(rawOrigin)
    ? rawOrigin
    : '';
  const rawScope = (searchParams.get('scope') ?? '').trim().toLowerCase();
  const scope = !field && isAdminImageScopeKey(rawScope) ? rawScope : '';

  return {
    field,
    directory: normalizeAdminImageDirectory(searchParams.get('dir')),
    owner: normalizeAdminImageOwnerValue(searchParams.get('owner')),
    origin,
    scope,
    group: normalizeAdminImageBrowseGroup(searchParams.get('group')),
    subgroup: normalizeAdminImageBrowseSubgroup(searchParams.get('sub')),
    query: normalizeSearchQuery(searchParams.get('q')),
    page: normalizePositiveInteger(searchParams.get('page'), { fallback: 1 }),
    limit: normalizePositiveInteger(searchParams.get('limit'), {
      fallback: ADMIN_IMAGE_DEFAULT_LIST_LIMIT,
      max: 60
    })
  };
};

export const getAdminImageMetaRequest = (searchParams: URLSearchParams): AdminImageMetaInput => {
  const rawPath = (searchParams.get('path') ?? '').trim();
  if (rawPath) {
    return { path: rawPath };
  }

  const rawField = (searchParams.get('field') ?? '').trim();
  if (!isAdminImageFieldContext(rawField)) {
    throw new AdminImageError('field 参数非法，无法读取图片元数据');
  }

  return {
    field: rawField,
    value: (searchParams.get('value') ?? '').trim()
  };
};
