import React, { useEffect, useRef, useState } from 'react';
import { Card, PageHead, Button, Input, Field } from '@/components/ui/Primitives';
import { identityApi } from '@/api/client';
import { getSafeErrorMessage } from '@/api/errors';
import { isValidHid, normalizeHid } from '@/api/hid';
import { toPatientViewModel } from '@/api/patients';
import type { Patient } from '@/types/ehr.types';
import { WorkflowRail } from './WorkflowRail';
import { IDENTITY_PORTAL_URL } from '@/config/identityPortal';

interface RegistrationModuleProps {
  onRegistered?: (patient: Patient) => void;
  onComplete?: () => void;
}

export const RegistrationModule: React.FC<RegistrationModuleProps> = ({ onRegistered, onComplete }) => {
  const [hid, setHid] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const requestInFlight = useRef(false);
  const abortController = useRef<AbortController | null>(null);

  useEffect(() => () => abortController.current?.abort(), []);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedHid = normalizeHid(hid);
    setHid(normalizedHid);
    setErrorMessage('');
    if (!isValidHid(normalizedHid)) {
      setErrorMessage('Enter the complete HID issued by the Identity system.');
      return;
    }
    if (requestInFlight.current) return;

    requestInFlight.current = true;
    const controller = new AbortController();
    abortController.current = controller;
    setLoading(true);
    try {
      const result = await identityApi.lookupPatientByHid(normalizedHid, 'direct-care', controller.signal);
      if (result.authorization.decision !== 'allow') {
        setErrorMessage('This facility is not authorized to link the patient identity.');
        return;
      }
      if (!result.patient) {
        setErrorMessage('The secure HID service returned an incomplete authorized patient record.');
        return;
      }
      onRegistered?.(toPatientViewModel(result.patient));
      onComplete?.();
    } catch (error: unknown) {
      const message = getSafeErrorMessage(error);
      if (message) setErrorMessage(message);
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-600)' }}>
      <WorkflowRail active="authorization" />
      <PageHead
        title="Link Existing HID"
        sub="Patient identity is owned by HID Identity. The EHR only links an authorized existing HID."
      />

      <Card pad style={{ maxWidth: 800 }}>
        <div
          style={{
            padding: 'var(--space-400)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-info)',
            color: 'var(--text-body)',
            marginBottom: 'var(--space-500)',
          }}
        >
          If the patient does not yet have an HID, complete registration in the authorized Identity workflow first. No patient record is created in this EHR.
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-500)' }}>
          <Field label="Existing HID" required>
            <Input
              value={hid}
              onChange={(event) => setHid(event.target.value)}
              placeholder="Enter exact HID"
              icon="user"
              autoComplete="off"
              required
            />
          </Field>

          {errorMessage && <div role="alert" style={{ color: 'var(--danger-600)' }}>{errorMessage}</div>}

          <div className="ehr-form-actions ehr-form-actions-between">
            {IDENTITY_PORTAL_URL ? (
              <a
                className="hid-btn hid-btn-secondary hid-btn-md"
                href={IDENTITY_PORTAL_URL}
              >
                Open HID Identity Registration
              </a>
            ) : (
              <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>
                Identity registration access is configured by your administrator.
              </span>
            )}
            <Button type="submit" variant="primary" icon="check" loading={loading} disabled={loading}>
              Verify and Link HID
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
};
