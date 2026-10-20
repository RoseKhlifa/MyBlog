const GENERATED_FAVICON_FILE_RE = /^(favicon|apple-touch-icon)-(\d+)x(\d+)-[0-9a-f]{8}\.png$/;
const PUBLIC_ICON_PREFIX = '/images/site/';

export const isAdminGeneratedFaviconFileName = (value: string): boolean => GENERATED_FAVICON_FILE_RE.exec(value)?.[0] === value;

/** Keep stored public paths unchanged; only editor previews use the authenticated live server. */
export const getAdminFaviconPreviewSrc = (value: string, base = '/'): string => {
  if (!value.startsWith(PUBLIC_ICON_PREFIX)) return value;
  const fileName = value.slice(PUBLIC_ICON_PREFIX.length);
  if (!isAdminGeneratedFaviconFileName(fileName)) return value;
  const basePath = base.endsWith('/') ? base : `${base}/`;
  return `${basePath}api/admin/site-assets/favicon-preview/${fileName}/`;
};

export type AdminFaviconUploadResult = { path: string; width: number; height: number };

/** Reject unexpected upload responses before they can overwrite a saved setting. */
export const parseAdminFaviconUploadResult = (
  payload: unknown,
  slot: 'png' | 'appleTouchIcon'
): AdminFaviconUploadResult | null => {
  if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true) return null;
  if (!('result' in payload) || !payload.result || typeof payload.result !== 'object') return null;
  const result = payload.result;
  if (!('path' in result) || typeof result.path !== 'string' || !result.path.startsWith(PUBLIC_ICON_PREFIX)) return null;
  const fileName = result.path.slice(PUBLIC_ICON_PREFIX.length);
  if (!isAdminGeneratedFaviconFileName(fileName)) return null;
  const match = GENERATED_FAVICON_FILE_RE.exec(fileName);
  if (!match || match[1] !== (slot === 'png' ? 'favicon' : 'apple-touch-icon')) return null;
  if (!('width' in result) || !('height' in result)) return null;
  const { width, height } = result;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (Math.min(width, height) < 16 || Math.max(width, height) > 512) return null;
  if (Number(match[2]) !== width || Number(match[3]) !== height) return null;
  return { path: result.path, width, height };
};
