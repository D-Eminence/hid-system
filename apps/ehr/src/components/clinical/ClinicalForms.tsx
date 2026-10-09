import React, { useMemo, useState } from 'react';
import { clinicalApi } from '@/api/client';
import type {
  CreateClinicalNoteInput,
  CreateDiagnosisInput,
  CreateLabRequestInput,
  CreatePrescriptionInput,
  CreateVitalInput,
  DocumentUploadOptions,
} from '@/api/contracts';
import { Button, Card, Field, Input, Select, TabBar, Textarea } from '@/components/ui/Primitives';
import { useClinicalSubmit } from './useClinicalSubmit';
import { ClinicalTimeline } from './ClinicalTimeline';
import { OcrReviewWorkspace } from './OcrReviewWorkspace';
import type { Patient } from '@/types/ehr.types';

interface ClinicalFormsProps {
  patient: Patient;
  encounterId: string;
  permissions: readonly string[];
}

const localDateTime = (): string => {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const asIso = (value: string): string | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const numberOrUndefined = (value: string): number | undefined => value === '' ? undefined : Number(value);

const Feedback: React.FC<{ error: string; success: string; localError: string }> = ({ error, success, localError }) => (
  <>
    {(localError || error) && <div role="alert" style={{ color: 'var(--danger-600)' }}>{localError || error}</div>}
    {success && <div role="status" style={{ color: 'var(--success-600)' }}>{success}</div>}
  </>
);

interface ClinicalFormProps { patientId: string; encounterId: string; onSaved: () => void }

const NoteForm: React.FC<ClinicalFormProps> = ({ patientId, encounterId, onSaved }) => {
  const initial = { noteType: '', title: '', status: 'draft' as const, content: '' };
  const [form, setForm] = useState<CreateClinicalNoteInput>(initial);
  const [localError, setLocalError] = useState('');
  const submitState = useClinicalSubmit((input: CreateClinicalNoteInput, key) =>
    clinicalApi.createNote(patientId, encounterId, input, key));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.noteType.trim() || !form.title.trim() || !form.content.trim()) {
      setLocalError('Note type, title, and content are required.');
      return;
    }
    setLocalError('');
    if (await submitState.submit({ ...form, noteType: form.noteType.trim(), title: form.title.trim() })) { setForm(initial); onSaved(); }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-400)' }}>
      <div className="ehr-grid-2">
        <Field label="Note type" required><Input value={form.noteType} onChange={(e) => setForm({ ...form, noteType: e.target.value })} placeholder="Enter note type" maxLength={80} /></Field>
        <Field label="Title" required><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Enter note title" maxLength={240} /></Field>
      </div>
      <Field label="Status" required><Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'draft' | 'signed' })} options={[{ value: 'draft', label: 'Draft' }, { value: 'signed', label: 'Signed' }]} /></Field>
      <Field label="Clinical note" required><Textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="Record the clinical note" rows={8} /></Field>
      <Feedback error={submitState.error} success={submitState.success} localError={localError} />
      <Button type="submit" loading={submitState.loading} disabled={submitState.loading}>Save Note</Button>
    </form>
  );
};

type VitalFormState = Record<
  'heightCm' | 'weightKg' | 'temperatureC' | 'pulseBpm' | 'respiratoryRate' | 'systolicMmhg' | 'diastolicMmhg' | 'oxygenSaturationPercent',
  string
> & { recordedAt: string };

