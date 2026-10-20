import type { EssayEntry } from '../content';
import { parseEssayDateInput, parseEssayPublishedAtInput } from '../../utils/date-only';
import { loadAdminContentSourceState } from './content-entry-source';
import { loadAdminContentSourceIndex, loadAdminContentSourceManifest } from './content-source-index';
import { renderAdminMarkdownPreview } from './preview';

/** Read the saved source on every request, matching the editor rather than Astro's DEV cache. */
export const readAdminEssayReader = async (slug: string): Promise<{ entry: EssayEntry; html: string } | null> => {
  const manifest = await loadAdminContentSourceManifest();
  const items = await loadAdminContentSourceIndex(manifest, 'essay');
  const item = items.find((candidate) => candidate.slug === slug && !candidate.sourceError);
  if (!item) return null;
  let state;
  try {
    state = await loadAdminContentSourceState('essay', item.id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const raw = state.rawFrontmatter;
  const date = parseEssayDateInput(raw.date);
  if (!date) return null;
  const updatedAt = parseEssayDateInput(raw.updatedAt)?.date;
  const publishedAt = parseEssayPublishedAtInput(raw.publishedAt) ?? date.publishedAt;
  const entry: EssayEntry = {
    id: state.publicEntryId,
    collection: 'essay',
    body: state.bodyText,
    data: {
      title: typeof raw.title === 'string' ? raw.title : item.title,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      date: date.date,
      tags: item.tags,
      draft: raw.draft === true,
      visibility: raw.visibility === 'private' ? 'private' : 'public',
      archive: raw.archive !== false,
      slug: item.slug ?? undefined,
      ...(publishedAt ? { publishedAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      cover: typeof raw.cover === 'string' ? raw.cover : undefined,
      badge: typeof raw.badge === 'string' ? raw.badge : undefined
    }
  };
  const { html } = await renderAdminMarkdownPreview({ collection: 'essay', entryId: item.id, source: state.bodyText });
  return { entry, html };
};
