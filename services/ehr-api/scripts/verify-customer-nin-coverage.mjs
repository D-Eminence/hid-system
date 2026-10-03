#!/usr/bin/env node
// Reports counts only. Never prints NINs, ciphertexts, hashes or patient IDs.
import {readFile} from 'node:fs/promises';
import {ninCoverage,validUuid} from './customer-data-validation.mjs';
import {sha256} from './staging-cutover-additions.mjs';
const [sourcePath,expectedSha256,attestationPath]=process.argv.slice(2);
try{
  if(!sourcePath||!/^[a-f0-9]{64}$/.test(expectedSha256??'')) throw new Error('Protected source and exact SHA-256 are required');
  const bytes=await readFile(sourcePath);if(sha256(bytes)!==expectedSha256) throw new Error('NIN source bytes differ');
  const source=JSON.parse(bytes),patients=source.rows?source.rows.filter(r=>r.entity_type==='patients'):source.patients;
  if(!Array.isArray(patients)||patients.length!==123) throw new Error('All 123 source patients must be covered');
  const ids=patients.map(row=>(row.payload??row).id);
  if(ids.some(id=>!validUuid(id))||new Set(ids).size!==123) throw new Error('NIN coverage requires 123 unique source patient coordinates');
  const coverage=ninCoverage(patients);
  if(attestationPath){
    const a=JSON.parse(await readFile(attestationPath,'utf8'));
    if(a.schema!=='hid.nin-coverage-attestation/v1'||a.source_sha256!==expectedSha256||a.patient_count!==123
      ||typeof a.confirmed_by!=='string'||a.confirmed_by.length<3||!Number.isFinite(Date.parse(a.confirmed_at))
      ||Date.parse(a.confirmed_at)>Date.now()||!Array.isArray(a.sources_checked)||a.sources_checked.length===0
      ||a.alternate_source_has_additional_nins!==false) throw new Error('Authoritative alternate-source attestation is incomplete');
    coverage.alternate_source_attestation='confirmed no additional NINs';
  }
  console.log(JSON.stringify(coverage));
}catch(error){process.stderr.write(error.code?'NIN coverage verification failed privately.\n':error.message+'\n');process.exitCode=1;}
