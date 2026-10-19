import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const envFile = process.argv[2];
if (!envFile) throw new Error('Usage: node deploy/check-site.mjs ENV_FILE');
const entries = readFileSync(envFile, 'utf8').trim().split(/\r?\n/).map((line) => {
  const split = line.indexOf('=');
  if (split < 1) throw new Error(`Invalid environment line: ${line}`);
  return [line.slice(0, split), line.slice(split + 1)];
});
const env = Object.fromEntries(entries);
process.env.SITE_URL = env.SITE_URL;
const { site, hasSiteUrl } = await import(pathToFileURL(path.resolve(process.argv[3] || 'site.config.mjs')));
const actual = { SITE_URL: env.SITE_URL, hasSiteUrl, resolvedUrl: site.url, base: env.ASTRO_WHONO_BASE_PATH };
if (hasSiteUrl !== Boolean(env.SITE_URL)) throw new Error('Unexpected SITE_URL branch');
if (site.url !== (env.SITE_URL || 'https://example.invalid')) throw new Error('Unexpected resolved URL');
console.log(JSON.stringify(actual));
