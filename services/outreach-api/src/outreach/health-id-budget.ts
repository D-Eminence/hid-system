import { OUTREACH_HEALTH_ID_CREATE_UNCLAIMED_TIMEOUT_MS } from '@hid/api-client';

/**
 * Time budget of POST .../health-id/create-unverified (0120), whose one-time
 * claim code is lost if any hop gives up before the answer arrives. The order
 * must hold: this server's whole budget < the browser's wait
 * (OUTREACH_HEALTH_ID_CREATE_UNVERIFIED_BROWSER_TIMEOUT_MS, 45 s) < the
 * gateway's read timeout for the route (gateway/nginx.conf.template, 60 s).
 * health-id-unclaimed.spec.ts checks all three.
 */
export const OUTREACH_HEALTH_ID_CREATE_READ_BUDGET_MS = 5_000;
/** Read before Identity, Identity's wait, read after. */
export const OUTREACH_HEALTH_ID_CREATE_SERVER_BUDGET_MS =
  OUTREACH_HEALTH_ID_CREATE_READ_BUDGET_MS + OUTREACH_HEALTH_ID_CREATE_UNCLAIMED_TIMEOUT_MS
  + OUTREACH_HEALTH_ID_CREATE_READ_BUDGET_MS;

export class ReadBudgetExceeded extends Error {
  constructor() {
    super('The read did not finish within its budget');
    this.name = 'ReadBudgetExceeded';
  }
}

/**
 * The work's result, or ReadBudgetExceeded after budgetMs. The work is not
 * cancelled (its query ends under the pool's own timeouts); only the wait is.
 */
export function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadBudgetExceeded()), budgetMs);
  });
  work.catch(() => undefined);
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
