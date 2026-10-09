import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest globals are disabled, so Testing Library cannot register this hook itself.
// Unmount React roots before jsdom teardown, including their session listeners.
afterEach(cleanup);
