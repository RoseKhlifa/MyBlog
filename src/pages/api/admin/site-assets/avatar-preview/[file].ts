import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ADMIN_AVATAR_UPLOAD_DIRECTORY } from '../../../../../lib/admin-console/avatar-upload';
import { getAdminSiteImageProjectRoot } from '../../../../../lib/admin-console/site-image-upload';

const FILE_NAME_RE = /^avatar-[0-9a-f]{64}\.(png|jpg|webp|avif|gif)$/;
const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif'
};
const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff'
};

// The static public site never emits this development-only image endpoint.
export const getStaticPaths = () => [];

export const GET: APIRoute = async ({ params }) => {
  if (!import.meta.env.DEV && !process.env.VITEST) return new Response('Not Found', { status: 404 });
  const match = FILE_NAME_RE.exec(params.file ?? '');
  if (!match) return new Response('Not Found', { status: 404, headers: PRIVATE_HEADERS });

  try {
    const filePath = path.join(getAdminSiteImageProjectRoot(), ...ADMIN_AVATAR_UPLOAD_DIRECTORY.split('/'), match[0]);
    const buffer = await readFile(filePath);
    return new Response(new Uint8Array(buffer), {
      headers: { ...PRIVATE_HEADERS, 'content-type': MIME_TYPES[match[1]!]!, 'content-length': String(buffer.length) }
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      console.error('[astro-whono] Failed to preview admin avatar:', error);
    }
    return new Response('Not Found', { status: 404, headers: PRIVATE_HEADERS });
  }
};

export const ALL: APIRoute = async () => {
  if (!import.meta.env.DEV && !process.env.VITEST) return new Response('Not Found', { status: 404 });
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { ...PRIVATE_HEADERS, allow: 'GET' }
  });
};
