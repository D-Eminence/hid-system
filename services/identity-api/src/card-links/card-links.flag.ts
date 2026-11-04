/**
 * CARD_LINKS_ENABLED (0118): off by default, and until legal signs off (NDPA,
 * D13). While off every card-link route answers a plain 404, nothing is
 * written or sent and the sweeper is idle, so this image also runs on a
 * database without 0118. It reads only its own variable (exactly 'true' is
 * on), as ehr-api's patient-entries.flag.ts does; main.ts still refuses a
 * malformed value at boot, where the whole environment is validated.
 */
export function cardLinksEnabled(): boolean {
  return process.env.CARD_LINKS_ENABLED === 'true';
}
