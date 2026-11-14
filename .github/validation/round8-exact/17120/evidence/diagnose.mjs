import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import yargs from 'yargs/yargs';

const original = readFileSync(new URL('./add-original.ts', import.meta.url), 'utf8');
const replace = (source, before, after) => {
  assert.equal(source.split(before).length, 2, before);
  return source.replace(before, after);
};
let rename = replace(original, "command: 'add <name> <commandOrUrl> [args...]'", "command: 'add <name> <commandOrUrl> [serverArgs...]'");
rename = replace(rename, ".positional('args', { type: 'string', array: true })", ".positional('serverArgs', { type: 'string', array: true })");
rename = replace(rename, '      .middleware((argv) => {\n', "      .middleware((argv) => {\n        if (argv['serverArgs'] !== undefined) {\n          argv['args'] = argv['serverArgs'];\n        }\n");
rename = replace(rename, "const existingArgs = argv['args'] || [];", "const existingArgs = argv['serverArgs'] || [];");

let numeric = replace(original, "      .positional('args', { type: 'string', array: true })\n", '');
numeric = replace(numeric, "        'populate--': true, // Populate server args after -- separator\n", "        'populate--': true, // Populate server args after -- separator\n        'parse-numbers': false,\n");
numeric = replace(numeric, "const existingArgs = argv['args'] || [];", "const existingArgs = (argv['args'] as Array<string | number> | undefined) || [];");

let rawTail = replace(original, "command: 'add <name> <commandOrUrl> [args...]'", "command: 'add <name> <commandOrUrl>'");
rawTail = replace(rawTail, "      .positional('args', { type: 'string', array: true })\n", '');
rawTail = replace(rawTail, "        'populate--': true, // Populate server args after -- separator\n", "        'populate--': true, // Populate server args after -- separator\n        'parse-positional-numbers': false,\n");
rawTail = replace(rawTail, "      .positional('name', {", "      .strict(false)\n      .strictCommands(false)\n      .positional('name', {");
rawTail = replace(rawTail, "        // Handle -- separator args as server args if present\n        if (argv['--']) {\n          const existingArgs = argv['args'] || [];\n          argv['args'] = [...existingArgs, ...(argv['--'] as string[])];\n        }", "        const existingArgs = argv._.slice(argv._.indexOf('add') + 1);\n        argv['args'] = argv['--']\n          ? [...existingArgs, ...(argv['--'] as string[])]\n          : existingArgs;");

function extract(source) {
  const ast = ts.createSourceFile('add.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let declaration;
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === 'addCommand');
    if (declaration) break;
  }
  assert(declaration && ts.isObjectLiteralExpression(declaration.initializer));
  const property = name => declaration.initializer.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(ast) === name).initializer.getText(ast);
  return 'export const command=' + property('command') + ';\nexport const builder=' + property('builder') + ';\n';
}

const cases = [
  ['args-separated', ['run', 'image', '--args', 'value'], ['run', 'image', '--args', 'value']],
  ['args-equals', ['run', 'image', '--args=value', 'img'], ['run', 'image', '--args=value', 'img']],
  ['similar-name', ['run', 'image', '--argsNote', 'x'], ['run', 'image', '--argsNote', 'x']],
  ['serverArgs-collision', ['run', 'image', '--serverArgs', 'value'], ['run', 'image', '--serverArgs', 'value']],
  ['server-args-collision', ['run', 'image', '--server-args', 'value'], ['run', 'image', '--server-args', 'value']],
  ['numeric-literals', ['0x10', '1e3', '007'], ['0x10', '1e3', '007']],
  ['timeout-number', ['run', 'image', '--timeout', '1500'], ['run', 'image'], 1500],
  ['separator-data', ['run', 'image', '--', '--args', '0x10', '--timeout', '1500'], ['run', 'image', '--args', '0x10', '--timeout', '1500']],
  ['empty-args', [], []],
  ['server-command-named-add', ['add', '--args', 'next'], ['add', '--args', 'next']],
];
const result = {};
for (const [label, source] of [['unchanged-parent', original], ['reviewer-rename', rename], ['no-implicit-numbers', numeric], ['raw-tail', rawTail]]) {
  const extracted = extract(source);
  const javascript = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const actual = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
  const observations = [];
  for (const nested of [false, true]) for (const [name, tail, expected, timeout] of cases) {
    let captured;
    const command = { ...actual, handler: args => { captured = args; } };
    const parser = yargs([]).exitProcess(false).strict().strictCommands().fail((message, error) => { throw error || new Error(message); });
    if (nested) parser.command({ command: 'mcp', builder: argv => argv.command(command), handler: () => {} });
    else parser.command(command);
    const item = { nested, name, tail, expected };
    try {
      const argv = await parser.parseAsync([...(nested ? ['mcp'] : []), 'add', 'diagnostic-server', 'docker', ...tail]);
      item.actual = argv.args ?? [];
      item.timeout = argv.timeout;
      item.timeoutType = typeof argv.timeout;
      item.handlerInvoked = captured === argv;
      assert.deepEqual(item.actual, expected);
      assert.equal(item.handlerInvoked, true);
      assert.equal(argv.timeout, timeout);
      if (timeout !== undefined) assert.equal(typeof argv.timeout, 'number');
      item.pass = true;
    } catch (error) { item.pass = false; item.error = error.message; }
    observations.push(item);
  }
  result[label] = { passed: observations.filter(x => x.pass).length, failed: observations.filter(x => !x.pass).length, observations };
  console.log('VARIANT ' + label + ' ' + JSON.stringify(result[label]));
  writeFileSync(new URL('./' + label + '.ts', import.meta.url), source);
}
writeFileSync(new URL('./diagnostic-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
