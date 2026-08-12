import React, { useEffect, useMemo, useState } from 'react';
import { clinicalApi } from '@/api/client';
import { getSafeClinicalErrorMessage } from '@/api/errors';
import type { ClinicalRecordKind, ClinicalRecordSummary } from '@/api/contracts';
import { Badge, Button, Card, SectionHeader } from '@/components/ui/Primitives';

interface ClinicalTimelineProps {
  patientId: string;
  encounterId: string;
  permissions: readonly string[];
  refreshToken: number;
}

const readableKinds: ReadonlyArray<{ kind: ClinicalRecordKind; permission: string; label: string }> = [
  { kind: 'note', permission: 'ehr.note.read', label: 'Note' },
  { kind: 'vitals', permission: 'ehr.vital.read', label: 'Vitals' },
  { kind: 'diagnosis', permission: 'ehr.diagnosis.read', label: 'Diagnosis' },
  { kind: 'prescription', permission: 'ehr.prescription.read', label: 'Prescription' },
  { kind: 'lab', permission: 'ehr.lab-request.read', label: 'Lab request' },
];

const formatDateTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString();
};

export const ClinicalTimeline: React.FC<ClinicalTimelineProps> = ({
  patientId,
  encounterId,
  permissions,
  refreshToken,
}) => {
  const kinds = useMemo(
    () => readableKinds.filter((item) => permissions.includes(item.permission)),
    [permissions],
  );
  const [records, setRecords] = useState<ClinicalRecordSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [manualRefresh, setManualRefresh] = useState(0);

  useEffect(() => {
    if (kinds.length === 0) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all(kinds.map(({ kind }) => clinicalApi.listRecords(patientId, encounterId, kind, controller.signal)))
      .then((pages) => {
        setRecords(
          pages
            .flatMap((page) => page.items)
            .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt)),
        );
      })
      .catch((cause: unknown) => {
        const message = getSafeClinicalErrorMessage(cause);
        if (message) setError(message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [encounterId, kinds, manualRefresh, patientId, refreshToken]);

  if (kinds.length === 0) return null;

  return (
    <Card pad>
      <SectionHeader
        title="Encounter clinical timeline"
        sub="Only record types permitted by the verified session are loaded."
        action={<Button variant="secondary" size="sm" icon="refresh" onClick={() => setManualRefresh((value) => value + 1)} disabled={loading}>Refresh</Button>}
      />
      {loading && <p role="status" style={{ color: 'var(--text-secondary)', marginTop: 'var(--space-400)' }}>Loading authorized clinical records…</p>}
      {error && <div role="alert" style={{ color: 'var(--danger-600)', marginTop: 'var(--space-400)' }}>{error}</div>}
      {!loading && !error && records.length === 0 && (
        <p style={{ color: 'var(--text-secondary)', marginTop: 'var(--space-400)' }}>No clinical records have been added to this encounter.</p>
      )}
      {!loading && records.length > 0 && (
        <div className="ehr-clinical-timeline" style={{ marginTop: 'var(--space-400)' }}>
          {records.map((record) => (
            <article key={`${record.kind}:${record.id}`} className="ehr-clinical-timeline-item">
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-200)' }}>
                  <strong style={{ color: 'var(--text-heading)' }}>{record.title}</strong>
                  <Badge variant="neutral">{readableKinds.find((item) => item.kind === record.kind)?.label ?? record.kind}</Badge>
                  {record.status && <Badge variant="blue">{record.status.replace('_', ' ')}</Badge>}
                </div>
                <div style={{ color: 'var(--text-body)', marginTop: 4 }}>{record.detail}</div>
              </div>
              <time dateTime={record.occurredAt} style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)', whiteSpace: 'nowrap' }}>
                {formatDateTime(record.occurredAt)}
              </time>
            </article>
          ))}
        </div>
      )}
    </Card>
  );
};
