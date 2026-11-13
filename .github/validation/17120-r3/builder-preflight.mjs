import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const require = createRequire(path.join(repo, 'package.json'));
const ts = require('typescript');
const out = path.join(process.env.RUNNER_TEMP, 'qwen17120-r3-validation');
mkdirSync(out, { recursive: true });
const files = [
  'packages/cli/src/cli.ts',
  'packages/cli/src/cli.test.ts',
  'packages/cli/src/commands/mcp/add.ts',
  'packages/cli/src/commands/mcp/add.test.ts',
];
const hash = (text) => createHash('sha256').update(text).digest('hex');
const identities = () => Object.fromEntries(files.map((file) => [file, hash(readFileSync(path.join(repo, file)))]));
const before = identities();
const diff = () => {
  const result = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0);
  return result.stdout;
};
const beforeDiff = diff();
const probeTs = path.join(repo, 'packages/cli/src/.round7-mcp-builder-preflight.ts');
const probeJs = path.join(repo, 'packages/cli/src/.round7-mcp-builder-preflight.mjs');
assert(!existsSync(probeTs) && !existsSync(probeJs));
const report = {
  source: process.env.CANDIDATE_SHA,
  boundary: 'Type/parser preflight of the exact extracted production builder. It does not execute the production handler, settings writer, full CLI, or repository test suites.',
  accepted: false,
};
try {
  const yargsPackage = JSON.parse(readFileSync(require.resolve('yargs/package.json'), 'utf8'));
  const typesPackagePath = require.resolve('@types/yargs/package.json');
  const typesPackage = JSON.parse(readFileSync(typesPackagePath, 'utf8'));
  assert.equal(yargsPackage.version, '17.7.2');
  assert.equal(typesPackage.version, '17.0.33');
  report.versions = { yargs: yargsPackage.version, yargsTypes: typesPackage.version, typescript: ts.version };
  const typesSource = readFileSync(path.join(path.dirname(typesPackagePath), 'index.d.ts'), 'utf8');
  const typesLines = typesSource.split('\n');
  report.positional_type_declaration = [];
  for (let i = 0; i < typesLines.length; i++) {
    if (/interface PositionalOptions|array\?: boolean|array: true|positional<K/.test(typesLines[i])) {
      report.positional_type_declaration.push({ line: i + 1, text: typesLines.slice(Math.max(0, i - 1), Math.min(typesLines.length, i + 4)).join('\n') });
    }
  }
  const sourcePath = path.join(repo, 'packages/cli/src/commands/mcp/add.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const parsedSource = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let declaration;
  for (const statement of parsedSource.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    declaration = statement.declarationList.declarations.find((item) => ts.isIdentifier(item.name) && item.name.text === 'addCommand');
    if (declaration) break;
  }
  assert(declaration && ts.isObjectLiteralExpression(declaration.initializer));
  const property = (name) => declaration.initializer.properties.find((item) =>
    ts.isPropertyAssignment(item) && item.name.getText(parsedSource) === name);
  const builder = property('builder').initializer.getText(parsedSource);
  const command = property('command').initializer.getText(parsedSource);
  assert.equal(declaration.type.getText(parsedSource), 'CommandModule');
  report.builder_sha256 = hash(builder);
  const probe = "import type { CommandModule } from 'yargs';\n" +
    'export const addCommand: CommandModule = {\n' +
    '  command: ' + command + ',\n' +
    '  builder: ' + builder + ',\n' +
    '  handler: () => {},\n' +
    '};\n';
  writeFileSync(probeTs, probe);
  const config = ts.readConfigFile(path.join(repo, 'tsconfig.json'), ts.sys.readFile);
  assert(!config.error);
  const converted = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, repo);
  assert.equal(converted.errors.length, 0);
  const compilerOptions = {
    ...converted.options,
    noEmit: true,
    composite: false,
    incremental: false,
    declaration: false,
    sourceMap: false,
  };
  report.compiler_config = 'Repository tsconfig compiler options; only emit/build-cache options disabled for the standalone extracted-builder probe.';
  const program = ts.createProgram([probeTs], compilerOptions);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  report.type_diagnostics = diagnostics.map((d) => ({
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    file: d.file?.fileName,
  }));
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => repo,
      getNewLine: () => '\n',
    }));
  }
  assert.equal(diagnostics.length, 0, 'Exact builder must pass repository strict typing before the full build');
  report.type_preflight_passed = true;
  const compiled = ts.transpileModule(probe, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const runtime = compiled + "\nimport yargs from 'yargs';\nimport assert from 'node:assert/strict';\n" +
    "const argv = await yargs([]).exitProcess(false).command(addCommand).parseAsync(['add', 'preflight-server', 'node', '0x10', '--timeout', '1500', '--', 'after-separator']);\n" +
    "assert.deepEqual(argv.args, ['0x10', 'after-separator']);\n" +
    "assert.equal(argv.timeout, 1500);\nassert.equal(typeof argv.timeout, 'number');\n" +
    "console.log('PARSER_PREFLIGHT ' + JSON.stringify({ args: argv.args, timeout: argv.timeout, timeoutType: typeof argv.timeout }));\n";
  writeFileSync(probeJs, runtime);
  const executed = spawnSync(process.execPath, [probeJs], { cwd: repo, encoding: 'utf8', timeout: 30000 });
  writeFileSync(path.join(out, 'builder-parser-preflight.log'), executed.stdout + executed.stderr);
  process.stdout.write(executed.stdout);
  process.stderr.write(executed.stderr);
  assert.equal(executed.status, 0, executed.error?.message || 'Parser preflight failed');
  report.parser_preflight_passed = true;
  report.accepted = true;
} finally {
  rmSync(probeTs, { force: true });
  rmSync(probeJs, { force: true });
  report.source_before = before;
  report.source_after = identities();
  report.source_unchanged = JSON.stringify(before) === JSON.stringify(report.source_after);
  report.tracked_diff_unchanged = diff() === beforeDiff;
  report.temporary_files_removed = !existsSync(probeTs) && !existsSync(probeJs);
  writeFileSync(path.join(out, 'builder-preflight-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('BUILDER_PREFLIGHT_REPORT ' + JSON.stringify(report));
  assert(report.source_unchanged && report.tracked_diff_unchanged && report.temporary_files_removed);
}
