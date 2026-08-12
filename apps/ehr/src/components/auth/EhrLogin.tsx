import React, { useEffect, useRef, useState } from 'react';
import { Button, Field, Icon, Input } from '@/components/ui/Primitives';
import { authApi } from '@/api/client';
import { getSafeLoginErrorMessage } from '@/api/errors';
import type { AuthSession } from '@/api/contracts';
import { Turnstile } from '@hid/ui/Turnstile';

interface EhrLoginProps {
  onAuthenticated: (session: AuthSession) => void;
  initialError?: string;
  onSignup?: () => void;
  onForgot?: () => void;
}

export const EhrLogin: React.FC<EhrLoginProps> = ({
  onAuthenticated,
  initialError,
  onSignup,
  onForgot,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(initialError ?? '');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const requestInFlight = useRef(false);

  useEffect(() => {
    if (initialError) setErrorMessage(initialError);
  }, [initialError]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (requestInFlight.current) return;
    if (!email.trim() || !password) {
      setErrorMessage('Staff email and password are required.');
      return;
    }

    requestInFlight.current = true;
    setLoading(true);
    setErrorMessage('');
    try {
      const session = await authApi.login(email.trim(), password, turnstileToken ?? undefined);
      onAuthenticated(session);
    } catch (error: unknown) {
      setErrorMessage(getSafeLoginErrorMessage(error));
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="ehr-auth-root fade-in">
      {/* Form Panel */}
      <div className="ehr-auth-panel">
        <div className="ehr-auth-form">
          {/* Logo */}
          <div className="ehr-auth-logo">
            <img className="ehr-auth-logo-image" src={`${import.meta.env.BASE_URL}assets/hid-logo.png`} alt="HID Health Identity Directory" />
          </div>

          <h2 className="ehr-auth-title">Healthcare provider</h2>
          <p className="ehr-auth-sub">Secure access to patient medical records</p>

          <form onSubmit={handleSubmit} className="ehr-auth-fields">
            <Field label="Staff Email / Username" required>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter staff email"
                icon="user"
                autoComplete="username"
                required
              />
            </Field>

            <Field label="Password" required>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                icon="lock"
                autoComplete="current-password"
                required
              />
            </Field>

            {errorMessage && (
              <div
                role="alert"
                style={{
                  padding: 'var(--space-300)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--danger-50)',
                  color: 'var(--danger-600)',
                  fontSize: 'var(--fs-sm)',
                }}
              >
                {errorMessage}
              </div>
            )}

            <Turnstile action="ehr-login" onTokenChange={setTurnstileToken} />

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={loading}
              disabled={loading}
              fullWidth
              icon="lock"
              style={{ marginTop: 'var(--space-400)' }}
            >
              Sign in
            </Button>

            <div className="ehr-auth-links" aria-label="Account access options">
              {onForgot && (
                <button type="button" className="ehr-auth-link" onClick={onForgot}>
                  Forgot password?
                </button>
              )}
              {onForgot && onSignup && <span className="ehr-auth-link-divider" aria-hidden="true">•</span>}
              {onSignup && (
                <button type="button" className="ehr-auth-link" onClick={onSignup}>
                  Request staff access
                </button>
              )}
            </div>
          </form>

          <div className="ehr-auth-trust" aria-label="Security assurances">
            <span><i><Icon name="check" size={12} /></i>HID Identity required</span>
            <span><i><Icon name="check" size={12} /></i>Facility-scoped access</span>
          </div>
        </div>
      </div>

      <div className="ehr-auth-photo" aria-label="Clinical staff using the HID EHR">
        <img className="ehr-auth-photo-img" src={`${import.meta.env.BASE_URL}assets/login-clinical.png`} alt="Healthcare provider using a clinical workstation" />
      </div>
    </div>
  );
};
