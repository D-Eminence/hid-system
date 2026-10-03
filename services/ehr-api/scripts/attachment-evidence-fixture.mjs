// SYNTHETIC ONLY. This does not scan a file and must never be used as live evidence.
import {canonicalJson,sha256} from './staging-cutover-additions.mjs';
export function syntheticAttachmentEvidence(source,parentSnapshot){
  const now=new Date().toISOString(),bucket='hid-staging-documents-synthetic';
  const manifest={fixture_sha256:'a'.repeat(64),fixture_snapshot_id:parentSnapshot,source_snapshot_id:'synthetic-snapshot',files:source.collections.medical_record_files.map(p=>({
    source_file_id:p.id,destination_key:`migration-quarantine/synthetic-snapshot/medical-files/${p.id}`,destination_version_id:`synthetic-${p.id}`,size_bytes:p.size_bytes,sha256:'b'.repeat(64)}))};
  const manifestSha256=sha256(canonicalJson(manifest)),manifestVersionId='synthetic-manifest';
  const files=manifest.files.map(f=>{const s={file_id:f.source_file_id,key:f.destination_key,version_id:f.destination_version_id,sha256:f.sha256,size_bytes:f.size_bytes,
    scanner:'clamav',scanner_version:'synthetic-only',signatures_version:'synthetic-only',scanner_binary_sha256:'c'.repeat(64),signatures_updated_at:now,
    scanned_at:now,result:'clean',detected_media_type:'application/octet-stream',scanner_output_sha256:'d'.repeat(64)};return {...s,report_sha256:sha256(canonicalJson(s))};});
  const report={schema:'hid.imported-attachment-scan/v1',manifest_sha256:manifestSha256,manifest_version_id:manifestVersionId,bucket,files};
  return {manifest,report,manifestSha256,manifestVersionId,bucket,fixtureSha256:manifest.fixture_sha256};
}
