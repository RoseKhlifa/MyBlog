import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const site = 'https://blog.rosekhlifa.com';
for (const [file, route] of [
  ['dist/index.html', '/'],
  ['dist/archive/markdown-guide/index.html', '/archive/markdown-guide/']
]) {
  const html = readFileSync(file, 'utf8');
  assert(html.includes(`<link rel="canonical" href="${site}${route}"`), `Canonical mismatch: ${file}`);
  assert(!/(?:src|href)="https:\/\/blog\.rosekhlifa\.com\/(?:_astro|fonts)\//.test(html), 'Runtime assets must retain the current origin');
  const assetPaths = [...html.matchAll(/(?:src|href)="(\/(?:_astro|fonts|author)\/[^"?#]+)(?:[?#][^"]*)?"/g)].map((match) => match[1]);
  assert(assetPaths.length > 0, `Missing assets: ${file}`);
  for (const asset of assetPaths) assert(existsSync(`dist${asset}`), `Missing asset: ${asset}`);
}
for (const file of ['rss.xml', 'archive/rss.xml', 'essay/rss.xml', 'sitemap-index.xml', 'sitemap-0.xml', 'robots.txt']) {
  assert(readFileSync(`dist/${file}`, 'utf8').includes(site), `${file} must use the production SITE_URL`);
}
console.log('BUILD PASS: production canonical/RSS/sitemap/robots; homepage/article assets use the current origin');
