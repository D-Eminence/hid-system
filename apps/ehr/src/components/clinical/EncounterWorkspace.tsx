import React, { useEffect, useState } from 'react';
import { clinicalApi } from '@/api/client';
import { getSafeClinicalErrorMessage } from '@/api/errors';
import type { CreateEncounterInput, EncounterRecord } from '@/api/contracts';
import type { Patient } from '@/types/ehr.types';
import type { EhrStaffRole } from '@/types/ehr.types';
import { Badge, Button, Card, Field, Input, PageHead, SectionHeader, Select, Textarea } from '@/components/ui/Primitives';
import { ClinicalForms } from './ClinicalForms';
import { useClinicalSubmit } from './useClinicalSubmit';
import { WorkflowRail } from './WorkflowRail';

interface EncounterWorkspaceProps {
  patient: Patient;
  role: EhrStaffRole;
  permissions: readonly string[];
  onBack: () => void;
}

const localDateTime = (): string => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const canAddRecords = (encounter: EncounterRecord): boolean =>
  encounter.status === 'planned' || encounter.status === 'in_progress' || encounter.status === 'on_hold';

const formatDateTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
};

interface EncounterFormState {
  encounterType: CreateEncounterInput['encounterType'];
  status: 'planned' | 'in_progress';
  startedAt: string;
  chiefComplaint: string;
}

