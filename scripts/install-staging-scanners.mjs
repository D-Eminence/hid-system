// Official release archives, pinned by SHA256; no external scanner Actions.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import path from 'node:path';
if(process.platform!=='linux'||process.arch!=='arm64') throw Error('ARM64 Linux scanner runner required');
const tools = [
  {name:'syft',version:'1.54.0',sha256:'ee6d4566373a05b344bc6b5f1706f14419bf9338ba39ff686e247deefe9b8818'},
  {name:'grype',version:'0.120.0',sha256:'bc0e52b1a0de37e2ff021c4924d689dce7dcff2e7d74b39aea16c0453e69be18'},
];
const directory=path.join(process.env.RUNNER_TEMP??process.cwd(),'hid-staging-scanners');
await mkdir(directory,{recursive:true});
for(const tool of tools){
  const filename=`${tool.name}_${tool.version}_linux_arm64.tar.gz`;
  const url=`https://github.com/anchore/${tool.name}/releases/download/v${tool.version}/${filename}`;
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error('Official scanner download failed');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(createHash('sha256').update(bytes).digest('hex')!==tool.sha256)throw Error('Scanner archive checksum mismatch');
  const archive=path.join(directory,filename);await writeFile(archive,bytes,{flag:'wx'});
  execFileSync('tar',['-xzf',archive,'-C',directory,tool.name],{stdio:'inherit'});
  console.log(`Verified ${tool.name} ${tool.version}`);
}
if(process.env.GITHUB_PATH)await appendFile(process.env.GITHUB_PATH,directory+'\n');
