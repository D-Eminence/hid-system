import type { PoolClient } from 'pg';

/** Portable source history: consent is patient/facility scoped by RLS, not an
 * invented originating encounter. Raw preservation payloads are never exposed. */
export async function readImportedRecords(client: PoolClient, patientId: string) {
  const result = await client.query(`select r.id,r.origin,r.current_version_id as "currentVersionId",
    r.source_payload->>'title' as title,r.source_payload->>'category' as category,
    r.source_payload->>'info_type' as "infoType",r.source_created_at as "createdAt",r.source_updated_at as "updatedAt",
    coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'versionNo',v.version_no,'origin',v.origin,
      'createdAt',v.source_created_at,'record',v.source_payload->'record','notes',v.source_payload->'notes',
      'structuredData',v.source_payload->'structured_data','transcriptionText',v.source_payload->'transcription_text')
      order by v.version_no desc) from ehr.imported_medical_record_versions v
      where v.record_id=r.id and v.patient_id=r.patient_id),'[]'::jsonb) as versions,
    coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'recordVersionId',f.record_version_id,
      'fileName',f.source_payload->>'original_file_name','mediaType',f.source_payload->>'mime_type',
      'sizeBytes',f.source_payload->'size_bytes','createdAt',f.source_created_at,
      'accessStatus',case when s.result='clean' then 'available' when s.result='infected' then 'rejected' else 'pending-safety-verification' end) order by f.source_created_at,f.id)
      from ehr.imported_medical_record_files f
      left join ehr.imported_attachment_bindings b on b.file_id=f.id and b.patient_id=f.patient_id
      left join lateral(select result from ehr.imported_attachment_scan_events
        where file_id=b.file_id and patient_id=b.patient_id and sha256_hex=b.sha256_hex and object_version_id=b.object_version_id
        order by sequence_id desc limit 1) s on true
      where f.record_id=r.id and f.patient_id=r.patient_id),'[]'::jsonb) as files
    from ehr.imported_medical_records r where r.patient_id=$1
    order by r.source_created_at desc,r.id desc limit 50`,[patientId]);
  return result.rows;
}

export async function readImportedHealthProfile(client: PoolClient, patientId: string) {
  const result = await client.query(`select clinical_payload as content,source_updated_at as "updatedAt"
    from ehr.imported_patient_health_profiles where patient_id=$1 limit 1`, [patientId]);
  return result.rows[0] ?? null;
}
