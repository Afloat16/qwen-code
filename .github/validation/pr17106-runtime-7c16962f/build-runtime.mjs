import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import esbuild from 'esbuild';

const root = process.cwd();
const output = path.join(root, '.qwen/pr-ui-verify/17106');
const core = path.join(root, 'packages/core');
const bridge = path.join(root, 'packages/acp-bridge/src');
const parsed = new Map();
function parse(file) {
  if (!parsed.has(file)) {
    parsed.set(file, ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true));
  }
  return parsed.get(file);
}
function sourceFile(file) {
  for (const candidate of [file.replace(/\.js$/, '.ts'), file, path.join(file, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Source not found: ${file}`);
}
const exported = new Map();
function exportsOf(file) {
  if (exported.has(file)) return exported.get(file);
  const found = new Map();
  exported.set(file, found);
  for (const node of parse(file).statements) {
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) continue;
      const target = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')
        ? sourceFile(path.resolve(path.dirname(file), node.moduleSpecifier.text))
        : file;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const item of node.exportClause.elements) {
          if (!item.isTypeOnly) found.set(item.name.text, { file: target, name: (item.propertyName ?? item.name).text });
        }
      } else if (!node.exportClause && target !== file) {
        for (const [name, location] of exportsOf(target)) if (!found.has(name)) found.set(name, location);
      }
      continue;
    }
    if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) found.set(declaration.name.text, { file, name: declaration.name.text });
      }
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
      found.set(node.name.text, { file, name: node.name.text });
    }
  }
  return found;
}
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? filesUnder(path.join(dir, entry.name))
    : [path.join(dir, entry.name)]);
}
const names = new Set();
for (const file of filesUnder(bridge).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.includes('/internal/testUtils.ts'))) {
  for (const node of parse(file).statements) {
    if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== '@qwen-code/qwen-code-core') continue;
    if (!node.importClause || node.importClause.isTypeOnly) continue;
    const bindings = node.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) if (!item.isTypeOnly) names.add((item.propertyName ?? item.name).text);
    }
  }
}
const locations = exportsOf(path.join(core, 'src/index.ts'));
const facade = path.join(output, 'core-runtime-exports.ts');
fs.writeFileSync(facade, [...names].sort().map((name) => {
  const location = locations.get(name);
  if (!location) throw new Error(`Unresolved core export ${name}`);
  return `export { ${location.name}${location.name === name ? '' : ` as ${name}`} } from ${JSON.stringify(location.file)};`;
}).join('\n') + '\n');
const packageExports = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8')).exports;
const entry = path.join(output, 'entry.ts');
fs.writeFileSync(entry, `export { createAcpSessionBridge } from ${JSON.stringify(path.join(bridge, 'bridge.ts'))};\nexport { createSpawnChannelFactory } from ${JSON.stringify(path.join(bridge, 'spawnChannel.ts'))};\n`);
const result = await esbuild.build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', target: 'node24',
  outfile: path.join(output, 'bridge-runtime.mjs'), metafile: true, sourcemap: true,
  packages: 'external',
  plugins: [{ name: 'exact-core-runtime-exports', setup(build) {
    build.onResolve({ filter: /^@qwen-code\/qwen-code-core(?:\/|$)/ }, ({ path: specifier }) => {
      if (specifier === '@qwen-code/qwen-code-core') return { path: facade };
      const subpath = specifier.slice('@qwen-code/qwen-code-core/'.length);
      const target = packageExports[`./${subpath}`];
      const value = typeof target === 'string' ? target : target?.import;
      const mapped = value ? value.replace(/^\.\/dist\//, './') : `./src/${subpath}`;
      return { path: sourceFile(path.resolve(core, mapped)) };
    });
  }}],
});
const inputs = Object.keys(result.metafile.inputs).filter((file) => file.startsWith('packages/'));
const manifest = {
  head: '7c16962f5ed04d61eff25accadc105e18be6cb34',
  node: process.version,
  sourceFiles: inputs.map((file) => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
  coreExports: [...names].sort(),
  externalImports: Object.values(result.metafile.outputs).flatMap((file) => file.imports).filter((item) => item.external).map((item) => item.path),
};
fs.writeFileSync(path.join(output, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ sourceFiles: inputs.length, coreExports: names.size, externalImports: manifest.externalImports }, null, 2));
