import { ApiProblemError } from './client';

export const getSafeErrorMessage = (error: unknown): string => {
  if (error instanceof ApiProblemError) {
    if (error.status === 401) return 'Your session has expired. Sign in again.';
    if (error.status === 403 || error.status === 404) {
      return 'No authorized patient record is available for that HID and facility.';
    }
    if (error.status === 429) return 'Too many requests. Wait briefly and try again.';
    if (error.status >= 500 || error.status === 0) {
      return 'The secure HID service is temporarily unavailable. No data was changed.';
    }
    return error.detail ?? error.title;
  }
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  return 'The request could not be completed. No data was changed.';
};

export const getSafeLoginErrorMessage = (error: unknown): string => {
  if (error instanceof ApiProblemError && (error.status === 400 || error.status === 401)) {
    return 'Sign-in failed. Check your credentials and try again.';
  }
  return getSafeErrorMessage(error);
};

export const getSafeClinicalErrorMessage = (error: unknown): string => {
  if (error instanceof ApiProblemError) {
    if (error.status === 400) return 'Check the clinical form fields and try again.';
    if (error.status === 401) return 'Your session has expired. Sign in again.';
    if (error.status === 403) return 'Clinical access is not authorized for this patient and facility.';
    if (error.status === 404) return 'The selected clinical record is no longer available.';
    if (error.status === 409) return 'This request conflicts with an existing or in-progress operation. Review it before retrying.';
    if (error.status === 412) return 'This record changed after it was loaded. Reload it before making another change.';
    if (error.status === 413) return 'The submitted content is too large.';
    if (error.status === 429) return 'Too many requests. Wait briefly and try again.';
    if (error.status >= 500 || error.status === 0) {
      return 'The clinical service is temporarily unavailable. Your form has been preserved.';
    }
    return error.detail ?? error.title;
  }
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  return 'The request could not be completed. Your form has been preserved.';
};
