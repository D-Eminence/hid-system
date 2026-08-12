import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiProblemError, clinicalApi, newIdempotencyKey, ocrApi } from '@/api/client';
import type { ClinicalDocumentRecord, OcrCandidateType, OcrExtraction, OcrJob, OcrPublicationResult, OcrTargetDomain, OcrValidation } from '@/api/contracts';
import { getSafeClinicalErrorMessage } from '@/api/errors';
import type { Patient } from '@/types/ehr.types';
import { Badge, Button, Card, Field, Modal, SectionHeader, Select, Status, Textarea } from '@/components/ui/Primitives';

type ReviewMode = 'accept' | 'correct' | 'reject';
type ReviewField = { name: 'noteType' | 'title' | 'content'; original: string; corrected: string; mode: ReviewMode };

const classificationOptions: { value: OcrTargetDomain; label: string; candidate: OcrCandidateType }[] = [
  { value: 'EHR', label: 'EHR clinical note', candidate: 'clinical_note' },
  { value: 'DOCUMENT_ONLY', label: 'Validated document only', candidate: 'document_only' },
  { value: 'LAB', label: 'Imported laboratory evidence', candidate: 'lab_document' },
  { value: 'PHARMACY', label: 'Historical medication evidence', candidate: 'historical_medication_evidence' },
  { value: 'UNCLASSIFIED', label: 'Unclassified', candidate: 'unclassified' },
];

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
};
const formatBytes = (value: number) => value < 1_048_576 ? `${Math.ceil(value / 1024)} KiB` : `${(value / 1_048_576).toFixed(1)} MiB`;
const isStale = (error: unknown) => error instanceof ApiProblemError && ['OCR_VERSION_CONFLICT', 'OCR_VALIDATION_VERSION_CONFLICT'].includes(error.code ?? '');

interface Props { patient: Patient; encounterId: string; permissions: readonly string[]; refreshToken: number }

