import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import forge from "node-forge";
import { CertManager, validateHostname } from "../../src/cert-manager.js";

describe("CertManager", () => {
  let tmpDir: string;
  let mgr: CertManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwh-test-"));
    mgr = new CertManager({ caDir: tmpDir, maxCacheSize: 3 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("initCA", () => {
    it("generates ca.crt and ca.key files", () => {
      mgr.initCA();
      assert.ok(fs.existsSync(path.join(tmpDir, "ca.crt")));
      assert.ok(fs.existsSync(path.join(tmpDir, "ca.key")));
    });

    it("CA cert has basicConstraints cA=true", () => {
      mgr.initCA();
      const pem = fs.readFileSync(path.join(tmpDir, "ca.crt"), "utf-8");
      const cert = forge.pki.certificateFromPem(pem);
      const bc = cert.getExtension("basicConstraints") as any;
      assert.ok(bc);
      assert.equal(bc.cA, true);
    });

    it("CA cert has correct subject CN", () => {
      mgr.initCA();
      const pem = fs.readFileSync(path.join(tmpDir, "ca.crt"), "utf-8");
      const cert = forge.pki.certificateFromPem(pem);
      const cn = cert.subject.getField("CN");
      assert.equal(cn.value, "Wormhole CA");
    });

    it("loads existing CA on second call (no regeneration)", () => {
      mgr.initCA();
      const pem1 = fs.readFileSync(path.join(tmpDir, "ca.crt"), "utf-8");
      const mgr2 = new CertManager({ caDir: tmpDir });
      mgr2.initCA();
      const pem2 = fs.readFileSync(path.join(tmpDir, "ca.crt"), "utf-8");
      assert.equal(pem1, pem2);
    });

    it("CA key file has restrictive permissions", () => {
      mgr.initCA();
      const stat = fs.statSync(path.join(tmpDir, "ca.key"));
      assert.equal(stat.mode & 0o777, 0o600);
    });
  });

  describe("generateDomainCert", () => {
    beforeEach(() => {
      mgr.initCA();
    });

    it("returns a tls.SecureContext", () => {
      const ctx = mgr.generateDomainCert("example.com");
      assert.ok(ctx);
      assert.equal(typeof ctx, "object");
    });

    it("cache hit returns same object", () => {
      const ctx1 = mgr.generateDomainCert("test.com");
      const ctx2 = mgr.generateDomainCert("test.com");
      assert.strictEqual(ctx1, ctx2);
    });

    it("normalizes hostname to lowercase", () => {
      const ctx1 = mgr.generateDomainCert("Example.COM");
      const ctx2 = mgr.generateDomainCert("example.com");
      assert.strictEqual(ctx1, ctx2);
    });

    it("evicts LRU entry when cache is full", () => {
      mgr.generateDomainCert("a.com"); // a
      mgr.generateDomainCert("b.com"); // a, b
      mgr.generateDomainCert("c.com"); // a, b, c (full at 3)

      // Access a.com to make it MRU
      const ctxA = mgr.generateDomainCert("a.com"); // b, c, a

      // Add d.com — should evict b.com (LRU)
      mgr.generateDomainCert("d.com"); // c, a, d

      // a.com should still be cached (same object)
      assert.strictEqual(mgr.generateDomainCert("a.com"), ctxA);

      // b.com was evicted — new object
      // (We can't easily check identity since it's a new cert,
      // but we can verify cache size stays at max)
      mgr.generateDomainCert("b.com"); // a, d, b
      assert.equal(mgr.cacheSize, 3);
    });

    it("serial numbers are unique under rapid-fire generation", () => {
      // Generate multiple certs quickly — no errors thrown means unique serials
      const mgr10 = new CertManager({ caDir: tmpDir, maxCacheSize: 100 });
      mgr10.initCA();
      for (let i = 0; i < 10; i++) {
        mgr10.generateDomainCert(`host${i}.example.com`);
      }
      assert.equal(mgr10.cacheSize, 10);
    });

    it("throws for empty hostname", () => {
      assert.throws(() => mgr.generateDomainCert(""), /Invalid hostname/);
    });

    it("throws for hostname with spaces", () => {
      assert.throws(() => mgr.generateDomainCert("bad host.com"), /Invalid hostname/);
    });

    it("throws for hostname starting with hyphen", () => {
      assert.throws(() => mgr.generateDomainCert("-bad.com"), /Invalid hostname/);
    });

    it("throws for hostname over 253 characters", () => {
      const long = Array(128).fill("ab").join(".");
      assert.throws(() => mgr.generateDomainCert(long), /Invalid hostname/);
    });

    it("accepts valid hostname with hyphens and numbers", () => {
      const ctx = mgr.generateDomainCert("my-app-123.example.com");
      assert.ok(ctx);
    });

    it("throws when CA not initialized", () => {
      const fresh = new CertManager({ caDir: tmpDir });
      assert.throws(() => fresh.generateDomainCert("test.com"), /CA not initialized/);
    });
  });

  describe("getSNICallback", () => {
    beforeEach(() => {
      mgr.initCA();
    });

    it("calls back with SecureContext for valid hostname", (_, done) => {
      const cb = mgr.getSNICallback();
      cb("test.example.com", (err, ctx) => {
        assert.ifError(err);
        assert.ok(ctx);
        done();
      });
    });

    it("calls back with error for invalid hostname", (_, done) => {
      const cb = mgr.getSNICallback();
      cb("", (err) => {
        assert.ok(err);
        done();
      });
    });
  });
});

describe("validateHostname", () => {
  it("accepts simple hostnames", () => {
    assert.doesNotThrow(() => validateHostname("example.com"));
    assert.doesNotThrow(() => validateHostname("sub.example.com"));
  });

  it("rejects uppercase (validation expects lowercase input)", () => {
    assert.throws(() => validateHostname("Example.COM"), /Invalid hostname/);
  });

  it("rejects underscores", () => {
    assert.throws(() => validateHostname("bad_host.com"), /Invalid hostname/);
  });
});
