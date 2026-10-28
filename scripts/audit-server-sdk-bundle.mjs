import {readdir,readFile,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import ts from 'typescript';
const versions={'iii-sdk':'0.25.0','@iii-dev/helpers':'0.25.0',yaml:'2.8.1',json5:'2.2.3'};
export async function auditServerSdkBundle(root){
 const files={},externalSpecifiers={};let totalBytes=0;
 for(const [name,version]of Object.entries(versions)){const installed=JSON.parse(await readFile(join(root,'node_modules',name,'package.json'),'utf8'));if(installed.version!==version)throw Error('SDK_SERVER_VERSION_MISMATCH');}
 for(const name of ['dist/cli.mjs','dist/index.mjs']){try{await readFile(join(root,name));}catch{throw Error('SDK_SERVER_ENTRY_MISSING');}}
 async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){
  if(e.isSymbolicLink())throw Error('SDK_SERVER_SYMLINK');
  const path=join(dir,e.name);if(e.isDirectory())await walk(path);
  else if(e.isFile()&&/\.(?:mjs|cjs|js)$/.test(e.name)){const key=relative(root,path).split('\\').join('/'),bytes=await readFile(path);files[key]=createHash('sha256').update(bytes).digest('hex');totalBytes+=bytes.length;if(Object.keys(files).length>1000||totalBytes>128*1024*1024)throw Error('SDK_SERVER_INVENTORY_LIMIT');
   const found=new Set(),source=ts.createSourceFile(key,bytes.toString('utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
   function visit(node){
    let literal;
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))literal=node.moduleSpecifier;
    if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&/^_*require(?:\$\d+)?$/.test(node.expression.text)))literal=node.arguments[0];
    if(literal&&ts.isStringLiteralLike(literal)&&!literal.text.startsWith('./')&&!literal.text.startsWith('../'))found.add(literal.text);
    ts.forEachChild(node,visit);
   }visit(source);
   if([...found].some(id=>/^(?:iii-sdk|@iii-dev\/helpers|yaml|json5|@opentelemetry)(?:\/|$)/.test(id)))throw Error('SDK_SERVER_EXTERNAL_DEPENDENCY');
   externalSpecifiers[key]=[...found].sort();}
 }}await walk(join(root,'dist'));
 return{version:1,mode:'bundled-sdk0.25-v1',bundledPackages:versions,files:Object.fromEntries(Object.entries(files).sort()),externalSpecifiers:Object.fromEntries(Object.entries(externalSpecifiers).sort())};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const root=resolve(process.argv[2]??'.');await writeFile(join(root,'dist/server-sdk-bundle.json'),JSON.stringify(await auditServerSdkBundle(root),null,2)+'\n');}
