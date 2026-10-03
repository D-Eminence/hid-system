// Invented data only; no fixture extracted from customer systems.
import { randomUUID } from 'node:crypto';
import { canonicalJson,sha256 } from './staging-cutover-additions.mjs';
import { CUSTOMER_SOURCE_TABLES,HEALTH_FIELDS } from './customer-source-tables.mjs';
export function syntheticMedicalSource() {
  const accountId=randomUUID(), providerId=randomUUID(), patientId=randomUUID(), profileId=randomUUID(), providerProfile=randomUUID(),staffId=randomUUID();
  const time='2026-01-01T00:00:00.000Z';
  const collections={accounts:[{id:accountId},{id:providerId}],patients:[{id:patientId,auth_user_id:accountId,user_profile_id:profileId,updated_at:time,
    nin_ciphertext:null,nin_hash:null,...Object.fromEntries(HEALTH_FIELDS.map(k=>[k,null])),allergies:['Synthetic pollen'],blood_group:'O+'}],
    user_profiles:[{id:profileId,auth_user_id:accountId,app_role:'patient'},{id:providerProfile,auth_user_id:providerId,app_role:'org_admin'}],
    staff:[{id:staffId,auth_user_id:providerId,user_profile_id:providerProfile}],medical_records:[],medical_record_versions:[],medical_record_files:[]};
  for (let n=0;n<17;n++) {
    const recordId=randomUUID(),versionId=randomUUID();
    const author=n===16 ? providerProfile : profileId;
    const staff=n===16 ? staffId : null;
    collections.medical_records.push({id:recordId,patient_id:patientId,current_version_id:versionId,title:'Synthetic medical history',
      category:'history',info_type:'text',created_by_user_profile_id:author,created_by_staff_account_id:staff,created_at:time,updated_at:time});
    collections.medical_record_versions.push({id:versionId,record_id:recordId,version_no:1,created_by_user_profile_id:author,
      created_by_staff_account_id:staff,record:'Invented clinical content for testing.',notes:null,structured_data:{synthetic:true},transcription_text:null,created_at:time});
    if(n<4) collections.medical_record_files.push({id:randomUUID(),patient_id:patientId,record_id:recordId,record_version_id:versionId,
      uploaded_by_user_profile_id:profileId,original_file_name:'synthetic.txt',mime_type:'text/plain',size_bytes:19,sha256_hex:null,
      storage_bucket:'synthetic-private',storage_path:`synthetic/${n}`,created_at:time});
  }
  for(const t of CUSTOMER_SOURCE_TABLES.filter(t=>['canonical','imported-history'].includes(t.disposition)&&t.category!=='notifications')) collections[t.category]??=[];
  return sealMedicalSource(collections);
}
export function sealMedicalSource(collections) {
  const rows=[],counts={},checksums={};
  for(const [type,payloads] of Object.entries(collections)) {
    const group=payloads.map(payload=>({entity_type:type,source_pk:payload.id,payload,payload_sha256:sha256(canonicalJson(payload))})).sort((a,b)=>a.source_pk.localeCompare(b.source_pk));
    rows.push(...group);counts[type]=group.length;checksums[type]=sha256(group.map(r=>`${r.source_pk}:${r.payload_sha256}\n`).join(''));
  }
  const checksum=sha256(canonicalJson({counts,checksums}));
  return {collections,rows,counts,checksums,checksum,evidence:{sourceCounts:counts,sourceChecksum:checksum}};
}
