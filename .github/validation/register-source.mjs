import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.QWEN_MCP_PROBE_REPO;
assert(root && path.isAbsolute(root));
const aliases = {};
const core = path.join(root, 'packages/core');
aliases['@qwen-code/qwen-code-core'] = pathToFileURL(path.join(core, 'index.ts')).href;
const exports = JSON.parse(readFileSync(path.join(core, 'package.json'), 'utf8')).exports;
for (const [subpath, conditions] of Object.entries(exports)) {
  const entry = conditions?.import;
  if (subpath === '.' || typeof entry !== 'string' || !entry.startsWith('./dist/')) continue;
  const source = path.join(core, entry.slice('./dist/'.length).replace(/\.js$/, '.ts'));
  if (existsSync(source)) aliases['@qwen-code/qwen-code-core/' + subpath.slice(2)] = pathToFileURL(source).href;
}
for (const name of readdirSync(path.join(root, 'packages/channels'))) {
  const directory = path.join(root, 'packages/channels', name);
  const manifest = path.join(directory, 'package.json');
  const entry = path.join(directory, 'src/index.ts');
  if (existsSync(manifest) && existsSync(entry)) {
    aliases[JSON.parse(readFileSync(manifest, 'utf8')).name] = pathToFileURL(entry).href;
  }
}
aliases['@qwen-code/channel-base/markdown-chunks'] = pathToFileURL(path.join(root, 'packages/channels/base/src/markdown-chunks.ts')).href;
const source = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const aliases = ${JSON.stringify(aliases)};
const prefix = '@qwen-code/qwen-code-core/';
const coreSource = ${JSON.stringify(pathToFileURL(path.join(core, 'src') + '/').href)};
export function resolve(specifier, context, nextResolve) {
  if (aliases[specifier]) return { shortCircuit: true, url: aliases[specifier], format: 'module' };
  if (specifier.startsWith(prefix)) {
    const sub = specifier.slice(prefix.length).replace(/\\.js$/, '');
    for (const extension of ['.ts', '.tsx']) {
      const url = new URL(sub + extension, coreSource);
      if (existsSync(fileURLToPath(url))) return { shortCircuit: true, url: url.href, format: 'module' };
    }
  }
  return nextResolve(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(source), import.meta.url);