const VitalForm: React.FC<ClinicalFormProps> = ({ patientId, encounterId, onSaved }) => {
  const emptyMeasurements = { heightCm: '', weightKg: '', temperatureC: '', pulseBpm: '', respiratoryRate: '', systolicMmhg: '', diastolicMmhg: '', oxygenSaturationPercent: '' };
  const [form, setForm] = useState<VitalFormState>({ recordedAt: localDateTime(), ...emptyMeasurements });
  const [localError, setLocalError] = useState('');
  const submitState = useClinicalSubmit((input: CreateVitalInput, key) =>
    clinicalApi.createVital(patientId, encounterId, input, key));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const recordedAt = asIso(form.recordedAt);
    const measurements = {
      heightCm: numberOrUndefined(form.heightCm), weightKg: numberOrUndefined(form.weightKg),
      temperatureC: numberOrUndefined(form.temperatureC), pulseBpm: numberOrUndefined(form.pulseBpm),
      respiratoryRate: numberOrUndefined(form.respiratoryRate), systolicMmhg: numberOrUndefined(form.systolicMmhg),
      diastolicMmhg: numberOrUndefined(form.diastolicMmhg), oxygenSaturationPercent: numberOrUndefined(form.oxygenSaturationPercent),
    };
    if (!recordedAt || !Object.values(measurements).some((value) => value !== undefined)
      || Object.values(measurements).some((value) => value !== undefined && !Number.isFinite(value))) {
      setLocalError('Enter a valid recording time and at least one valid measurement.');
      return;
    }
    setLocalError('');
    if (await submitState.submit({ recordedAt, source: 'manual', ...measurements })) {
      setForm({ recordedAt: localDateTime(), ...emptyMeasurements });
      onSaved();
    }
  };

  const measurement = (field: keyof typeof emptyMeasurements, label: string, min: number, max: number, step = '1') => (
    <Field label={label}><Input type="number" value={form[field]} min={min} max={max} step={step} onChange={(e) => setForm({ ...form, [field]: e.target.value })} /></Field>
  );
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-400)' }}>
      <Field label="Recorded at" required><Input type="datetime-local" value={form.recordedAt} onChange={(e) => setForm({ ...form, recordedAt: e.target.value })} /></Field>
      <div className="ehr-grid-4">
        {measurement('temperatureC', 'Temperature (°C)', 20, 50, '0.1')}
        {measurement('pulseBpm', 'Pulse (bpm)', 10, 350)}
        {measurement('respiratoryRate', 'Respiratory rate', 1, 100)}
        {measurement('oxygenSaturationPercent', 'SpO₂ (%)', 0, 100, '0.01')}
        {measurement('systolicMmhg', 'Systolic (mmHg)', 30, 350)}
        {measurement('diastolicMmhg', 'Diastolic (mmHg)', 10, 250)}
        {measurement('heightCm', 'Height (cm)', 20, 300, '0.01')}
        {measurement('weightKg', 'Weight (kg)', 0.2, 700, '0.001')}
      </div>
      <Feedback error={submitState.error} success={submitState.success} localError={localError} />
      <Button type="submit" loading={submitState.loading} disabled={submitState.loading}>Record Vitals</Button>
    </form>
  );
};

const DiagnosisForm: React.FC<ClinicalFormProps> = ({ patientId, encounterId, onSaved }) => {
  const initial: CreateDiagnosisInput = { codeSystem: '', code: '', display: '', clinicalStatus: 'active', verificationStatus: 'provisional', notes: '' };
  const [form, setForm] = useState(initial);
  const [localError, setLocalError] = useState('');
  const submitState = useClinicalSubmit((input: CreateDiagnosisInput, key) => clinicalApi.createDiagnosis(patientId, encounterId, input, key));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.codeSystem.trim() || !form.code.trim() || !form.display.trim()) {
      setLocalError('Code system, code, and diagnosis display are required.'); return;
    }
    setLocalError('');
    if (await submitState.submit({ ...form, codeSystem: form.codeSystem.trim(), code: form.code.trim(), display: form.display.trim(), notes: form.notes?.trim() || undefined })) { setForm(initial); onSaved(); }
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-400)' }}>
      <div className="ehr-grid-2">
        <Field label="Code system" required><Input value={form.codeSystem} onChange={(e) => setForm({ ...form, codeSystem: e.target.value })} placeholder="Enter terminology URI or name" /></Field>
        <Field label="Code" required><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="Enter diagnosis code" /></Field>
      </div>
      <Field label="Diagnosis" required><Input value={form.display} onChange={(e) => setForm({ ...form, display: e.target.value })} placeholder="Enter diagnosis display" /></Field>
      <div className="ehr-grid-2">
        <Field label="Clinical status"><Select value={form.clinicalStatus} onChange={(e) => setForm({ ...form, clinicalStatus: e.target.value as CreateDiagnosisInput['clinicalStatus'] })} options={['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved'].map((value) => ({ value, label: value.replace('_', ' ') }))} /></Field>
        <Field label="Verification"><Select value={form.verificationStatus} onChange={(e) => setForm({ ...form, verificationStatus: e.target.value as CreateDiagnosisInput['verificationStatus'] })} options={['unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted'].map((value) => ({ value, label: value.replace('_', ' ') }))} /></Field>
      </div>
      <Field label="Notes"><Textarea value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional clinical context" /></Field>
      <Feedback error={submitState.error} success={submitState.success} localError={localError} />
      <Button type="submit" loading={submitState.loading} disabled={submitState.loading}>Add Diagnosis</Button>
    </form>
  );
};