export const EncounterWorkspace: React.FC<EncounterWorkspaceProps> = ({ patient, role, permissions, onBack }) => {
  const patientId = patient.patientId;
  const [encounters, setEncounters] = useState<EncounterRecord[]>([]);
  const [selected, setSelected] = useState<EncounterRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadRequest, setLoadRequest] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const initialForm: EncounterFormState = { encounterType: 'ambulatory', status: 'in_progress', startedAt: localDateTime(), chiefComplaint: '' };
  const [form, setForm] = useState<EncounterFormState>(initialForm);
  const [localError, setLocalError] = useState('');
  const canCreateEncounter = permissions.includes('ehr.encounter.write');
  const submitState = useClinicalSubmit((input: CreateEncounterInput, key) => {
    if (!patientId) return Promise.reject(new Error('Canonical patient identifier is missing.'));
    return clinicalApi.createEncounter(patientId, input, key);
  });

  useEffect(() => {
    if (!patientId) {
      setLoadError('Canonical patient identity is missing. Return to patient lookup.');
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    clinicalApi.listEncounters(patientId, controller.signal)
      .then((page) => setEncounters(page.items))
      .catch((error: unknown) => {
        const message = getSafeClinicalErrorMessage(error);
        if (message) setLoadError(message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [patientId, loadRequest]);

  const createEncounter = async (event: React.FormEvent) => {
    event.preventDefault();
    const startedAt = new Date(form.startedAt);
    if (Number.isNaN(startedAt.getTime())) {
      setLocalError('Enter a valid encounter start time.');
      return;
    }
    setLocalError('');
    const input: CreateEncounterInput = {
      encounterType: form.encounterType,
      status: form.status,
      startedAt: startedAt.toISOString(),
      chiefComplaint: form.chiefComplaint.trim() || undefined,
    };
    const created = await submitState.submit(input);
    if (created) {
      setEncounters((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setSelected(created);
      setShowCreate(false);
      setForm({ ...initialForm, startedAt: localDateTime() });
    }
  };

  if (!patientId) {
    return (
      <div className="fade-in">
        <PageHead title="Encounter Workspace" sub="Canonical identity required" actions={<Button variant="secondary" icon="arrowLeft" onClick={onBack}>Back</Button>} />
        <Card pad><div role="alert" style={{ color: 'var(--danger-600)' }}>Canonical patient identity is missing. No clinical request was made.</div></Card>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-500)' }}>
      <WorkflowRail active={selected ? 'records' : 'encounter'} />
      <PageHead
        title="Encounter Workspace"
        sub={`${patient.fullName} • ${patient.hid} • ${role.label}`}
        actions={<Button variant="secondary" icon="arrowLeft" onClick={onBack}>Back to Patient Lookup</Button>}
      />

      {!selected && (
        <Card pad>
          <SectionHeader
            title="Select an encounter"
            action={canCreateEncounter ? <Button variant="primary" icon="plus" onClick={() => setShowCreate((value) => !value)}>{showCreate ? 'Cancel' : 'New Encounter'}</Button> : undefined}
          />

          {showCreate && (
            <form onSubmit={createEncounter} style={{ marginTop: 'var(--space-500)', display: 'flex', flexDirection: 'column', gap: 'var(--space-400)', paddingBottom: 'var(--space-500)', borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="ehr-grid-2">
                <Field label="Encounter type" required>
                  <Select value={form.encounterType} onChange={(e) => setForm({ ...form, encounterType: e.target.value as CreateEncounterInput['encounterType'] })} options={['ambulatory', 'emergency', 'inpatient', 'home', 'virtual', 'other'].map((value) => ({ value, label: value.replace('_', ' ') }))} />
                </Field>
                <Field label="Initial status" required>
                  <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'planned' | 'in_progress' })} options={[{ value: 'in_progress', label: 'In progress' }, { value: 'planned', label: 'Planned' }]} />
                </Field>
              </div>
              <Field label="Started at" required><Input type="datetime-local" value={form.startedAt} onChange={(e) => setForm({ ...form, startedAt: e.target.value })} /></Field>
              <Field label="Chief complaint"><Textarea value={form.chiefComplaint} onChange={(e) => setForm({ ...form, chiefComplaint: e.target.value })} placeholder="Optional presenting complaint" /></Field>
              {(localError || submitState.error) && <div role="alert" style={{ color: 'var(--danger-600)' }}>{localError || submitState.error}</div>}
              <Button type="submit" loading={submitState.loading} disabled={submitState.loading}>Create Encounter</Button>
            </form>
          )}

          {loading && <p role="status" style={{ padding: 'var(--space-500) 0', color: 'var(--text-secondary)' }}>Loading authorized encounters…</p>}
          {loadError && (
            <div role="alert" style={{ padding: 'var(--space-500) 0', color: 'var(--danger-600)' }}>
              <div>{loadError}</div>
              <Button variant="secondary" size="sm" icon="refresh" onClick={() => setLoadRequest((value) => value + 1)} style={{ marginTop: 'var(--space-300)' }}>Retry</Button>
            </div>
          )}
          {!loading && !loadError && encounters.length === 0 && (
            <p style={{ padding: 'var(--space-500) 0', color: 'var(--text-secondary)' }}>No encounters are available for this patient at the active facility.</p>
          )}
          {!loading && encounters.length > 0 && (
            <div className="ehr-table-wrap" style={{ marginTop: 'var(--space-400)' }}>
              <table className="ehr-table">
                <thead><tr><th>Started</th><th>Type</th><th>Chief complaint</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>{encounters.map((encounter) => (
                  <tr key={encounter.id}>
                    <td>{formatDateTime(encounter.startedAt)}</td>
                    <td>{encounter.encounterType.replace('_', ' ')}</td>
                    <td>{encounter.chiefComplaint ?? 'Not recorded'}</td>
                    <td><Badge variant="neutral">{encounter.status.replace('_', ' ')}</Badge></td>
                    <td>{canAddRecords(encounter)
                      ? <Button size="sm" variant="primary" onClick={() => setSelected(encounter)}>Select</Button>
                      : <span style={{ color: 'var(--text-secondary)' }}>Closed</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {selected && (
        <>
          <Card pad>
            <SectionHeader
              title={`${selected.encounterType.replace('_', ' ')} encounter`}
              action={<Button variant="secondary" size="sm" onClick={() => setSelected(null)}>Change Encounter</Button>}
            />
            <div style={{ color: 'var(--text-secondary)', marginTop: 'var(--space-300)' }}>
              Started {formatDateTime(selected.startedAt)} • {selected.status.replace('_', ' ')}
            </div>
          </Card>
          <ClinicalForms patient={patient} encounterId={selected.id} permissions={permissions} />
        </>
      )}
    </div>
  );
};
