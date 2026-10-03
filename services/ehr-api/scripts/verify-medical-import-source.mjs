#!/usr/bin/env node
// Read-only protected local fixture validation; only aggregate output.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalJson,sha256 } from './staging-cutover-additions.mjs';
import { prepareMedicalImport } from './imported-medical-records.mjs';
const [fixturePath,manifestPath]=process.argv.slice(2);
if(!fixturePath || !manifestPath) throw new Error('Protected fixture and metadata manifest paths required');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const bytes=await readFile(fixturePath);
if(bytes.length!==manifest.size_bytes || createHash('sha256').update(bytes).digest('hex')!==manifest.sha256) throw new Error('Fixture byte integrity mismatch');
const fixture=JSON.parse(bytes),rows=[];
for(const type of Object.keys(manifest.counts)) for(const row of fixture[type]??[]) rows.push({entity_type:type,source_pk:row.source_pk,payload:row.payload,payload_sha256:sha256(canonicalJson(row.payload))});
const p=prepareMedicalImport(rows,{sourceCounts:manifest.counts,sourceChecksum:manifest.overall_checksum},manifest.overall_checksum);
process.stdout.write(JSON.stringify({status:'passed',snapshot_id:manifest.snapshot_id,records:p.records.length,versions:p.versions.length,files:p.files.length,
  patient_authored:p.records.filter(r=>r.author.origin==='patient-provided').length,provider_authored:p.records.filter(r=>r.author.origin==='provider-authored').length,
  database_mutated:false,attachment_access:'pending binding and clean scan'})+'\n');
