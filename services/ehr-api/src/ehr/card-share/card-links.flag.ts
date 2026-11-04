/**
 * CARD_LINKS_ENABLED (0118, off by default and until legal signs off, D13).
 * While off, GET /api/v1/card-share/records answers a plain 404 and nothing
 * reads in a card-share transaction, so this image also runs on a database
 * without 0118. It reads only its own variable (exactly 'true' is on), as
 * patient-entries.flag.ts does; main.ts still refuses a malformed value at boot.
 */
export function cardLinksEnabled(): boolean {
  return process.env.CARD_LINKS_ENABLED === 'true';
}
