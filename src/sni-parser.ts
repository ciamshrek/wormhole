/**
 * Extract SNI hostname from a TLS ClientHello message.
 * Used as a fallback/logging helper — the primary SNI path is via
 * tls.createServer's SNICallback which receives the hostname directly.
 */
export function parseSNI(buf: Buffer): string | null {
  // Minimum TLS record: 5 byte header + 1 byte content
  if (buf.length < 6) return null;

  // TLS record: ContentType(1) + Version(2) + Length(2)
  const contentType = buf[0];
  if (contentType !== 0x16) return null; // Not a Handshake record

  const recordLength = buf.readUInt16BE(3);
  if (buf.length < 5 + recordLength) return null;

  // Handshake header: HandshakeType(1) + Length(3)
  let offset = 5;
  const handshakeType = buf[offset];
  if (handshakeType !== 0x01) return null; // Not ClientHello

  offset += 4; // Skip type(1) + length(3)

  // ClientHello: Version(2) + Random(32) = 34 bytes
  if (offset + 34 > buf.length) return null;
  offset += 2 + 32;

  // Session ID: Length(1) + data
  if (offset + 1 > buf.length) return null;
  const sessionIdLength = buf[offset];
  offset += 1;
  if (offset + sessionIdLength > buf.length) return null;
  offset += sessionIdLength;

  // Cipher Suites: Length(2) + data
  if (offset + 2 > buf.length) return null;
  const cipherSuitesLength = buf.readUInt16BE(offset);
  offset += 2;
  if (offset + cipherSuitesLength > buf.length) return null;
  offset += cipherSuitesLength;

  // Compression Methods: Length(1) + data
  if (offset + 1 > buf.length) return null;
  const compressionLength = buf[offset];
  offset += 1;
  if (offset + compressionLength > buf.length) return null;
  offset += compressionLength;

  // Extensions: Length(2)
  if (offset + 2 > buf.length) return null;
  const extensionsLength = buf.readUInt16BE(offset);
  offset += 2;

  const extensionsEnd = Math.min(offset + extensionsLength, buf.length);

  while (offset + 4 <= extensionsEnd) {
    const extType = buf.readUInt16BE(offset);
    const extLength = buf.readUInt16BE(offset + 2);
    offset += 4;

    if (offset + extLength > extensionsEnd) return null;

    if (extType === 0x0000) {
      // SNI extension
      // ServerNameList: Length(2)
      if (offset + 2 > extensionsEnd) return null;
      offset += 2; // Skip list length

      // ServerName: Type(1) + Length(2) + Name
      if (offset + 3 > extensionsEnd) return null;
      const nameType = buf[offset];
      const nameLength = buf.readUInt16BE(offset + 1);
      offset += 3;

      if (nameType === 0x00 && offset + nameLength <= extensionsEnd) {
        return buf.subarray(offset, offset + nameLength).toString("ascii");
      }
      return null;
    }

    offset += extLength;
  }

  return null;
}
