import {canonicalJson,sha256} from './staging-cutover-additions.mjs';
import {validUuid,validTime} from './customer-data-validation.mjs';
export function scannerVersion(output,now=Date.now()){
  const match=/^ClamAV ([^/\r\n]+)\/(\d+)\/(.+)$/.exec(output.trim());
  if(!match||!Number.isFinite(Date.parse(match[3]))) throw new Error('ClamAV version/signature metadata is unavailable');
  const updated=Date.parse(match[3]);
  if(updated>now||now-updated>24*60*60*1000) throw new Error('ClamAV signatures must be current within 24 hours');
  return {scanner:'clamav',scanner_version:match[1],signatures_version:match[2],signatures_updated_at:new Date(updated).toISOString()};
}
export function detectedType(bytes){
  if(bytes.subarray(0,5).toString('ascii')==='%PDF-') return 'application/pdf';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if(bytes.length>2&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255) return 'image/jpeg';
  return 'application/octet-stream'; // Never execute source-declared HTML/SVG.
}
export function classifyScan(status,stdout,stderr){
  if(status===0&&stderr.trim()===''&&/: OK\s*$/.test(stdout.trim())&&!/ERROR|WARNING|SKIPPED|FOUND/i.test(stdout)) return 'clean';
  if(status===1&&/ FOUND\s*$/m.test(stdout)) return 'infected';
  return 'error';
}
export function validateAttachmentEvidence(manifest,report,{manifestSha256,manifestVersionId,bucket,fixtureSha256,sourceFiles,now=Date.now()}){
  if(!/^[a-f0-9]{64}$/.test(manifestSha256??'')||!manifestVersionId||manifestVersionId==='null'
    ||!/^hid-staging-documents-[a-z0-9]+$/.test(bucket??'')||manifest.fixture_sha256!==fixtureSha256
    ||report.schema!=='hid.imported-attachment-scan/v1'||report.manifest_sha256!==manifestSha256
    ||report.manifest_version_id!==manifestVersionId||report.bucket!==bucket
    ||!Array.isArray(manifest.files)||!Array.isArray(report.files)) throw new Error('Attachment manifest/report provenance differs');
  if(manifest.files.length!==sourceFiles.length||report.files.length!==sourceFiles.length) throw new Error('Attachment evidence does not cover every source file');
  const seen=new Set(),scans=new Map(report.files.map(f=>[f.file_id,f]));
  if(scans.size!==report.files.length) throw new Error('Duplicate attachment scan coordinate');
  return manifest.files.map(f=>{
    const row=sourceFiles.find(r=>r.source_pk===f.source_file_id),p=row?.payload,s=scans.get(f.source_file_id);
    if(!validUuid(f.source_file_id)||seen.has(f.source_file_id)||!p||!s
      ||f.destination_key!==`migration-quarantine/${manifest.source_snapshot_id}/medical-files/${f.source_file_id}`
      ||!f.destination_version_id||f.destination_version_id==='null'||!Number.isSafeInteger(f.size_bytes)||f.size_bytes<1||f.size_bytes>20*1024*1024
      ||f.size_bytes!==p.size_bytes||!/^[a-f0-9]{64}$/.test(f.sha256??'')||(p.sha256_hex&&p.sha256_hex.toLowerCase()!==f.sha256)
      ||s.key!==f.destination_key||s.version_id!==f.destination_version_id||s.sha256!==f.sha256||s.size_bytes!==f.size_bytes
      ||s.scanner!=='clamav'||!s.scanner_version||!s.signatures_version||!/^[a-f0-9]{64}$/.test(s.scanner_binary_sha256??'')
      ||!validTime(s.scanned_at)||!validTime(s.signatures_updated_at)||Date.parse(s.scanned_at)>now
      ||Date.parse(s.scanned_at)<now-24*60*60*1000||Date.parse(s.signatures_updated_at)>Date.parse(s.scanned_at)
      ||Date.parse(s.scanned_at)-Date.parse(s.signatures_updated_at)>24*60*60*1000
      ||!['clean','infected','error'].includes(s.result)||!['application/pdf','image/png','image/jpeg','application/octet-stream'].includes(s.detected_media_type)
      ||s.report_sha256!==sha256(canonicalJson(Object.fromEntries(Object.entries(s).filter(([key])=>key!=='report_sha256'))))) throw new Error('Attachment scan/object evidence differs or is stale');
    seen.add(f.source_file_id);return {file:f,source:row,scan:s};
  });
}
