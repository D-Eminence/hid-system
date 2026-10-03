import {canonicalJson,sha256,validateSealedSource} from './staging-cutover-additions.mjs';
import {CUSTOMER_SOURCE_TABLES,HEALTH_FIELDS,CONFIGURATION_CATEGORIES} from './customer-source-tables.mjs';
export const validUuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
export function clinicalPayload(patient){
  if(HEALTH_FIELDS.some(key=>!Object.hasOwn(patient,key))) throw new Error('Patient clinical source columns are missing');
  return Object.fromEntries(HEALTH_FIELDS.map(key=>[key,patient[key]??null]));
}
export function prepareCustomerSource(bundle,expectedHash){
  if(bundle.schema!=='hid.customer-source/v1'||!bundle.snapshot_id||!bundle.transaction_snapshot) throw new Error('Customer source snapshot metadata is required');
  const sealed=validateSealedSource(bundle.rows,{sourceCounts:bundle.counts,sourceChecksum:bundle.checksum},expectedHash);
  for(const table of CUSTOMER_SOURCE_TABLES){
    const rows=sealed.grouped.get(table.category);
    if(!rows||bundle.inventory?.[table.table]!==rows.length) throw new Error('Source table inventory is incomplete');
    for(const row of rows) if(String(row.payload[table.pk])!==row.source_pk) throw new Error('Source primary coordinate differs');
  }
  for(const [table,count] of Object.entries(bundle.inventory??{})) if(count>0&&!CUSTOMER_SOURCE_TABLES.some(t=>t.table===table)) throw new Error('An additional populated source table requires a disposition');
  const profiles=new Map(sealed.grouped.get('user_profiles').map(row=>[row.source_pk,row.payload]));
  const patients=new Map(sealed.grouped.get('patients').map(row=>[row.source_pk,row.payload]));
  for(const row of sealed.grouped.get('notifications')){
    const p=row.payload,profile=profiles.get(p.user_profile_id);
    if(!validUuid(p.id)||!profile||!validUuid(profile.auth_user_id)||(p.patient_id!=null&&!patients.has(p.patient_id))
      ||typeof p.title!=='string'||typeof p.message!=='string'||typeof p.type!=='string'||!validTime(p.created_at)
      ||(p.read_at!=null&&!validTime(p.read_at))) throw new Error('Notification source association/content is invalid');
    // A recipient may receive a notification about a patient under the legacy
    // contract. Recipient ownership is explicit; never infer it from patient_id.
  }
  for(const row of sealed.grouped.get('patients')) if(!validUuid(row.payload.id)||!validTime(row.payload.updated_at)) throw new Error('Patient source coordinate/time is invalid');
  for(const category of CONFIGURATION_CATEGORIES) for(const row of sealed.grouped.get(category)){
    if(!row.payload||typeof row.payload!=='object'||Array.isArray(row.payload)) throw new Error('Configuration payload is invalid');
    if(category==='commercial_prices'&&!sealed.grouped.get('commercial_products').some(p=>p.source_pk===row.payload.product_id)) throw new Error('Commercial product/price relationship is unresolved');
  }
  ninCoverage(sealed.grouped.get('patients'));
  return sealed;
}
export function sealCustomerSource(snapshotId,transactionSnapshot,inventory,rows){
  const counts={},checksums={};
  for(const {category} of CUSTOMER_SOURCE_TABLES){
    const group=rows.filter(r=>r.entity_type===category).sort((a,b)=>a.source_pk.localeCompare(b.source_pk));
    counts[category]=group.length;checksums[category]=sha256(group.map(r=>`${r.source_pk}:${r.payload_sha256}\n`).join(''));
  }
  return {schema:'hid.customer-source/v1',snapshot_id:snapshotId,transaction_snapshot:transactionSnapshot,inventory,rows,counts,
    checksum:sha256(canonicalJson({counts,checksums}))};
}
export function ninCoverage(patients){
  let exact=0,absent=0;
  for(const row of patients){
    const p=row.payload??row;
    if(!Object.hasOwn(p,'nin_ciphertext')||!Object.hasOwn(p,'nin_hash')) throw new Error('NIN source columns are missing; absence cannot be inferred');
    const cipher=p.nin_ciphertext!=null&&p.nin_ciphertext!=='';
    const hash=p.nin_hash!=null&&p.nin_hash!=='';
    if(cipher!==hash) throw new Error('NIN source evidence is partial');
    if(cipher) exact++;else absent++;
  }
  return {patients:patients.length,with_source_nin:exact,absent_in_snapshot:absent,alternate_source_attestation:'required',final_delta:'required'};
}