const PrescriptionForm: React.FC<ClinicalFormProps> = ({ patientId, encounterId, onSaved }) => {
  const initial: CreatePrescriptionInput = { medicationDisplay: '', doseUnit: '', routeCode: '', frequency: '', instructions: '', status: 'draft' };
  const [form, setForm] = useState(initial);
  const [dose, setDose] = useState('');
  const [localError, setLocalError] = useState('');
  const submitState = useClinicalSubmit((input: CreatePrescriptionInput, key) => clinicalApi.createPrescription(patientId, encounterId, input, key));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const doseQuantity = numberOrUndefined(dose);
    const doseUnit = form.doseUnit?.trim() || undefined;
    if (!form.medicationDisplay.trim() || !form.frequency.trim() || !form.instructions.trim()
      || ((doseQuantity === undefined) !== (doseUnit === undefined))
      || (doseQuantity !== undefined && (!Number.isFinite(doseQuantity) || doseQuantity <= 0))) {
      setLocalError('Medication, frequency, instructions, and a complete dose plus unit are required when dosing is supplied.'); return;
    }
    setLocalError('');
    if (await submitState.submit({
      ...form,
      medicationDisplay: form.medicationDisplay.trim(),
      frequency: form.frequency.trim(),
      instructions: form.instructions.trim(),
      doseQuantity,
      doseUnit,
      routeCode: form.routeCode?.trim() || undefined,
    })) {
      setForm(initial); setDose('');
      onSaved();
    }
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-400)' }}>
      <Field label="Medication" required><Input value={form.medicationDisplay} onChange={(e) => setForm({ ...form, medicationDisplay: e.target.value })} placeholder="Enter medication name" /></Field>
      <div className="ehr-grid-4">
        <Field label="Dose"><Input type="number" min="0.0001" step="0.0001" value={dose} onChange={(e) => setDose(e.target.value)} /></Field>
        <Field label="Dose unit"><Input value={form.doseUnit ?? ''} onChange={(e) => setForm({ ...form, doseUnit: e.target.value })} /></Field>
        <Field label="Route"><Input value={form.routeCode ?? ''} onChange={(e) => setForm({ ...form, routeCode: e.target.value })} /></Field>
        <Field label="Status"><Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'draft' | 'active' })} options={[{ value: 'draft', label: 'Draft' }, { value: 'active', label: 'Active' }]} /></Field>
      </div>
      <Field label="Frequency" required><Input value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} placeholder="Enter frequency" /></Field>
      <Field label="Instructions" required><Textarea value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Enter administration instructions" /></Field>
      <div className="ehr-grid-2">
        <Field label="Starts on"><Input type="date" value={form.startsOn ?? ''} onChange={(e) => setForm({ ...form, startsOn: e.target.value || undefined })} /></Field>
        <Field label="Ends on"><Input type="date" value={form.endsOn ?? ''} onChange={(e) => setForm({ ...form, endsOn: e.target.value || undefined })} /></Field>
      </div>
      <Feedback error={submitState.error} success={submitState.success} localError={localError} />
      <Button type="submit" loading={submitState.loading} disabled={submitState.loading}>Create Prescription</Button>
    </form>
  );
};

