import { labPayBeforeRefusal } from './lab-accessions.service';

describe('BILL-1 (0167): the lab collection gate', () => {
  it('answers the pay-before refusals in the billing contract\'s words and passes anything else on', () => {
    const required = labPayBeforeRefusal(Object.assign(new Error('PAYMENT_REQUIRED'), { code: 'HB409' }));
    expect([required?.getStatus(), required?.code, required?.message])
      .toEqual([409, 'PAYMENT_REQUIRED', 'This bill must be paid first.']);
    const pending = labPayBeforeRefusal(Object.assign(new Error('PAYMENT_PENDING_CHECK'), { code: 'HB409' }));
    expect([pending?.getStatus(), pending?.code]).toEqual([409, 'PAYMENT_PENDING_CHECK']);
    expect(labPayBeforeRefusal(Object.assign(new Error('OUT_OF_STOCK'), { code: 'HB409' }))).toBeUndefined();
    expect(labPayBeforeRefusal(Object.assign(new Error('PAYMENT_REQUIRED'), { code: '23514' }))).toBeUndefined();
  });
});
