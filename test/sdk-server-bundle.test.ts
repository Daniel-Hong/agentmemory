import {expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readdir,readFile,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'tsdown';
import ts from 'typescript';
import config from '../tsdown.config.js';

it('ships the changed server SDK/parsers without resolving them from an old operating dependency tree',async()=>{
 const root=await mkdtemp(join(tmpdir(),'am-sdk-closure-'));
 try{
  await writeFile(join(root,'package.json'),JSON.stringify({type:'module',dependencies:{'iii-sdk':'0.25.1','@iii-dev/helpers':'0.25.1',yaml:'^2.8.1',json5:'^2.2.3'}}));
  await symlink(await realpath(resolve('node_modules')),join(root,'node_modules'),'dir');
  await writeFile(join(root,'entry.ts'),`import {registerWorker} from 'iii-sdk';import {http} from '@iii-dev/helpers/http';import {parse} from 'yaml';import JSON5 from 'json5';export const factory=registerWorker;export const helper=http;export const value=JSON5.parse('{ok:true}').ok&&parse('ok: true').ok;`);
  const settings=Array.isArray(config)?config[0]:config;
  await build({cwd:root,entry:[join(root,'entry.ts')],outDir:join(root,'out'),format:'esm',platform:'node',target:'node20',config:false,tsconfig:false,dts:false,clean:true,logLevel:'silent',deps:(settings as any).deps});
  const forbidden:string[]=[];
  for(const name of await readdir(join(root,'out'))){
   if(!name.endsWith('.mjs'))continue;
   const source=ts.createSourceFile(name,await readFile(join(root,'out',name),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
   const visit=(node:ts.Node)=>{
    let value:ts.Expression|undefined;
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))value=node.moduleSpecifier;
    if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require'))value=node.arguments[0];
    if(value&&ts.isStringLiteralLike(value)&&/^(iii-sdk|@iii-dev\/helpers|yaml|json5)(\/|$)/.test(value.text))forbidden.push(value.text);
    ts.forEachChild(node,visit);
   };visit(source);
  }
  expect(forbidden).toEqual([]);
  await rm(join(root,'node_modules'));
  const runtime=await import(pathToFileURL(join(root,'out','entry.mjs')).href);
  expect(typeof runtime.factory).toBe('function');expect(runtime.helper).toBeDefined();expect(runtime.value).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
},30000);
