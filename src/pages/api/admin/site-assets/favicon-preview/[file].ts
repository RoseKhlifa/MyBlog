import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isAdminGeneratedFaviconFileName } from '../../../../../lib/admin-console/favicon-preview';

const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff'
};

// The public static build emits no editor-only preview files.
export const getStaticPaths = () => [];

export const GET: APIRoute = async ({ params }) => {
  if (!import.meta.env.DEV && !process.env.VITEST) return new Response('Not Found', { status: 404, headers: PRIVATE_HEADERS });
  const fileName = params.file ?? '';
  if (!isAdminGeneratedFaviconFileName(fileName)) {
    return new Response('Not Found', { status: 404, headers: PRIVATE_HEADERS });
  }

  try {
    const projectRoot = process.env.ASTRO_WHONO_INTERNAL_TEST_PROJECT_ROOT?.trim() || process.cwd();
    const bytes = await readFile(path.join(projectRoot, 'public', 'images', 'site', fileName));
    return new Response(new Uint8Array(bytes), {
      headers: { ...PRIVATE_HEADERS, 'content-type': 'image/png', 'content-length': String(bytes.length) }
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      console.error('[astro-whono] Failed to preview admin favicon:', error);
    }
    return new Response('Not Found', { status: 404, headers: PRIVATE_HEADERS });
  }
};

export const ALL: APIRoute = async () => {
  if (!import.meta.env.DEV && !process.env.VITEST) return new Response('Not Found', { status: 404, headers: PRIVATE_HEADERS });
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { ...PRIVATE_HEADERS, allow: 'GET' }
  });
};
