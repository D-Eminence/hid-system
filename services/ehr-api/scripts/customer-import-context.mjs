import {createDecipheriv} from 'node:crypto';
import {canonicalJson,sha256,validateSealedSource} from './staging-cutover-additions.mjs';
import {assertExactImportedRow} from './imported-medical-records.mjs';
export async function verifiedParent(client,parentId,checksum){
  const parent=(await client.query('select * from migration.runs where id=$1 for share',[parentId])).rows[0];
  if(!parent||parent.source_system!=='legacy_identity'||parent.mode!=='reconcile'||parent.status!=='verified'
    ||parent.target_checksum_sha256?.trim()!==checksum) throw new Error('Verified reconciled parent seal required');
  if((await client.query('select count(*)::int n from migration.conflicts where run_id=$1',[parentId])).rows[0].n) throw new Error('Parent conflicts are unresolved');
  const rows=(await client.query('select entity_type,source_pk,payload,payload_sha256 from migration.source_rows where run_id=$1',[parentId])).rows;
  const sealed=validateSealedSource(rows,{sourceCounts:parent.source_counts,sourceChecksum:parent.source_checksum_sha256?.trim()},checksum);
  const reconciliations=(await client.query('select * from migration.entity_reconciliations where run_id=$1',[parentId])).rows;
  for(const [type,count] of Object.entries(sealed.counts)){
    const r=reconciliations.find(r=>r.entity_type===type);
    if(!r||Number(r.source_count)!==count||Number(r.target_count)!==count||r.source_checksum_sha256.trim()!==sealed.checksums[type]
      ||r.target_checksum_sha256.trim()!==sealed.checksums[type]) throw new Error('Parent category reconciliation differs');
  }
  return {parent,rows,...sealed};
}
export async function verifyClinicalQuarantine(client,{parentId,patientId,coordinate,aadCoordinate=coordinate,payload,fieldKey,keyReference}){
  const q=(await client.query('select * from migration.legacy_clinical_quarantine where run_id=$1 and patient_id=$2 and source_record_id=$3',[parentId,patientId,coordinate])).rows[0];
  const plaintext=canonicalJson(payload);let matches=false;
  try{
    const value=q?.encrypted_payload;
    if(Buffer.isBuffer(value)&&value.length>=30&&value[0]===1){
      const cipher=createDecipheriv('aes-256-gcm',fieldKey,value.subarray(1,13));
      cipher.setAAD(Buffer.from(`${parentId}:${patientId}:${aadCoordinate}`));cipher.setAuthTag(value.subarray(13,29));
      matches=q.encryption_key_reference===keyReference&&q.payload_sha256.trim()===sha256(plaintext)
        &&Buffer.concat([cipher.update(value.subarray(29)),cipher.final()]).toString('utf8')===plaintext;
    }
  }catch{/* Never print decrypted content or errors containing row values. */}
  if(!matches) throw new Error('Encrypted clinical preservation evidence differs');
}
const targets=new Set(['ehr.imported_patient_health_profiles','ehr.imported_attachment_bindings','ehr.imported_attachment_scan_events',
  'notification.imported_inbox_items','platform.imported_customer_configuration','platform.imported_configuration_mappings','migration.customer_table_dispositions']);
export async function insertExactCustomerRow(client,table,expected,keys){
  if(!targets.has(table)||!keys.every(k=>Object.hasOwn(expected,k))) throw new Error('Unsupported customer import target');
  const columns=Object.keys(expected);
  if(columns.some(k=>!/^[a-z][a-z0-9_]*$/.test(k))) throw new Error('Unsupported customer import column');
  const values=Object.values(expected).map(v=>v&&typeof v==='object'&&!Buffer.isBuffer(v)?JSON.stringify(v):v);
  await client.query(`insert into ${table}(${columns.join(',')}) values(${columns.map((_,i)=>`$${i+1}`).join(',')}) on conflict do nothing`,values);
  const where=keys.map((key,i)=>`${key}=$${i+1}`).join(' and ');
  assertExactImportedRow((await client.query(`select * from ${table} where ${where}`,keys.map(k=>expected[k]))).rows[0],expected);
}
