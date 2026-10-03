import { useEffect, useState } from 'react';
import { clinicalApi } from '@/api/client';
import { getSafeClinicalErrorMessage } from '@/api/errors';
import type { ImportedMedicalRecord, ImportedHealthProfile } from '../../../../../packages/api-client/src/imported-records';
import { ImportedMedicalHistory } from '../../../../../packages/ui/src/ImportedMedicalHistory';

export function ImportedHistory({patientId,permissions}: {patientId: string; permissions: readonly string[]}) {
  const [records,setRecords] = useState<ImportedMedicalRecord[]>([]);
  const [healthProfile,setHealthProfile] = useState<ImportedHealthProfile | null>(null);
  const [error,setError] = useState('');
  const [loading,setLoading] = useState(true);
  const allowed = permissions.includes('ehr.note.read');
  useEffect(() => {
    const controller = new AbortController();
    setRecords([]); setHealthProfile(null); setError(''); setLoading(true);
    if (allowed) void clinicalApi.importedHistory(patientId,controller.signal)
      .then(value => { if (!controller.signal.aborted) { setRecords(value.records); setHealthProfile(value.healthProfile); } })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(getSafeClinicalErrorMessage(reason) || 'Imported history could not be loaded.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  },[patientId,allowed]);
  if (!allowed) return null;
  if (error) return <p role="alert">{error}</p>;
  if (loading) return <p role="status">Loading imported history…</p>;
  return <ImportedMedicalHistory key={patientId} records={records} healthProfile={healthProfile}
    onDownload={permissions.includes('ehr.document.read') ? fileId => clinicalApi.importedAttachment(patientId,fileId) : undefined}/>;
}
