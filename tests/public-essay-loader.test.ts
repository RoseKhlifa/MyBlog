import { afterEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('astro/loaders', () => ({ glob: () => loader }));
import { publicEssayLoader } from '../src/lib/public-essay-loader';

afterEach(() => {
  vi.unstubAllEnvs();
  loader.load.mockReset();
});

describe('private essays in content loading', () => {
  it('removes newly loaded and cached private entries before production asset imports are generated', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const entries = new Map([
      ['cached-private', { data: { visibility: 'private' }, assetImports: ['secret-old.png'] }],
      ['legacy', { data: {}, assetImports: ['public.png'] }]
    ]);
    loader.load.mockImplementation(async () => {
      entries.set('new-private', { data: { visibility: 'private' }, assetImports: ['secret-new.png'] });
      entries.set('explicit-public', { data: { visibility: 'public' }, assetImports: ['visible.png'] });
    });
    await publicEssayLoader().load({ store: { entries: () => entries.entries(), delete: (id: string) => entries.delete(id) } } as never);
    expect([...entries.keys()]).toEqual(['legacy', 'explicit-public']);
    expect([...entries.values()].flatMap((entry) => entry.assetImports)).toEqual(['public.png', 'visible.png']);
  });

  it('preserves private entries for the authenticated development reader', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const remove = vi.fn();
    const entries = new Map([['private', { data: { visibility: 'private' } }]]);
    await publicEssayLoader().load({ store: { entries: () => entries.entries(), delete: remove } } as never);
    expect(remove).not.toHaveBeenCalled();
    expect(entries.has('private')).toBe(true);
  });
});
