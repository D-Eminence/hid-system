import { createHash } from 'node:crypto';
import { DomainProblem } from '../common/problem';
import { chunk, segment, syntheticJpeg, syntheticPng } from '../../test/profile-photo.fixtures';
import { inspectProfilePhoto, jpegSize, PROFILE_PHOTO_MAX_BYTES, pngSize } from './profile-photo';

function refused(mediaType: unknown, data: unknown) {
  try {
    inspectProfilePhoto(mediaType, data);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainProblem);
    expect((error as DomainProblem).getStatus()).toBe(400);
    expect((error as DomainProblem).code).toBe('PHOTO_INVALID');
    return;
  }
  throw new Error('The photo was admitted');
}

describe('Profile photo checks (0094)', () => {
  it('admits the browser\'s 512 x 512 JPEG and a PNG, reading the size from SOF and IHDR, with the sha256', () => {
    const jpeg = syntheticJpeg(512, 512);
    expect(inspectProfilePhoto('image/jpeg', jpeg.toString('base64'))).toEqual({ mediaType: 'image/jpeg',
      bytes: jpeg, width: 512, height: 512, sha256: createHash('sha256').update(jpeg).digest('hex') });
    const progressive = syntheticJpeg(640, 480, { frame: 0xc2 });
    expect(jpegSize(progressive)).toEqual({ width: 640, height: 480 });
    const png = syntheticPng(1024, 300);
    expect(inspectProfilePhoto('image/png', png.toString('base64'))).toMatchObject({ mediaType: 'image/png',
      width: 1024, height: 300 });
    expect(pngSize(png)).toEqual({ width: 1024, height: 300 });
  });

  it('refuses a type its magic bytes do not prove, or any other type', () => {
    refused('image/png', syntheticJpeg(512, 512).toString('base64'));
    refused('image/jpeg', syntheticPng(512, 512).toString('base64'));
    refused('image/gif', Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1').toString('base64'));
    refused('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'));
    refused(undefined, syntheticJpeg(512, 512).toString('base64'));
  });

  it('refuses more than 300 KB, and sides of 0 or more than 1024 pixels', () => {
    const big = syntheticJpeg(512, 512, { scanBytes: PROFILE_PHOTO_MAX_BYTES });
    expect(big.length).toBeGreaterThan(PROFILE_PHOTO_MAX_BYTES);
    refused('image/jpeg', big.toString('base64'));
    const largest = syntheticJpeg(512, 512, { scanBytes: PROFILE_PHOTO_MAX_BYTES - 200 });
    expect(largest.length).toBeLessThanOrEqual(PROFILE_PHOTO_MAX_BYTES);
    expect(inspectProfilePhoto('image/jpeg', largest.toString('base64')).bytes.length).toBe(largest.length);
    refused('image/jpeg', syntheticJpeg(1025, 512).toString('base64'));
    refused('image/jpeg', syntheticJpeg(512, 0).toString('base64'));
    refused('image/png', syntheticPng(512, 4096).toString('base64'));
  });

  it('refuses anything after the image (a polyglot) and a truncated file', () => {
    const jpeg = syntheticJpeg(512, 512);
    refused('image/jpeg', Buffer.concat([jpeg, Buffer.from('PK\u0003\u0004 appended archive', 'latin1')]).toString('base64'));
    refused('image/jpeg', jpeg.subarray(0, jpeg.length - 2).toString('base64'));
    const png = syntheticPng(512, 512);
    refused('image/png', Buffer.concat([png, Buffer.from('<script>alert(1)</script>')]).toString('base64'));
    refused('image/png', png.subarray(0, 40).toString('base64'));
    // An IEND inside the file followed by more chunks.
    refused('image/png', Buffer.concat([png, chunk('IDAT', Buffer.alloc(4)), png.subarray(png.length - 12)]).toString('base64'));
  });

  it('refuses Exif, XMP and IPTC in a JPEG and Exif or text in a PNG (no location or camera data)', () => {
    refused('image/jpeg', syntheticJpeg(512, 512, {
      extra: [segment(0xe1, Buffer.from('Exif\u0000\u0000MM\u0000*GPS', 'latin1'))] }).toString('base64'));
    refused('image/jpeg', syntheticJpeg(512, 512, {
      extra: [segment(0xed, Buffer.from('Photoshop 3.0\u00008BIM', 'latin1'))] }).toString('base64'));
    refused('image/png', syntheticPng(512, 512, [chunk('eXIf', Buffer.alloc(8))]).toString('base64'));
    refused('image/png', syntheticPng(512, 512, [chunk('tEXt', Buffer.from('Comment\u0000hello', 'latin1'))]).toString('base64'));
    // An ICC profile (APP2) is no metadata about the person: admitted.
    expect(inspectProfilePhoto('image/jpeg', syntheticJpeg(512, 512, {
      extra: [segment(0xe2, Buffer.from('ICC_PROFILE\u0000', 'latin1'))] }).toString('base64')).width).toBe(512);
  });

  it('refuses bad or non-canonical base64, an empty body and a non-string', () => {
    const base64 = syntheticJpeg(512, 512).toString('base64');
    refused('image/jpeg', `${base64.slice(0, 10)}*${base64.slice(11)}`);
    refused('image/jpeg', `data:image/jpeg;base64,${base64}`);
    refused('image/jpeg', base64.slice(0, -1));
    refused('image/jpeg', '');
    refused('image/jpeg', 12345);
    refused('image/jpeg', `${base64}\n`);
  });

  it('refuses a JPEG with two frames or a segment that runs past the end', () => {
    const frame = Buffer.alloc(15);
    frame.writeUInt16BE(10, 1);
    frame.writeUInt16BE(10, 3);
    refused('image/jpeg', syntheticJpeg(512, 512, { extra: [segment(0xc0, frame)] }).toString('base64'));
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x7f, 0xff]), Buffer.alloc(10), Buffer.from([0xff, 0xd9])]);
    refused('image/jpeg', broken.toString('base64'));
  });
});
