/**
 * The blind compare of facility-assisted registration (ADR-063): the name
 * and date of birth a staff member types from an original photo ID against
 * the NIN record, answered per field as match, no_match or not_in_record and
 * never with a record value. The typed values are not stored.
 */
export type NameResult = 'match' | 'no_match';
export type DateOfBirthResult = 'match' | 'no_match' | 'not_in_record';
export interface DocumentDetails { firstName: string; lastName: string; dateOfBirth?: string }
export interface RecordDetails { firstName?: unknown; lastName?: unknown; dateOfBirth?: unknown }
export interface DocumentMatch {
  matched: boolean;
  firstName: NameResult;
  lastName: NameResult;
  dateOfBirth: DateOfBirthResult;
}

/**
 * NFKD, combining marks dropped, upper case, then only A-Z and single
 * spaces kept. A name with nothing left (another script, say) is '' and never
 * matches.
 */
export function normalizeDocumentName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    .replace(/[^A-Z\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Names match when the document's {first, last} is the record's {first,
 * last} in either order. Each field is reported in the order that matches
 * more of them (the order as given on a tie). The date of birth is compared
 * only when the record has one; a record date the document lacks is no_match.
 */
export function matchDocument(document: DocumentDetails, record: RecordDetails): DocumentMatch {
  const [first, last] = [normalizeDocumentName(document.firstName), normalizeDocumentName(document.lastName)];
  const [recordFirst, recordLast] = [normalizeDocumentName(record.firstName), normalizeDocumentName(record.lastName)];
  const same = (left: string, right: string) => left !== '' && left === right;
  const straight = [same(first, recordFirst), same(last, recordLast)] as const;
  const swapped = [same(first, recordLast), same(last, recordFirst)] as const;
  const score = (pair: readonly [boolean, boolean]) => Number(pair[0]) + Number(pair[1]);
  const names = score(swapped) > score(straight) ? swapped : straight;
  const recordDate = typeof record.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.dateOfBirth)
    ? record.dateOfBirth : null;
  const dateOfBirth: DateOfBirthResult = recordDate === null ? 'not_in_record'
    : document.dateOfBirth === recordDate ? 'match' : 'no_match';
  const firstName: NameResult = names[0] ? 'match' : 'no_match';
  const lastName: NameResult = names[1] ? 'match' : 'no_match';
  return { matched: firstName === 'match' && lastName === 'match' && dateOfBirth !== 'no_match',
    firstName, lastName, dateOfBirth };
}
