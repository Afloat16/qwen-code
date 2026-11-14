import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const repo=process.cwd();
const req=createRequire(path.join(repo,'package.json'));
const ts=req('typescript');
const yargs=(await import(pathToFileURL(path.join(path.dirname(req.resolve('yargs/package.json')),'index.mjs')).href)).default;
const file='packages/cli/src/commands/mcp/add.ts';
const raw=readFileSync(file,'utf8');
const hash=v=>createHash('sha256').update(v).digest('hex');
const diff=()=>{const r=spawnSync('git',['diff','--binary','HEAD'],{encoding:'utf8'});assert.equal(r.status,0);return r.stdout;};
const before=diff();
const ast=ts.createSourceFile(file,raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
let dec;
for(const statement of ast.statements){
 if(!ts.isVariableStatement(statement))continue;
 dec=statement.declarationList.declarations.find(item=>ts.isIdentifier(item.name)&&item.name.text==='addCommand');
 if(dec)break;
}
assert(dec&&ts.isObjectLiteralExpression(dec.initializer));
const property=name=>dec.initializer.properties.find(item=>ts.isPropertyAssignment(item)&&item.name.getText(ast)===name).initializer.getText(ast);
const exact='export const command='+property('command')+';\nexport const builder='+property('builder')+';\n';
const js=ts.transpileModule(exact,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const actual=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const cases=[
 ['args-separated',['run','image','--args','value'],['run','image','--args','value']],
 ['args-equals',['run','image','--args=value','img'],['run','image','--args=value','img']],
 ['similar-name',['run','image','--argsNote','x'],['run','image','--argsNote','x']],
 ['serverArgs-collision',['run','image','--serverArgs','value'],['run','image','--serverArgs','value']],
 ['server-args-collision',['run','image','--server-args','value'],['run','image','--server-args','value']],
 ['numeric-literals',['0x10','1e3','007'],['0x10','1e3','007']],
 ['timeout-number',['run','image','--timeout','1500'],['run','image'],1500],
 ['separator-data',['run','image','--','--args','0x10','--timeout','1500'],['run','image','--args','0x10','--timeout','1500']],
 ['empty-args',[],[]]
];
const observations=[];
for(const [name,tail,expected,timeout] of cases){
 let captured;
 const argv=await yargs([]).exitProcess(false).command({...actual,handler:args=>{captured=args;}}).parseAsync(['add','independent-server','docker',...tail]);
 const item={name,tail,actual:argv.args??[],expected,timeout:argv.timeout,timeoutType:typeof argv.timeout,handlerInvoked:captured===argv};
 try{
  assert.deepEqual(item.actual,expected);
  assert.equal(item.handlerInvoked,true);
  assert.equal(argv.timeout,timeout);
  if(timeout!==undefined)assert.equal(typeof argv.timeout,'number');
  item.pass=true;
 }catch(error){item.pass=false;item.error=error.message;}
 observations.push(item);
 console.log('MCP_CASE '+JSON.stringify(item));
}
const failures=observations.filter(x=>!x.pass);
const phase=process.env.PHASE;
const report={phase,source:process.env.SOURCE_SHA,boundary:'Unchanged production command and builder extracted with TypeScript AST; real locked yargs parser and middleware, observer handler only. Does not execute production settings writer, whole CLI, or model.',method:'test-script',bootstrap:'ESM yargs entrypoint, matching production cli.ts import',versions:{node:process.version,typescript:ts.version,yargs:req('yargs/package.json').version},source_sha256:hash(raw),builder_sha256:hash(exact),observations,passed:observations.length-failures.length,failed:failures.length,source_unchanged:readFileSync(file,'utf8')===raw,tracked_diff_unchanged:diff()===before};
const out=path.join(process.env.RUNNER_TEMP,'qwen-independent-round8','17120-'+phase);
mkdirSync(out,{recursive:true});
writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log('INDEPENDENT_MCP_REPORT '+JSON.stringify(report));
assert(report.source_unchanged&&report.tracked_diff_unchanged);
if(phase==='baseline')assert.deepEqual(failures.map(x=>x.name),['args-separated','args-equals','separator-data']);
else assert.equal(failures.length,0);

