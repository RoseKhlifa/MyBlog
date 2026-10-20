import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { ESSAY_PUBLIC_SLUG_RE } from './utils/slug-rules';
import { normalizeBitsAvatarPath } from './utils/format';
import { parseEssayDateInput, parseEssayPublishedAtInput } from './utils/date-only';
import { normalizeBitsImageSource } from './lib/bits-image-source';
import { publicEssayLoader } from './lib/public-essay-loader';

const slugRule = z
  .string()
  .regex(ESSAY_PUBLIC_SLUG_RE, 'slug must be lowercase kebab-case');

const essayBaseFields = {
  title: z.string(),
  description: z.string().optional(),
  date: z.unknown(),
  tags: z.array(z.string()).default([]),
  draft: z.boolean().default(false),
  visibility: z.enum(['public', 'private']).default('public'),
  archive: z.boolean().default(true),
  publishedAt: z.unknown().optional(),
  updatedAt: z.unknown().optional(),
  // Optional custom permalink. If present, it overrides the default public slug
  // derived from the entry id / path.
  slug: slugRule.optional()
};

const essayShape = {
  ...essayBaseFields,
  cover: z.string().optional(),
  badge: z.string().optional()
};

const essaySchema = z.object(essayShape).transform((data, ctx) => {
  const dateResult = parseEssayDateInput(data.date);
  if (!dateResult) {
    ctx.addIssue({
      code: 'custom',
      path: ['date'],
      message: 'date must be a valid YYYY-MM-DD date or ISO 8601 datetime with timezone'
    });
    return z.NEVER;
  }

  const publishedAtInput = data.publishedAt;
  const hasExplicitPublishedAt =
    publishedAtInput != null &&
    !(typeof publishedAtInput === 'string' && publishedAtInput.trim() === '');
  const publishedAt = hasExplicitPublishedAt
    ? parseEssayPublishedAtInput(publishedAtInput)
    : dateResult.publishedAt;

  if (hasExplicitPublishedAt && !publishedAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['publishedAt'],
      message: 'publishedAt must be a valid ISO 8601 datetime with timezone'
    });
    return z.NEVER;
  }

  const hasExplicitUpdatedAt =
    data.updatedAt != null &&
    !(typeof data.updatedAt === 'string' && data.updatedAt.trim() === '');
  const updatedAtInput = data.updatedAt;
  const updatedAtResult = hasExplicitUpdatedAt ? parseEssayDateInput(updatedAtInput) : null;

  if (hasExplicitUpdatedAt && !updatedAtResult) {
    ctx.addIssue({
      code: 'custom',
      path: ['updatedAt'],
      message: 'updatedAt must be a valid YYYY-MM-DD date or ISO 8601 datetime with timezone'
    });
    return z.NEVER;
  }

  if (updatedAtResult && updatedAtResult.date.valueOf() < dateResult.date.valueOf()) {
    ctx.addIssue({
      code: 'custom',
      path: ['updatedAt'],
      message: 'updatedAt must not be earlier than date'
    });
    return z.NEVER;
  }

  const {
    publishedAt: _publishedAt,
    updatedAt: _updatedAt,
    ...normalizedData
  } = data;

  return {
    ...normalizedData,
    date: dateResult.date,
    ...(publishedAt ? { publishedAt } : {}),
    ...(updatedAtResult ? { updatedAt: updatedAtResult.date } : {})
  };
});

const bitsImage = z.object({
  src: z
    .string()
    .superRefine((value, ctx) => {
      if (!normalizeBitsImageSource(value)) {
        ctx.addIssue({
          code: 'custom',
          message: 'images[].src 只允许 public/** 下的相对图片路径或 https:// 远程 URL，不要带 public/、不要以 / 开头，也不要使用 http、..、?、#'
        });
      }
    })
    .transform((value) => normalizeBitsImageSource(value) ?? value),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  alt: z.string().optional()
});

const bitsAuthorAvatar = z
  .string()
  .superRefine((value, ctx) => {
    const normalized = normalizeBitsAvatarPath(value);
    if (normalized === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'author.avatar 只允许相对图片路径（例如 author/avatar.webp），不要带 public/、不要以 / 开头，也不要使用 URL、..、?、#'
      });
      return;
    }
  })
  .transform((value) => normalizeBitsAvatarPath(value) ?? value);

const bitsAuthor = z.object({
  name: z.string().optional(),
  avatar: bitsAuthorAvatar.optional()
});

const essay = defineCollection({
  loader: publicEssayLoader(),
  schema: essaySchema
});

const bits = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/bits' }),
  schema: z.object({
    // Bits can be untitled.
    title: z.string().optional(),
    description: z.string().optional(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    slug: slugRule.optional(),

    // Optional media for card display.
    images: z.array(bitsImage).optional(),
    author: bitsAuthor.optional()
  })
});

const memo = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/memo' }),
  schema: z.object({
    title: z.string().optional(),
    subtitle: z.string().optional(),
    date: z.coerce.date().optional(),
    draft: z.boolean().default(false),
    slug: z.string().optional()
  })
});

const about = defineCollection({
  loader: glob({ pattern: 'index.md', base: './src/content/about' }),
  schema: z.looseObject({})
});

export const collections = { essay, bits, memo, about };