export const OcrReviewWorkspace: React.FC<Props> = ({ patient, encounterId, permissions, refreshToken }) => {
  const patientId = patient.patientId ?? '';
  const [documents, setDocuments] = useState<ClinicalDocumentRecord[]>([]);
  const [selected, setSelected] = useState<ClinicalDocumentRecord | null>(null);
  const [job, setJob] = useState<OcrJob | null>(null);
  const [extraction, setExtraction] = useState<OcrExtraction | null>(null);
  const [validation, setValidation] = useState<OcrValidation | null>(null);
  const [publication, setPublication] = useState<OcrPublicationResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [fields, setFields] = useState<ReviewField[]>([]);
  const [targetDomain, setTargetDomain] = useState<OcrTargetDomain>('EHR');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const startKey = useRef(newIdempotencyKey());
  const confirmationKey = useRef(newIdempotencyKey());
  const validationKey = useRef(newIdempotencyKey());
  const publicationKey = useRef(newIdempotencyKey());

  const loadDocuments = useCallback(async (signal?: AbortSignal) => {
    if (!patientId) return;
    setError('');
    try { setDocuments(await clinicalApi.listDocuments(patientId, encounterId, signal)); }
    catch (caught) { if (!signal?.aborted) setError(getSafeClinicalErrorMessage(caught)); }
  }, [encounterId, patientId]);

  useEffect(() => { const controller = new AbortController(); void loadDocuments(controller.signal); return () => controller.abort(); }, [loadDocuments, refreshToken]);

  const loadReview = useCallback(async (document: ClinicalDocumentRecord, signal?: AbortSignal) => {
    setLoading(true); setError(''); setPreviewUrl(''); setJob(null); setExtraction(null); setValidation(null); setPublication(null);
    try {
      const [foundJob, download] = await Promise.all([
        permissions.includes('ocr.job.read') ? ocrApi.findJob(document.id, signal) : Promise.resolve(null),
        clinicalApi.documentDownload(document.id, signal),
      ]);
      if (signal?.aborted) return;
      setPreviewUrl(download.url); setJob(foundJob);
      if (!foundJob) return;
      const [extractions, validations] = await Promise.all([ocrApi.listExtractions(foundJob.id, signal), ocrApi.listValidations(foundJob.id, signal)]);
      const latestExtraction = extractions.at(-1) ?? null;
      const latestValidation = validations.at(-1) ?? null;
      setExtraction(latestExtraction); setValidation(latestValidation);
      if (latestExtraction) setFields([
        { name: 'noteType', original: 'historical-record', corrected: '', mode: 'accept' },
        { name: 'title', original: `Imported: ${document.fileName}`, corrected: '', mode: 'accept' },
        { name: 'content', original: latestExtraction.rawText, corrected: '', mode: 'accept' },
      ]);
      if (latestValidation) {
        setTargetDomain(latestValidation.targetDomain); setReason(latestValidation.reason);
        const publications = await ocrApi.listPublications(latestValidation.id, signal);
        setPublication(publications.at(-1) ?? null);
      }
    } catch (caught) { if (!signal?.aborted) setError(getSafeClinicalErrorMessage(caught)); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [permissions]);

  useEffect(() => {
    if (!selected) return undefined;
    const controller = new AbortController(); void loadReview(selected, controller.signal);
    return () => { controller.abort(); setPreviewUrl(''); };
  }, [loadReview, selected]);

  const refreshReview = async () => { if (selected) await loadReview(selected); };
  const mutate = async (operation: () => Promise<void>) => {
    if (loading) return;
    setLoading(true); setError('');
    try { await operation(); await refreshReview(); }
    catch (caught) {
      if (isStale(caught)) { setError('This OCR record changed while you were reviewing it. The latest evidence has been reloaded.'); await refreshReview(); }
      else setError(getSafeClinicalErrorMessage(caught));
    } finally { setLoading(false); }
  };

  const startOcr = () => selected && mutate(async () => { await ocrApi.createJob(selected.id, patientId, startKey.current); });
  const confirmPatient = () => job && mutate(async () => {
    await ocrApi.confirmPatient(job.id, { patientId, expectedJobVersion: job.version, method: 'source_document',
      reason: 'Reviewer verified the canonical patient shown in the active encounter workspace.', purpose: 'healthcare-operations' }, confirmationKey.current);
    setConfirmOpen(false);
  });

  const submitValidation = (disposition: 'validated' | 'rejected') => job && extraction && mutate(async () => {
    const classification = disposition === 'rejected' ? classificationOptions.at(-1)! : classificationOptions.find((item) => item.value === targetDomain)!;
    const acceptedFields: Record<string, unknown> = {};
    const rejectedFields: Record<string, unknown>[] = [];
    const corrections: Record<string, unknown>[] = [];
    fields.forEach((field) => {
      if (disposition === 'rejected' || field.mode === 'reject') rejectedFields.push({ field: field.name, originalValue: field.original, reason: 'Reviewer rejected extracted field' });
      else {
        const value = field.mode === 'correct' ? field.corrected.trim() : field.original;
        acceptedFields[field.name] = value;
        if (field.mode === 'correct') corrections.push({ field: field.name, originalValue: field.original, correctedValue: value });
      }
    });
    if (classification.value === 'EHR') acceptedFields.encounterId = encounterId;
    if (classification.value === 'LAB') {
      acceptedFields.observations = [{ testName: acceptedFields.title, valueText: acceptedFields.content }];
      delete acceptedFields.noteType; delete acceptedFields.title; delete acceptedFields.content;
    }
    if (classification.value === 'PHARMACY') {
      acceptedFields.medicationText = acceptedFields.title;
      acceptedFields.historicalContext = acceptedFields.content;
      delete acceptedFields.noteType; delete acceptedFields.title; delete acceptedFields.content;
    }
    await ocrApi.validate(job.id, { extractionId: extraction.id, expectedVersion: job.version,
      validatedPayload: acceptedFields, disposition, targetDomain: classification.value, candidateType: classification.candidate,
      acceptedFields, rejectedFields, corrections, reason: reason.trim(), purpose: 'healthcare-operations' }, validationKey.current);
  });

  const publish = () => {
    if (!validation || !job?.patientConfirmation) return;
    const confirmation = job.patientConfirmation;
    void mutate(async () => {
    const operation = validation.targetDomain === 'EHR' ? 'create_imported_clinical_note'
      : validation.targetDomain === 'LAB' ? 'create_imported_lab_evidence'
      : validation.targetDomain === 'PHARMACY' ? 'create_imported_medication_evidence'
      : 'retain_validated_document';
    setPublication(await ocrApi.publish(validation.id, { validationVersion: validation.version,
      patientConfirmationId: confirmation.id, targetOperation: operation, purpose: 'direct-care' }, publicationKey.current));
    });
  };

  const canStart = selected?.status === 'available' && selected.scanStatus === 'clean' && !job && permissions.includes('ocr.job.write');
  const canReview = job?.status === 'awaiting_validation' && !!extraction && !patient.breakGlass && permissions.includes('ocr.validation.write');
  const pharmacyMedication = fields.find((field) => field.name === 'title');
  const validFields = targetDomain === 'EHR'
    ? fields.every((field) => field.mode === 'reject' || (field.mode === 'correct' ? field.corrected.trim() : field.original.trim()))
    : targetDomain === 'PHARMACY'
      ? pharmacyMedication?.mode === 'correct' && Boolean(pharmacyMedication.corrected.trim())
      : true;
  const publishable = validation?.disposition === 'validated' && ['EHR', 'LAB', 'PHARMACY', 'DOCUMENT_ONLY'].includes(validation.targetDomain)
    && !!job?.patientConfirmation && !patient.breakGlass && permissions.includes('ocr.publication.write') && !publication;

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-500)' }}>
    <SectionHeader title="Governed OCR review" action={<Button size="sm" variant="secondary" icon="refresh" loading={loading} onClick={() => { void loadDocuments(); void refreshReview(); }}>Refresh</Button>} />
    <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Select a clean document, inspect the immutable source beside its extraction, confirm the patient, and explicitly validate before publication.</p>
    {error && <div role="alert" style={{ color: 'var(--danger-600)' }}>{error}</div>}
    {documents.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>No documents are available for this encounter.</p> :
      <div className="ehr-table-wrap"><table className="ehr-table"><thead><tr><th>Document</th><th>Uploaded</th><th>Security scan</th><th>OCR</th><th>Action</th></tr></thead><tbody>{documents.map((document) =>
        <tr key={document.id}><td>{document.fileName}<div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)' }}>{formatBytes(document.sizeBytes)}</div></td>
          <td>{formatDate(document.createdAt)}</td><td><Status status={document.scanStatus} label={document.scanStatus} /></td>
          <td>{selected?.id === document.id && job ? <Status status={job.status} label={job.status.replaceAll('_', ' ')} /> : '—'}</td>
          <td><Button size="sm" variant={selected?.id === document.id ? 'primary' : 'secondary'} onClick={() => setSelected(document)}>Review</Button></td></tr>)}</tbody></table></div>}

    {selected && <>
      <Card pad><SectionHeader title={selected.fileName} action={canStart ? <Button size="sm" loading={loading} onClick={startOcr}>Start OCR</Button> : undefined} />
        {!job && !canStart && <p style={{ color: 'var(--text-secondary)' }}>{selected.scanStatus !== 'clean' ? 'OCR is unavailable until the security scan is clean.' : 'No OCR job exists, and this session cannot start one.'}</p>}
        {job && <div style={{ display: 'flex', gap: 'var(--space-300)', flexWrap: 'wrap' }}><Badge variant="neutral">Job {job.status.replaceAll('_', ' ')}</Badge><Badge variant="neutral">Provider {job.provider}</Badge><Badge variant="neutral">Attempt {job.attemptCount}/{job.maxAttempts}</Badge></div>}
      </Card>
      {job && <div className="ehr-grid-2" style={{ alignItems: 'start' }}>
        <Card pad><SectionHeader title="Source document" />
          {previewUrl ? selected.mediaType.startsWith('image/') ? <img src={previewUrl} alt={`Source document ${selected.fileName}`} style={{ width: '100%', maxHeight: 680, objectFit: 'contain' }} />
            : <iframe title={`Source document ${selected.fileName}`} src={previewUrl} style={{ width: '100%', height: 680, border: '1px solid var(--border)' }} />
            : <p style={{ color: 'var(--text-secondary)' }}>Authorized preview unavailable.</p>}
        </Card>
        <Card pad><SectionHeader title="Extracted evidence" />
          {!extraction ? <p style={{ color: 'var(--text-secondary)' }}>Extraction is {job.status.replaceAll('_', ' ')}. Refresh when processing completes.</p> : <>
            <Field label="Original OCR text" hint="Read-only source evidence; corrections are recorded separately."><Textarea value={extraction.rawText} readOnly rows={12} /></Field>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-400)', marginTop: 'var(--space-400)' }}>{fields.map((field, index) => <div key={field.name}>
              <div className="ehr-grid-2"><Field label={targetDomain === 'PHARMACY' && field.name === 'title' ? 'Medication text candidate' : targetDomain === 'PHARMACY' && field.name === 'content' ? 'Historical source context' : field.name}><Textarea value={field.original} readOnly rows={field.name === 'content' ? 5 : 2} /></Field>
                <Field label="Disposition"><Select value={field.mode} disabled={!canReview} onChange={(event) => setFields((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, mode: event.target.value as ReviewMode } : item))} options={[{ value: 'accept', label: 'Accept original' }, { value: 'correct', label: 'Correct' }, { value: 'reject', label: 'Reject field' }]} /></Field></div>
              {field.mode === 'correct' && <Field label={targetDomain === 'PHARMACY' && field.name === 'title' ? 'Confirmed medication text' : `Corrected ${field.name}`} required><Textarea value={field.corrected} disabled={!canReview} rows={field.name === 'content' ? 5 : 2} onChange={(event) => setFields((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, corrected: event.target.value } : item))} /></Field>}
            </div>)}</div>
            <div style={{ marginTop: 'var(--space-500)', display: 'flex', flexDirection: 'column', gap: 'var(--space-400)' }}>
              <Field label="Classification" required><Select value={targetDomain} disabled={!canReview} onChange={(event) => setTargetDomain(event.target.value as OcrTargetDomain)} options={classificationOptions.map(({ value, label }) => ({ value, label }))} /></Field>
              <Field label="Review reason" required hint="Explain the clinical or operational basis for this decision."><Textarea value={reason} disabled={!canReview} maxLength={1000} onChange={(event) => setReason(event.target.value)} /></Field>
              {canReview && !job.patientConfirmation && <Button variant="secondary" onClick={() => setConfirmOpen(true)}>Confirm patient identity</Button>}
              {job.patientConfirmation && <div role="status" style={{ color: 'var(--success-600)' }}>Patient confirmed against the canonical source document.</div>}
              {patient.breakGlass && <div role="status" style={{ color: 'var(--text-secondary)' }}>Emergency break-glass access is read-only. Confirmation, correction, validation, and publication are unavailable.</div>}
              {canReview && <div style={{ display: 'flex', gap: 'var(--space-300)', flexWrap: 'wrap' }}><Button loading={loading} disabled={!job.patientConfirmation || reason.trim().length < 8 || !validFields || targetDomain === 'UNCLASSIFIED'} onClick={() => submitValidation('validated')}>Validate extraction</Button><Button variant="danger" loading={loading} disabled={!job.patientConfirmation || reason.trim().length < 8} onClick={() => submitValidation('rejected')}>Reject extraction</Button></div>}
              {validation && <div><Status status={validation.disposition} label={`Validation v${validation.version}: ${validation.disposition}`} /> <span style={{ color: 'var(--text-secondary)' }}>{validation.targetDomain} / {validation.candidateType}</span></div>}
              {validation?.disposition === 'validated' && !['EHR', 'LAB', 'DOCUMENT_ONLY'].includes(validation.targetDomain) && <div role="status" style={{ color: 'var(--text-secondary)' }}>Publication to {validation.targetDomain.toLowerCase()} is unavailable until that owning-domain adapter exists. The validated evidence remains retained.</div>}
              {publishable && <Button loading={loading} onClick={publish}>{validation.targetDomain === 'EHR' ? 'Publish as draft clinical note' : validation.targetDomain === 'LAB' ? 'Import as external Lab evidence' : 'Retain validated document'}</Button>}
              {publication && <div role="status"><Status status={publication.status} label={publication.status} /> {publication.status === 'published' ? `Published ${publication.targetResourceType ?? 'resource'} successfully.` : publication.failureSummary ?? publication.failureCode ?? 'Publication command recorded.'}{publication.status === 'failed' && ['OWNING_SERVICE_UNAVAILABLE', 'REQUEST_IN_PROGRESS'].includes(publication.failureCode ?? '') && <Button size="sm" variant="secondary" loading={loading} onClick={publish} style={{ marginLeft: 'var(--space-300)' }}>Retry</Button>}</div>}
            </div>
          </>}
        </Card>
      </div>}
    </>}
    <Modal open={confirmOpen} onClose={() => !loading && setConfirmOpen(false)} title="Confirm patient identity" footer={<><Button variant="secondary" disabled={loading} onClick={() => setConfirmOpen(false)}>Cancel</Button><Button loading={loading} onClick={confirmPatient}>Confirm this patient</Button></>}>
      <p>Confirm that the source document and extracted content belong to this authorized patient:</p>
      <dl><dt>Patient</dt><dd>{patient.fullName}</dd><dt>HID</dt><dd>{patient.hid}</dd><dt>Canonical patient ID</dt><dd>{patientId}</dd></dl>
      <p style={{ color: 'var(--text-secondary)' }}>This deliberate confirmation is audited and required before validation or publication.</p>
    </Modal>
  </div>;
};
