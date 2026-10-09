import React from 'react';
import { Button } from '@/components/ui/Primitives';
import { IDENTITY_PORTAL_URL } from '@/config/identityPortal';

interface EhrSignupProps {
  onBack: () => void;
}

export const EhrSignup: React.FC<EhrSignupProps> = ({ onBack }) => (
  <div className="ehr-auth-root fade-in">
    <div className="ehr-auth-panel">
      <div className="ehr-auth-form">
        <div className="ehr-auth-logo">
          <img className="ehr-auth-logo-image" src={`${import.meta.env.BASE_URL}assets/hid-logo.png`} alt="HID Health Identity Directory" />
        </div>
        <h2 className="ehr-auth-title">Request staff access</h2>
        <p className="ehr-auth-sub">
          Staff access is not created inside the EHR. This protects facility boundaries and ensures every role is approved and audited by HID Identity.
        </p>
        <ol className="ehr-auth-steps">
          <li>Ask an authorized administrator at your facility to provision your staff account.</li>
          <li>They will assign your verified role and facility membership in HID Identity.</li>
          <li>Return here and sign in with the credentials they provide.</li>
        </ol>
        {IDENTITY_PORTAL_URL ? (
          <a
            className="hid-btn hid-btn-primary hid-btn-lg w-full"
            href={IDENTITY_PORTAL_URL}
          >
            Open HID Identity access portal
          </a>
        ) : (
          <div className="ehr-auth-notice" role="status">
            Your facility has not configured a self-service access portal. Contact your facility administrator for provisioning instructions.
          </div>
        )}
        <Button variant="secondary" onClick={onBack} icon="arrowLeft" fullWidth>Back to Sign In</Button>
      </div>
    </div>
    <div className="ehr-auth-photo">
      <img className="ehr-auth-photo-img" src={`${import.meta.env.BASE_URL}assets/login-clinical.png`} alt="Healthcare provider using a clinical workstation" />
      <div className="ehr-auth-photo-caption">
        <div className="ehr-auth-photo-title">Verified access for every care setting</div>
        <div className="ehr-auth-photo-copy">HID Identity connects your approved role, active facility, and patient authorization context before clinical work begins.</div>
      </div>
    </div>
  </div>
);
