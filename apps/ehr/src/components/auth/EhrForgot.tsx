import React from 'react';
import { Button } from '@/components/ui/Primitives';
import { IDENTITY_PORTAL_URL } from '@/config/identityPortal';

interface EhrForgotProps {
  onBack: () => void;
}

export const EhrForgot: React.FC<EhrForgotProps> = ({ onBack }) => {
  return (
    <div className="ehr-setup-root fade-in">
      <div className="ehr-setup-card" style={{ maxWidth: 440 }}>
        <div className="ehr-setup-head">
          <div className="ehr-auth-logo">
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 'var(--radius-md)',
                background: 'var(--accent)',
                color: '#ffffff',
                fontWeight: 800,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              HID
            </div>
            <div className="ehr-auth-logo-name">HID EHR Account Recovery</div>
          </div>
        </div>
        <div className="ehr-setup-body">
          <div className="ehr-auth-recovery">
            <p className="ehr-auth-sub">
              Password recovery is managed by HID Identity so reset events remain tied to your verified staff account and facility access.
            </p>
            {IDENTITY_PORTAL_URL ? (
              <a
                className="hid-btn hid-btn-primary hid-btn-lg w-full"
                href={IDENTITY_PORTAL_URL}
              >
                Open HID Identity recovery
              </a>
            ) : (
              <div className="ehr-auth-notice" role="status">
                Contact your facility administrator to reset your password or configure the HID Identity recovery portal.
              </div>
            )}
            <Button variant="ghost" size="md" onClick={onBack} fullWidth icon="arrowLeft">
              Back to Sign In
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
