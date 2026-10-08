import { csvDocument, csvField } from './csv';

describe('RFC 4180 CSV', () => {
  it('ends every record, including the last, with CRLF', () => {
    expect(csvDocument([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d\r\n');
  });

  it.each([
    ['plain', 'plain'],
    ['comma, value', '"comma, value"'],
    ['quote "inside"', '"quote ""inside"""'],
    ['line\nbreak', '"line\nbreak"'],
    ['carriage\rreturn', '"carriage\rreturn"'],
    [null, ''],
    [undefined, ''],
    [42, '42'],
  ])('quotes %j as %j', (value, expected) => {
    expect(csvField(value)).toBe(expected);
  });

  it('does not treat a literal backslash-n as a line break', () => {
    expect(csvField('C:\\new\\report')).toBe('C:\\new\\report');
  });

  it.each([
    ['=1+1', "'=1+1"],
    ['+SUM(A1)', "'+SUM(A1)"],
    ['-2+3', "'-2+3"],
    ['@cmd', "'@cmd"],
    ['\tTAB', "'\tTAB"],
    ['\r=evil', `"'\r=evil"`],
    ['=HYPERLINK("http://x","y")', `"'=HYPERLINK(""http://x"",""y"")"`],
    ['safe=value', 'safe=value'],
  ])('neutralizes the formula prefix in %j', (value, expected) => {
    expect(csvField(value)).toBe(expected);
  });
});
