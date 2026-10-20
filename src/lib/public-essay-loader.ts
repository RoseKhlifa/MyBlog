import { glob, type Loader } from 'astro/loaders';

/** The public build must omit private entries before Astro registers image imports. */
export const publicEssayLoader = (): Loader => {
  const inner = glob({ pattern: '**/*.md', base: './src/content/essay' });
  return {
    name: 'public-essay-loader',
    async load(context) {
      await inner.load(context);
      if (process.env.NODE_ENV !== 'production') return;
      // Remove cached entries as well as new writes. Astro rebuilds asset imports
      // from the remaining store after all loaders finish, so private attachments
      // cannot enter the public build through an unchanged content-cache entry.
      for (const [id, entry] of context.store.entries()) {
        if (entry.data.visibility === 'private') context.store.delete(id);
      }
    }
  };
};
