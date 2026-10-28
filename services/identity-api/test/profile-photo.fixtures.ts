/**
 * Synthetic JPEG and PNG files for the profile photo specs (0094): the
 * structure the server checks (markers, segments, chunks), no real pixels.
 */
export function segment(marker: number, payload: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

/** A structurally complete JPEG: SOI, JFIF APP0, SOFn (the size), DHT, SOS, scan data, EOI. */
export function syntheticJpeg(width: number, height: number, options: { frame?: number; extra?: Buffer[];
  scanBytes?: number } = {}): Buffer {
  const frame = Buffer.alloc(15);
  frame.writeUInt8(8, 0);
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  frame.writeUInt8(3, 5);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\u0000\u0001\u0001\u0000\u0000\u0001\u0000\u0001\u0000\u0000', 'latin1')),
    ...(options.extra ?? []),
    segment(options.frame ?? 0xc0, frame),
    segment(0xc4, Buffer.alloc(20, 1)),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.alloc(options.scanBytes ?? 64, 0x55),
    Buffer.from([0xff, 0xd9]),
  ]);
}

export function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

export function syntheticPng(width: number, height: number, extra: Buffer[] = []): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), ...extra, chunk('IDAT', Buffer.alloc(32, 7)),
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
}
