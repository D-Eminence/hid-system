import { useRef, useState } from 'react';
import { newIdempotencyKey } from '@/api/client';
import { getSafeClinicalErrorMessage } from '@/api/errors';

interface SubmitState {
  loading: boolean;
  error: string;
  success: string;
}

export const useClinicalSubmit = <Input, Result extends { id: string }>(
  action: (input: Input, idempotencyKey: string) => Promise<Result>,
  fingerprintFor: (input: Input) => string = (input) => JSON.stringify(input),
) => {
  const [state, setState] = useState<SubmitState>({ loading: false, error: '', success: '' });
  const requestInFlight = useRef(false);
  const idempotency = useRef<{ fingerprint: string; key: string } | null>(null);

  const submit = async (input: Input): Promise<Result | null> => {
    if (requestInFlight.current) return null;
    const fingerprint = fingerprintFor(input);
    if (!idempotency.current || idempotency.current.fingerprint !== fingerprint) {
      idempotency.current = { fingerprint, key: newIdempotencyKey() };
    }

    requestInFlight.current = true;
    setState({ loading: true, error: '', success: '' });
    try {
      const result = await action(input, idempotency.current.key);
      idempotency.current = null;
      setState({ loading: false, error: '', success: 'Saved securely.' });
      return result;
    } catch (error: unknown) {
      setState({ loading: false, error: getSafeClinicalErrorMessage(error), success: '' });
      return null;
    } finally {
      requestInFlight.current = false;
    }
  };

  const clearMessages = () => setState((current) => ({ ...current, error: '', success: '' }));
  return { ...state, submit, clearMessages };
};
