import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSNI } from "../../src/sni-parser.js";
import {
  buildClientHello,
  buildClientHelloWithoutSNI,
  buildNonHandshakeRecord,
  buildTruncatedClientHello,
} from "../fixtures/tls-client-hello.js";

describe("parseSNI", () => {
  it("extracts hostname from a valid ClientHello with SNI", () => {
    const buf = buildClientHello("example.com");
    assert.equal(parseSNI(buf), "example.com");
  });

  it("handles long subdomain hostnames", () => {
    const hostname = "a.b.c.very-long-subdomain.example.co.uk";
    const buf = buildClientHello(hostname);
    assert.equal(parseSNI(buf), hostname);
  });

  it("handles single-label hostname", () => {
    const buf = buildClientHello("localhost");
    assert.equal(parseSNI(buf), "localhost");
  });

  it("returns null for ClientHello without SNI extension", () => {
    const buf = buildClientHelloWithoutSNI();
    assert.equal(parseSNI(buf), null);
  });

  it("returns null for non-handshake TLS record (content type 0x17)", () => {
    const buf = buildNonHandshakeRecord();
    assert.equal(parseSNI(buf), null);
  });

  it("returns null for buffer too short (< 6 bytes)", () => {
    assert.equal(parseSNI(Buffer.alloc(3)), null);
    assert.equal(parseSNI(Buffer.alloc(5)), null);
  });

  it("returns null for empty buffer", () => {
    assert.equal(parseSNI(Buffer.alloc(0)), null);
  });

  it("returns null for truncated ClientHello", () => {
    const buf = buildTruncatedClientHello();
    assert.equal(parseSNI(buf), null);
  });

  it("returns null when handshake type is not ClientHello (0x01)", () => {
    const buf = buildClientHello("example.com");
    buf[5] = 0x02; // Change to ServerHello
    assert.equal(parseSNI(buf), null);
  });

  it("handles hostname with numbers and hyphens", () => {
    const buf = buildClientHello("app-123.example.com");
    assert.equal(parseSNI(buf), "app-123.example.com");
  });
});
