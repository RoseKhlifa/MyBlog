import type { APIRoute } from 'astro';
import {
  ADMIN_JSON_HEADERS,
  validateAdminFormDataWriteRequest,
  withAdminSettingsWriteLock
} from '../../../../lib/admin-console/admin-api';
import { AdminHeroUploadError, uploadAdminHeroImage } from '../../../../lib/admin-console/hero-upload';

const jsonResponse = (status: number, payload: unknown): Response => new Response(JSON.stringify(payload), {
  status,
  headers: ADMIN_JSON_HEADERS
});

export const GET: APIRoute = async () => {
  if (!import.meta.env.DEV && !process.env.VITEST) return new Response('Not Found', { status: 404 });
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { allow: 'POST', 'cache-control': 'no-store' }
  });
};

export const POST: APIRoute = async ({ request, url }) => {
  if (!import.meta.env.DEV && !process.env.VITEST) return new Response('Not Found', { status: 404 });
  const requestError = validateAdminFormDataWriteRequest(request, url, 'Hero image');
  if (requestError) return jsonResponse(requestError.status, { ok: false, errors: [requestError.error] });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse(400, { ok: false, errors: ['上传请求不是合法 multipart/form-data'] });
  }
  const file = formData.get('image');
  if (!(file instanceof File)) return jsonResponse(400, { ok: false, errors: ['上传请求缺少 image 文件'] });

  return withAdminSettingsWriteLock(async () => {
    try {
      const result = await uploadAdminHeroImage({ file });
      return jsonResponse(200, { ok: true, result });
    } catch (error) {
      if (error instanceof AdminHeroUploadError) return jsonResponse(error.status, { ok: false, errors: [error.message] });
      console.error('[astro-whono] Failed to upload admin Hero image:', error);
      return jsonResponse(500, { ok: false, errors: ['Hero 图片上传失败，请稍后重试'] });
    }
  });
};
