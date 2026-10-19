// Load the original theme config while keeping the public blog on its static service.
import original from '../../source/astro.config.mjs';

const previousHmr = original.vite?.server?.hmr;
export default {
  ...original,
  vite: {
    ...original.vite,
    server: {
      ...original.vite?.server,
      hmr: {
        ...(previousHmr && typeof previousHmr === 'object' ? previousHmr : {}),
        path: '/admin/_hmr/',
      },
    },
  },
};
