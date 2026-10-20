import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { imageMetadata } from 'astro/assets/utils';
import sharp from 'sharp';
import { invalidateAdminImageCaches, readAdminLocalImageInspectionMeta } from './image-shared';

export const ADMIN_SITE_IMAGE_UPLOAD_MAX_BYTES = 12 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;

const IMAGE_FORMATS = {
  png: { extensions: ['.png'], extension: '.png', mimeType: 'image/png' },
  jpeg: { extensions: ['.jpg', '.jpeg'], extension: '.jpg', mimeType: 'image/jpeg' },
  webp: { extensions: ['.webp'], extension: '.webp', mimeType: 'image/webp' },
  avif: { extensions: ['.avif'], extension: '.avif', mimeType: 'image/avif' },
  gif: { extensions: ['.gif'], extension: '.gif', mimeType: 'image/gif' }
} as const;

export type AdminSiteImageUploadResult = {
  src: string;
  path: string;
  fileName: string;
  width: number;
  height: number;
  size: number;
  mimeType: string;
};

export class AdminSiteImageUploadError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = 'AdminSiteImageUploadError';
  }
}

export const getAdminSiteImageProjectRoot = (): string => process.env.ASTRO_WHONO_INTERNAL_TEST_PROJECT_ROOT?.trim() || process.cwd();

const validateSiteImage = async (file: File, buffer: Buffer, label: string) => {
  const extension = path.extname(file.name).toLowerCase();
  if (!Object.values(IMAGE_FORMATS).some((format) => (format.extensions as readonly string[]).includes(extension))) {
    throw new AdminSiteImageUploadError(`${label}仅支持 PNG / JPG / WebP / AVIF / GIF`);
  }

  let metadata: Awaited<ReturnType<typeof imageMetadata>>;
  try {
    // Astro detects the format from the image bytes, rather than the supplied name or MIME type.
    metadata = await imageMetadata(buffer);
  } catch {
    throw new AdminSiteImageUploadError('图片内容损坏或格式无效，请重新选择');
  }
  const detectedFormat = metadata.format === 'jpg' ? 'jpeg' : metadata.format;
  const format = IMAGE_FORMATS[detectedFormat as keyof typeof IMAGE_FORMATS];
  if (!format || !(format.extensions as readonly string[]).includes(extension)) {
    throw new AdminSiteImageUploadError('图片的真实格式与文件扩展名不一致');
  }
  const mimeType = file.type.trim().toLowerCase();
  if (mimeType && mimeType !== 'application/octet-stream' && mimeType !== format.mimeType) {
    throw new AdminSiteImageUploadError('图片的真实格式与文件类型不一致');
  }
  if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)
    || metadata.width <= 0 || metadata.height <= 0
    || metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw new AdminSiteImageUploadError('图片尺寸无效或超过 4000 万像素，请缩小后上传');
  }
  try {
    // A valid header alone is insufficient: decode the actual pixels before preserving the original.
    // The tiny output bounds allocation; Sharp also caps decoded input dimensions.
    await sharp(buffer, { failOn: 'warning', limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: 1, height: 1, fit: 'inside' })
      .raw()
      .toBuffer();
  } catch {
    throw new AdminSiteImageUploadError('图片内容损坏或格式无效，请重新选择');
  }
  return { ...metadata, ...format };
};

export const uploadAdminSiteImage = async ({
  file,
  directory,
  filePrefix,
  label
}: {
  file: File;
  directory: string;
  filePrefix: string;
  label: string;
}): Promise<AdminSiteImageUploadResult> => {
  if (file.size <= 0) throw new AdminSiteImageUploadError('图片文件为空，请重新选择');
  if (file.size > ADMIN_SITE_IMAGE_UPLOAD_MAX_BYTES) {
    throw new AdminSiteImageUploadError('图片超过 12MB，请压缩后再上传', 413);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const validated = await validateSiteImage(file, buffer, label);
  const digest = createHash('sha256').update(buffer).digest('hex');
  const fileName = `${filePrefix}-${digest}${validated.extension}`;
  const relativePath = `${directory}/${fileName}`;
  const absolutePath = path.join(getAdminSiteImageProjectRoot(), ...relativePath.split('/'));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await writeFile(absolutePath, buffer, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Identical uploads share a path, but an existing file is never replaced or removed.
    if (!(await readFile(absolutePath)).equals(buffer)) {
      throw new AdminSiteImageUploadError('目标图片已存在且内容不同，请稍后重试', 409);
    }
  }

  invalidateAdminImageCaches();
  const inspected = await readAdminLocalImageInspectionMeta(relativePath);
  invalidateAdminImageCaches();
  return {
    src: relativePath.startsWith('public/') ? relativePath.slice('public/'.length) : relativePath,
    path: relativePath,
    fileName,
    width: validated.width,
    height: validated.height,
    size: inspected.size ?? buffer.length,
    mimeType: inspected.mimeType ?? validated.mimeType
  };
};