const LabRequestForm: React.FC<ClinicalFormProps> = ({ patientId, encounterId, onSaved }) => {
  const initial: CreateLabRequestInput = { testCodeSystem: '', testCode: '', testDisplay: '', priority: 'routine', status: 'draft', specimenTypeCode: '', clinicalInformation: '' };
  const [form, setForm] = useState(initial);
  const [localError, setLocalError] = useState('');
  const [labAcceptance, setLabAcceptance] = useState('');
  const submitState = useClinicalSubmit((input: CreateLabRequestInput, key) => clinicalApi.createLabRequest(patientId, encounterId, input, key));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.testCodeSystem.trim() || !form.testCode.trim() || !form.testDisplay.trim()) {
      setLocalError('Test code system, code, and display are required.'); return;
    }
    setLocalError('');
    const result = await submitState.submit({ ...form, testCodeSystem: form.testCodeSystem.trim(), testCode: form.testCode.trim(), testDisplay: form.testDisplay.trim(), specimenTypeCode: form.specimenTypeCode?.trim() || undefined, clinicalInformation: form.clinicalInformation?.trim() || undefined });
    if (result) {
      setLabAcceptance(result.labWorkItem ? `Accepted by Lab · work item ${result.labWorkItem.id}` : 'Saved as EHR draft; not yet accepted by Lab.');
      setForm(initial); onSaved();
    }
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-400)' }}>
      <div className="ehr-grid-2">
        <Field label="Test code system" required><Input value={form.testCodeSystem} onChange={(e) => setForm({ ...form, testCodeSystem: e.target.value })} /></Field>
        <Field label="Test code" required><Input value={form.testCode} onChange={(e) => setForm({ ...form, testCode: e.target.value })} /></Field>
      </div>
      <Field label="Test" required><Input value={form.testDisplay} onChange={(e) => setForm({ ...form, testDisplay: e.target.value })} placeholder="Enter requested test" /></Field>
      <div className="ehr-grid-2">
        <Field label="Priority"><Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as CreateLabRequestInput['priority'] })} options={['routine', 'urgent', 'asap', 'stat'].map((value) => ({ value, label: value.toUpperCase() }))} /></Field>
        <Field label="Status"><Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'draft' | 'active' })} options={[{ value: 'draft', label: 'Draft' }, { value: 'active', label: 'Active' }]} /></Field>
      </div>
      <Field label="Specimen type code"><Input value={form.specimenTypeCode ?? ''} onChange={(e) => setForm({ ...form, specimenTypeCode: e.target.value })} /></Field>
      <Field label="Clinical information"><Textarea value={form.clinicalInformation ?? ''} onChange={(e) => setForm({ ...form, clinicalInformation: e.target.value })} placeholder="Optional clinical context for the laboratory" /></Field>
      <Feedback error={submitState.error} success={labAcceptance || submitState.success} localError={localError} />
      <Button type="submit" loading={submitState.loading} disabled={submitState.loading}>Create Lab Request</Button>
    </form>
  );
};

interface DocumentSubmission { file: File; options: DocumentUploadOptions }

