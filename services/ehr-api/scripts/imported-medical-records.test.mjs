import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMedicalImport } from './imported-medical-records.mjs';
import { syntheticMedicalSource,sealMedicalSource } from './medical-import-fixture.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const prepare=s=>prepareMedicalImport(s.rows,s.evidence,s.checksum);
test('CLI rejects production and conflicting modes before any database connection',()=>{
  const script=fileURLToPath(new URL('./import-staging-medical-records.mjs',import.meta.url));
  for(const [environment,args,message] of [['production',['--dry-run'],/staging-only/],['staging',['--dry-run','--apply'],/Choose/]]) {
    assert.throws(()=>execFileSync(process.execPath,[script,...args],{env:{...process.env,HID_DEPLOYMENT_ENV:environment},encoding:'utf8',stdio:['ignore','pipe','pipe']}),error=>{
      assert.match(String(error.stderr),message);return true;
    });
  }
});
test('preserves 17 records, all 17 versions/four file links and distinct authorship',()=>{
  const s=syntheticMedicalSource(),p=prepare(s);
  assert.deepEqual([p.records.length,p.versions.length,p.files.length],[17,17,4]);
  assert.equal(p.records.filter(r=>r.author.origin==='patient-provided').length,16);
  assert.equal(p.records.filter(r=>r.author.origin==='provider-authored').length,1);
  assert.equal(p.records[0].row.payload,s.collections.medical_records.find(r=>r.id===p.records[0].row.source_pk));
});
test('rejects altered bytes, omitted categories and substituted parent seal',()=>{
  let s=syntheticMedicalSource();s.rows[0].payload.extra='changed';assert.throws(()=>prepare(s),/checksum/);
  s=syntheticMedicalSource();delete s.collections.medical_record_versions;s=sealMedicalSource(s.collections);assert.throws(()=>prepare(s),/category/);
  s=syntheticMedicalSource();assert.throws(()=>prepareMedicalImport(s.rows,s.evidence,'a'.repeat(64)),/checksum/);
});
test('rejects cross-patient files, wrong current versions and ambiguous provider authors',()=>{
  for(const mutate of [
    c=>{c.medical_record_files[0].patient_id=c.accounts[0].id;},
    c=>{c.medical_records[0].current_version_id=c.medical_records[1].current_version_id;},
    c=>{c.staff[0].user_profile_id=c.user_profiles[0].id;},
    c=>{c.medical_record_versions[0].version_no=0;},
  ]){const s=syntheticMedicalSource();mutate(s.collections);assert.throws(()=>prepare(sealMedicalSource(s.collections)));}
});
test('retains historical revisions and rejects duplicate version numbers',()=>{
  const s=syntheticMedicalSource(),old=s.collections.medical_record_versions[0];
  s.collections.medical_record_versions.push({...old,id:s.collections.accounts[0].id,version_no:2,record:'Synthetic second revision'});
  assert.equal(prepare(sealMedicalSource(s.collections)).versions.length,18);
  s.collections.medical_record_versions.at(-1).version_no=1;
  assert.throws(()=>prepare(sealMedicalSource(s.collections)),/Version binding/);
});
