import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Card, PageHead, Button, Input } from '@/components/ui/Primitives';
import { Status } from '@/components/ui/Status';
import { identityApi } from '@/api/client';
import { getSafeErrorMessage } from '@/api/errors';
import { isValidHid, normalizeHid } from '@/api/hid';
import { toPatientViewModel } from '@/api/patients';
import type { Patient } from '@/types/ehr.types';
import { WorkflowRail } from './WorkflowRail';

interface PatientsModuleProps {
  onSelectPatient?: (patient: Patient) => void;
  onRegister?: () => void;
  initialHid?: string;
  lookupRequestId?: number;
}

export const PatientsModule: React.FC<PatientsModuleProps> = ({
  onSelectPatient,
  onRegister,
  initialHid = '',
  lookupRequestId = 0,
}) => {
  const [search, setSearch] = useState(initialHid);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const requestInFlight = useRef(false);
  const inFlightHid = useRef('');
  const abortController = useRef<AbortController | null>(null);

  const lookupPatient = useCallback(async (rawHid: string): Promise<void> => {
    const hid = normalizeHid(rawHid);
    setSearch(hid);
    setErrorMessage('');
    setPatient(null);
    setHasSearched(true);

    if (!isValidHid(hid)) {
      abortController.current?.abort();
      abortController.current = null;
      requestInFlight.current = false;
      inFlightHid.current = '';
      setLoading(false);
      setErrorMessage('Enter a complete HID in the format shown on the patient identity record.');
      return;
    }
    if (
      requestInFlight.current
      && inFlightHid.current === hid
      && !abortController.current?.signal.aborted
    ) return;

    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;
    requestInFlight.current = true;
    inFlightHid.current = hid;
    setLoading(true);
    try {
      const result = await identityApi.lookupPatientByHid(hid, 'direct-care', controller.signal);
      if (result.authorization.decision !== 'allow') {
        setErrorMessage('Access to this patient is not authorized for the active facility.');
        return;
      }
      if (!result.patient) {
        setErrorMessage('The secure HID service returned an incomplete authorized patient record.');
        return;
      }
      setPatient({ ...toPatientViewModel(result.patient), breakGlass: result.authorization.breakGlass === true });
    } catch (error: unknown) {
      const message = getSafeErrorMessage(error);
      if (message) setErrorMessage(message);
    } finally {
      if (abortController.current === controller) {
        requestInFlight.current = false;
        inFlightHid.current = '';
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const normalizedInitialHid = normalizeHid(initialHid);
    if (normalizedInitialHid) void lookupPatient(normalizedInitialHid);
    return () => abortController.current?.abort();
  }, [initialHid, lookupPatient, lookupRequestId]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void lookupPatient(search);
  };

  const clearSearch = () => {
    abortController.current?.abort();
    abortController.current = null;
    requestInFlight.current = false;
    inFlightHid.current = '';
    setSearch('');
    setPatient(null);
    setErrorMessage('');
    setHasSearched(false);
    setLoading(false);
  };

  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    abortController.current?.abort();
    abortController.current = null;
    requestInFlight.current = false;
    inFlightHid.current = '';
    setLoading(false);
    setSearch(event.target.value);
    setPatient(null);
    setErrorMessage('');
    setHasSearched(false);
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-600)' }}>
      <WorkflowRail active={patient ? 'authorization' : 'lookup'} />
      <PageHead
        title="Patient Lookup"
        sub="Find a patient by exact HID. Identity, facility access, and consent are verified before access."
        actions={<Button variant="primary" icon="plus" onClick={onRegister}>Link Existing HID</Button>}
      />

      <Card pad>
        <form onSubmit={handleSubmit} className="ehr-lookup-form">
          <div className="ehr-lookup-field">
            <Input
              value={search}
              onChange={handleSearchChange}
              placeholder="Enter exact HID"
              icon="search"
              autoComplete="off"
              aria-label="Exact patient HID"
            />
          </div>
          <Button type="submit" variant="primary" icon="search" loading={loading} disabled={loading}>
            Verify Access
          </Button>
          <Button type="button" variant="secondary" icon="x" onClick={clearSearch} disabled={loading && !search}>
            Clear
          </Button>
        </form>

        {errorMessage && (
          <div role="alert" style={{ color: 'var(--danger-600)', padding: 'var(--space-400)', textAlign: 'center' }}>
            {errorMessage}
          </div>
        )}

        {!hasSearched && !loading && (
          <div style={{ color: 'var(--text-secondary)', padding: 'var(--space-800) 0', textAlign: 'center' }}>
            Enter the patient&apos;s complete HID to begin an authorized lookup.
          </div>
        )}

        {loading && (
          <div role="status" style={{ padding: 'var(--space-800) 0', textAlign: 'center' }}>
            Verifying identity, facility access, and consent…
          </div>
        )}

        {hasSearched && !loading && !errorMessage && !patient && (
          <div style={{ color: 'var(--text-secondary)', padding: 'var(--space-800) 0', textAlign: 'center' }}>
            No authorized patient record was returned.
          </div>
        )}

        {patient && !loading && (
          <div className="ehr-table-wrap">
            <table className="ehr-table">
              <thead>
                <tr>
                  <th>Patient Name</th>
                  <th>HID / MRN</th>
                  <th>Age / Sex</th>
                  <th>Status</th>
                  <th>Last Visit</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                <tr key={patient.patientId}>
                  <td style={{ fontWeight: 600, color: 'var(--text-heading)' }}>{patient.fullName}</td>
                  <td>
                    <div className="mono">{patient.hid}</div>
                    {patient.mrn && (
                      <div className="mono" style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                        MRN: {patient.mrn}
                      </div>
                    )}
                  </td>
                  <td>{patient.age === undefined ? 'Not supplied' : `${patient.age} yrs`}{patient.sex ? `, ${patient.sex}` : ''}</td>
                  <td>{patient.status ? <Status status={patient.status} /> : 'Not supplied'}</td>
                  <td>{patient.lastVisit ?? 'Not supplied'}</td>
                  <td>
                    <Button variant="primary" size="sm" icon="clipboard" onClick={() => onSelectPatient?.(patient)}>
                      Continue to Encounter
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};
