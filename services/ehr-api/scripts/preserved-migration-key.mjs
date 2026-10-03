// Match the September migrator's decoding without changing its logical key.
// Generated legacy secret strings decode to 33 bytes; the original migrator
// used the first 32. New runtime keys retain their stricter 32-byte contract.
export function preservedMigrationKey(encoded) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('Invalid preserved migration key encoding');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length < 32 || decoded.toString('base64') !== encoded) throw new Error('Invalid preserved migration key encoding');
  return decoded.subarray(0, 32);
}
