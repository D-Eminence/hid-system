import React, { useEffect, useRef, useState } from 'react';
import type { ImportedMedicalRecord, ImportedHealthProfile } from '../../api-client/src/imported-records';

function Content({value}: {value: unknown}): React.ReactElement {
  if (value == null || value === '') return <></>;
  if (Array.isArray(value)) return <ul>{value.map((item,index) => <li key={index}><Content value={item}/></li>)}</ul>;
  if (typeof value === 'object') return <dl>{Object.entries(value).map(([key,item]) => <React.Fragment key={key}>
    <dt>{key.replace(/_/g,' ')}</dt><dd><Content value={item}/></dd></React.Fragment>)}</dl>;
  return <span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{String(value)}</span>;
}
export function ImportedMedicalHistory({records,healthProfile,onDownload}: {
  records: ImportedMedicalRecord[]; healthProfile?: ImportedHealthProfile | null;
  onDownload?: (fileId: string) => Promise<{ url: string; expiresInSeconds: number }>;
}) {
  const [busy,setBusy] = useState<string | null>(null);
  const [error,setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function download(fileId: string) {
    if (!onDownload) return;
    setBusy(fileId); setError('');
    try {
      const value = await onDownload(fileId);
      if (!mounted.current) return;
      const url = new URL(value.url);
      if (url.protocol !== 'https:' || url.username || url.password || value.expiresInSeconds <= 0 || value.expiresInSeconds > 60) throw new Error('Invalid download');
      const link = document.createElement('a');
      link.href = url.toString(); link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; link.target = '_blank';
      link.click();
    } catch { if (mounted.current) setError('The attachment could not be downloaded. Your access or its safety status may have changed.'); }
    finally { if (mounted.current) setBusy(null); }
  }
  return <section aria-label="Imported medical history">
    <h2>Imported medical history</h2>
    {healthProfile && <section aria-label="Preserved health profile"><h3>Preserved health profile</h3>
      <p>Recorded {new Date(healthProfile.updatedAt).toLocaleString()}. Historical patient information.</p>
      <dl>{(['blood_group','genotype','allergies','chronic_conditions','current_medications','medical_notes'] as const)
        .filter(key => healthProfile.content[key] != null && healthProfile.content[key] !== '')
        .map(key => <React.Fragment key={key}><dt>{key.replace(/_/g,' ')}</dt><dd><Content value={healthProfile.content[key]}/></dd></React.Fragment>)}</dl>
    </section>}
    {error && <p role="alert">{error}</p>}
    {records.length === 0 && <p>No imported records are available.</p>}
    {records.map(record => <article key={record.id} style={{borderTop:'1px solid #dbe3ef',padding:'12px 0'}}>
      <h3>{record.title || record.category || 'Medical record'}</h3>
      <p>{record.origin === 'patient-provided' ? 'Patient-provided' : 'Provider-authored'} · {new Date(record.createdAt).toLocaleString()}</p>
      {record.versions.map(version => <details key={version.id} open={version.id === record.currentVersionId}>
        <summary>Version {version.versionNo}{version.id === record.currentVersionId ? ' (current)' : ''} · {new Date(version.createdAt).toLocaleString()} · {version.origin === 'patient-provided' ? 'Patient-provided' : 'Provider-authored'}</summary>
        <Content value={version.record}/><Content value={version.structuredData}/>
        {version.notes != null && <><h4>Notes</h4><Content value={version.notes}/></>}
        {version.transcriptionText != null && <><h4>Transcription</h4><Content value={version.transcriptionText}/></>}
      </details>)}
      {record.files.length > 0 && <><h4>Attachments</h4><ul>{record.files.map(file => <li key={file.id}>
        {file.fileName || 'Attachment'} · {file.sizeBytes} bytes · {file.accessStatus === 'available' && onDownload
          ? <button disabled={busy !== null} onClick={() => void download(file.id)}>{busy === file.id ? 'Preparing download…' : 'Download'}</button>
          : file.accessStatus === 'rejected' ? 'Download blocked by safety verification' : file.accessStatus === 'available' ? 'Download unavailable' : 'Download pending safety verification'}
      </li>)}</ul></>}
    </article>)}
  </section>;
}