const DocumentForm: React.FC<{ patientId: string; encounterId: string; onUploaded: () => void }> = ({ patientId, encounterId, onUploaded }) => {
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState<DocumentUploadOptions>({ classification: 'phi', retentionClass: 'clinical-10y' });
  const [localError, setLocalError] = useState('');
  const [inputKey, setInputKey] = useState(0);
  const submitState = useClinicalSubmit(
    (input: DocumentSubmission, key) => clinicalApi.uploadDocument(patientId, encounterId, input.file, input.options, key),
    (input) => `${input.file.name}:${input.file.size}:${input.file.lastModified}:${input.file.type}:${input.options.classification}:${input.options.retentionClass}`,
  );
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) { setLocalError('Choose a document to upload.'); return; }
    setLocalError('');
    if (await submitState.submit({ file, options })) { setFile(null); setInputKey((value) => value + 1); onUploaded(); }
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-400)' }}>
      <Field label="Clinical document" required hint="PDF, JPEG, PNG, or TIFF; maximum 50 MiB.">
        <input key={inputKey} className="hid-input" type="file" accept="application/pdf,image/jpeg,image/png,image/tiff" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <div className="ehr-grid-2">
        <Field label="Classification"><Select value={options.classification} onChange={(e) => setOptions({ ...options, classification: e.target.value as DocumentUploadOptions['classification'] })} options={[{ value: 'phi', label: 'Protected health information' }, { value: 'restricted', label: 'Restricted' }, { value: 'internal', label: 'Internal' }]} /></Field>
        <Field label="Retention"><Select value={options.retentionClass} onChange={(e) => setOptions({ ...options, retentionClass: e.target.value as DocumentUploadOptions['retentionClass'] })} options={[{ value: 'clinical-10y', label: 'Clinical - 10 years' }, { value: 'clinical-permanent', label: 'Clinical - permanent' }, { value: 'legal-hold', label: 'Legal hold' }]} /></Field>
      </div>
      <Feedback error={submitState.error} success={submitState.success ? 'Upload accepted and queued for security scanning.' : ''} localError={localError} />
      <Button type="submit" icon="upload" loading={submitState.loading} disabled={submitState.loading}>Upload Document</Button>
    </form>
  );
};

const formDefinitions = [
  { id: 'note', label: 'Note', permission: 'ehr.note.write' },
  { id: 'vitals', label: 'Vitals', permission: 'ehr.vital.write' },
  { id: 'diagnosis', label: 'Diagnosis', permission: 'ehr.diagnosis.write' },
  { id: 'prescription', label: 'Prescription', permission: 'ehr.prescription.write' },
  { id: 'lab', label: 'Lab Request', permission: 'ehr.lab-request.write' },
  { id: 'document', label: 'Document', permission: 'ehr.document.write' },
  { id: 'ocr', label: 'OCR Review', permission: 'ocr.job.read' },
] as const;

export const ClinicalForms: React.FC<ClinicalFormsProps> = ({ patient, encounterId, permissions }) => {
  const patientId = patient.patientId ?? '';
  const allowedForms = useMemo(() => formDefinitions.filter((form) => permissions.includes(form.permission)), [permissions]);
  const [active, setActive] = useState<string>(allowedForms[0]?.id ?? '');
  const [timelineRefresh, setTimelineRefresh] = useState(0);
  const activeForm = allowedForms.some((form) => form.id === active) ? active : (allowedForms[0]?.id ?? '');
  const onSaved = () => setTimelineRefresh((value) => value + 1);
  return (
    <>
      {allowedForms.length > 0 ? (
        <Card pad>
          <TabBar tabs={allowedForms.map(({ id, label }) => ({ id, label }))} active={activeForm} onChange={setActive} />
          <div style={{ marginTop: 'var(--space-500)' }}>
            {activeForm === 'note' && <NoteForm patientId={patientId} encounterId={encounterId} onSaved={onSaved} />}
            {activeForm === 'vitals' && <VitalForm patientId={patientId} encounterId={encounterId} onSaved={onSaved} />}
            {activeForm === 'diagnosis' && <DiagnosisForm patientId={patientId} encounterId={encounterId} onSaved={onSaved} />}
            {activeForm === 'prescription' && <PrescriptionForm patientId={patientId} encounterId={encounterId} onSaved={onSaved} />}
            {activeForm === 'lab' && <LabRequestForm patientId={patientId} encounterId={encounterId} onSaved={onSaved} />}
            {activeForm === 'document' && <DocumentForm patientId={patientId} encounterId={encounterId} onUploaded={onSaved} />}
            {activeForm === 'ocr' && <OcrReviewWorkspace patient={patient} encounterId={encounterId} permissions={permissions} refreshToken={timelineRefresh} />}
          </div>
        </Card>
      ) : (
        <Card pad><p style={{ color: 'var(--text-secondary)' }}>Your verified session does not include permission to create clinical records.</p></Card>
      )}
      <ClinicalTimeline patientId={patientId} encounterId={encounterId} permissions={permissions} refreshToken={timelineRefresh} />
    </>
  );
};
