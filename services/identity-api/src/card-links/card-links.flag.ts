/**
 * CARD_LINKS_ENABLED (0118): on since the owner's decision of 4 Nov 2026
 * after legal approval (NDPA, D13); false switches it off. While false every
 * card-link route answers a plain 404, nothing is written or sent and the
 * sweeper is idle, so the image can run on a database without 0118. It reads
 * only its own variable (anything but exactly 'false' is on, as
 * PATIENT_SHARES_ENABLED's default); main.ts still refuses a malformed value
 * at boot, where the whole environment is validated.
 */
export function cardLinksEnabled(): boolean {
  return process.env.CARD_LINKS_ENABLED !== 'false';
}
