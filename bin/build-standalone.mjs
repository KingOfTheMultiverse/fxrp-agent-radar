#!/usr/bin/env node
/**
 * Inlines web/data.json into web/index.html -> web/standalone.html.
 *
 * The served page fetches data.json, which browsers block under file://. The
 * standalone build has no fetch at all, so a reviewer can open the file directly.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const here = (p) => new URL(`../web/${p}`, import.meta.url);
const html = readFileSync(here('index.html'), 'utf8');
const data = readFileSync(here('data.json'), 'utf8');

const FETCH_BLOCK = /\/\/ INLINE_DATA marker[\s\S]*?\}\);\n/;
if (!FETCH_BLOCK.test(html)) {
  throw new Error('INLINE_DATA marker not found in index.html — did the loader change?');
}

// </script> inside JSON would close the tag early; escape it.
const safe = data.replace(/<\//g, '<\\/');
const out = html.replace(FETCH_BLOCK, `render(${safe});\n`);

if (out.includes("fetch('./data.json')")) throw new Error('fetch survived inlining');
writeFileSync(here('standalone.html'), out);
console.log(`wrote web/standalone.html (${(out.length / 1024).toFixed(0)} KB, no network required)`);
