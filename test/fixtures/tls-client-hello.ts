/**
 * Build byte-accurate TLS ClientHello buffers for SNI parser tests.
 */

function buildSNIExtension(hostname: string): Buffer {
  const nameBytes = Buffer.from(hostname, "ascii");
  // ServerName entry: type(1) + length(2) + name
  const nameEntry = Buffer.alloc(3 + nameBytes.length);
  nameEntry[0] = 0x00; // host_name type
  nameEntry.writeUInt16BE(nameBytes.length, 1);
  nameBytes.copy(nameEntry, 3);

  // ServerNameList: length(2) + entries
  const nameList = Buffer.alloc(2 + nameEntry.length);
  nameList.writeUInt16BE(nameEntry.length, 0);
  nameEntry.copy(nameList, 2);

  // Extension: type(2) + length(2) + data
  const ext = Buffer.alloc(4 + nameList.length);
  ext.writeUInt16BE(0x0000, 0); // SNI extension type
  ext.writeUInt16BE(nameList.length, 2);
  nameList.copy(ext, 4);

  return ext;
}

function buildExtensionsBlock(extensions: Buffer[]): Buffer {
  const totalLen = extensions.reduce((sum, e) => sum + e.length, 0);
  const block = Buffer.alloc(2 + totalLen);
  block.writeUInt16BE(totalLen, 0);
  let offset = 2;
  for (const ext of extensions) {
    ext.copy(block, offset);
    offset += ext.length;
  }
  return block;
}

function buildClientHelloBody(extensions?: Buffer): Buffer {
  const parts: Buffer[] = [];

  // Client version: TLS 1.2 (0x0303)
  const version = Buffer.from([0x03, 0x03]);
  parts.push(version);

  // Random: 32 bytes
  const random = Buffer.alloc(32, 0xab);
  parts.push(random);

  // Session ID: length=0
  parts.push(Buffer.from([0x00]));

  // Cipher suites: length=4, two suites
  const cipherSuites = Buffer.alloc(6);
  cipherSuites.writeUInt16BE(4, 0);
  cipherSuites.writeUInt16BE(0x002f, 2); // TLS_RSA_WITH_AES_128_CBC_SHA
  cipherSuites.writeUInt16BE(0x0035, 4); // TLS_RSA_WITH_AES_256_CBC_SHA
  parts.push(cipherSuites);

  // Compression methods: length=1, null compression
  parts.push(Buffer.from([0x01, 0x00]));

  // Extensions (optional)
  if (extensions) {
    parts.push(extensions);
  }

  return Buffer.concat(parts);
}

function wrapInHandshake(body: Buffer): Buffer {
  // Handshake: type(1) + length(3)
  const header = Buffer.alloc(4);
  header[0] = 0x01; // ClientHello
  header[1] = (body.length >> 16) & 0xff;
  header[2] = (body.length >> 8) & 0xff;
  header[3] = body.length & 0xff;
  return Buffer.concat([header, body]);
}

function wrapInTLSRecord(handshake: Buffer): Buffer {
  // TLS record: content_type(1) + version(2) + length(2)
  const header = Buffer.alloc(5);
  header[0] = 0x16; // Handshake
  header.writeUInt16BE(0x0301, 1); // TLS 1.0 record layer version
  header.writeUInt16BE(handshake.length, 3);
  return Buffer.concat([header, handshake]);
}

/** Valid ClientHello with SNI extension */
export function buildClientHello(hostname: string): Buffer {
  const sniExt = buildSNIExtension(hostname);
  const extensions = buildExtensionsBlock([sniExt]);
  const body = buildClientHelloBody(extensions);
  const handshake = wrapInHandshake(body);
  return wrapInTLSRecord(handshake);
}

/** Valid ClientHello without any extensions */
export function buildClientHelloWithoutSNI(): Buffer {
  const body = buildClientHelloBody(); // no extensions
  const handshake = wrapInHandshake(body);
  return wrapInTLSRecord(handshake);
}

/** TLS record with Application Data content type (0x17) instead of Handshake */
export function buildNonHandshakeRecord(): Buffer {
  const payload = Buffer.alloc(10, 0x00);
  const header = Buffer.alloc(5);
  header[0] = 0x17; // Application Data
  header.writeUInt16BE(0x0301, 1);
  header.writeUInt16BE(payload.length, 3);
  return Buffer.concat([header, payload]);
}

/** ClientHello truncated mid-way through the handshake header */
export function buildTruncatedClientHello(): Buffer {
  const buf = buildClientHello("example.com");
  // Truncate to just the TLS record header + partial handshake
  return buf.subarray(0, 8);
}
