import { downloadFileName, SNIFF_PREFIX_BYTES, sniffMediaType } from './media-sniff';

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (value: string) => Uint8Array.from(Buffer.from(value, 'latin1'));

describe('sniffMediaType: the real type from the first bytes (owner decision D3)', () => {
  it('reads 1 KB, as the design pins the ranged GET', () => {
    expect(SNIFF_PREFIX_BYTES).toBe(1024);
  });

  it.each([
    ['application/pdf', ascii('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')],
    ['image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)],
    ['image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00)],
    ['image/tiff', bytes(0x49, 0x49, 0x2a, 0x00, 0x08, 0x00)],
    ['image/tiff', bytes(0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00)],
  ])('recognises %s at byte 0', (expected, prefix) => {
    expect(sniffMediaType(prefix)).toBe(expected);
  });

  it.each([
    ['an empty read', bytes()],
    ['HTML', ascii('<!doctype html><script>alert(1)</script>')],
    ['SVG', ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['a GIF', ascii('GIF89a')],
    ['a ZIP (and so DOCX)', bytes(0x50, 0x4b, 0x03, 0x04)],
    ['a PDF with bytes before its header (refused, the safer reading)', ascii('\n%PDF-1.4')],
    ['a truncated PNG signature', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a)],
    ['a truncated JPEG signature', bytes(0xff, 0xd8)],
    ['"%PDF" without its dash', ascii('%PDF1.7')],
    ['a TIFF byte order without its magic', bytes(0x49, 0x49, 0x2b, 0x00)],
  ])('answers null for %s', (_name, prefix) => {
    expect(sniffMediaType(prefix)).toBeNull();
  });
});

describe('downloadFileName: the extension follows the detected type', () => {
  it.each([
    ['scan.pdf', 'application/pdf', 'scan.pdf'],
    ['photo.jpeg', 'image/jpeg', 'photo.jpeg'],
    ['photo.JPG', 'image/jpeg', 'photo.JPG'],
    ['scan.png', 'image/jpeg', 'scan.jpg'],
    ['scan.pdf', 'image/png', 'scan.png'],
    ['fax.tiff', 'image/tiff', 'fax.tiff'],
    ['fax.jpg', 'image/tiff', 'fax.tif'],
    ['report', 'application/pdf', 'report.pdf'],
    ['report.docx', 'application/pdf', 'report.docx.pdf'],
    ['résumé du patient.png', 'image/png', 'r_sum__du_patient.png'],
    ['.png', 'image/png', 'document.png'],
    ['a"b\r\nc.pdf', 'application/pdf', 'a_b__c.pdf'],
  ] as const)('%s detected as %s downloads as %s', (name, type, expected) => {
    expect(downloadFileName(name, type)).toBe(expected);
  });

  it('keeps at most 120 characters and the right extension', () => {
    const name = downloadFileName(`${'x'.repeat(200)}.png`, 'image/jpeg');
    expect(name).toHaveLength(120);
    expect(name.endsWith('.jpg')).toBe(true);
    expect(downloadFileName(`${'y'.repeat(130)}.pdf`, 'application/pdf')).toBe(`${'y'.repeat(116)}.pdf`);
  });
});
