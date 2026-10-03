import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const source=await readFile(new URL('../../../packages/ui/src/ImportedMedicalHistory.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
const componentModule={exports:{}};
new Function('require','module','exports',code)(require,componentModule,componentModule.exports);
const {ImportedMedicalHistory}=componentModule.exports;
const record={id:'synthetic-record',origin:'patient-provided',currentVersionId:'synthetic-v2',title:'Synthetic history',createdAt:'2026-01-01T00:00:00Z',
  versions:[{id:'synthetic-v2',versionNo:2,origin:'provider-authored',createdAt:'2026-01-02T00:00:00Z',record:'<img src=x onerror=alert(1)>',notes:'Synthetic updated note',structuredData:{finding:'Synthetic result'}},
    {id:'synthetic-v1',versionNo:1,origin:'patient-provided',createdAt:'2026-01-01T00:00:00Z',record:'Synthetic original note'}],
  files:[{id:'synthetic-file',fileName:'Synthetic.txt',sizeBytes:19,accessStatus:'pending-safety-verification',storage_path:'must-not-disclose',url:'https://example.invalid/forbidden'}]};
test('renders original/current history with origin labels and escapes clinical HTML',()=>{
  const html=renderToStaticMarkup(React.createElement(ImportedMedicalHistory,{records:[record]}));
  assert.match(html,/Version 2 \(current\)/);assert.match(html,/Version 1/);
  assert.match(html,/Patient-provided/);assert.match(html,/Provider-authored/);
  assert.match(html,/Synthetic original note/);assert.match(html,/Synthetic updated note/);
  assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
});
test('attachments remain metadata only until genuine safety approval',()=>{
  const html=renderToStaticMarkup(React.createElement(ImportedMedicalHistory,{records:[record]}));
  assert.match(html,/Download pending safety verification/);assert.match(html,/19 bytes/);
  assert.doesNotMatch(html,/<a(?:\s|>)|must-not-disclose|example.invalid/);
});
test('health profile exposes the six agreed fields as escaped history',()=>{
  const html=renderToStaticMarkup(React.createElement(ImportedMedicalHistory,{records:[],healthProfile:{updatedAt:'2026-01-01T00:00:00Z',content:{
    blood_group:'O+',genotype:'AA',allergies:['<script>unsafe</script>'],medical_notes:'Synthetic note',secret:'must-not-show'}}}));
  assert.match(html,/Preserved health profile/);assert.match(html,/O\+/);assert.match(html,/Synthetic note/);
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|must-not-show/);
});
test('clean file has a download action while an infected file stays blocked',()=>{
  const files=[{...record.files[0],accessStatus:'available'},{...record.files[0],id:'synthetic-infected',accessStatus:'rejected'}];
  const html=renderToStaticMarkup(React.createElement(ImportedMedicalHistory,{records:[{...record,files}],onDownload:async()=>({url:'https://example.invalid',expiresInSeconds:60})}));
  assert.match(html,/<button[^>]*>Download<\/button>/);assert.match(html,/blocked by safety verification/);
  assert.doesNotMatch(html,/example.invalid/);
});
