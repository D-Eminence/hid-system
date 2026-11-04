/**
 * CARD_LINKS_ENABLED (0118): on since the owner's decision of 4 Nov 2026
 * after legal approval (D13); false switches it off. While false, GET
 * /api/v1/card-share/records answers a plain 404 and nothing reads in a
 * card-share transaction, so the image can run on a database without 0118.
 * It reads only its own variable (anything but exactly 'false' is on);
 * main.ts still refuses a malformed value at boot.
 */
export function cardLinksEnabled(): boolean {
  return process.env.CARD_LINKS_ENABLED !== 'false';
}
