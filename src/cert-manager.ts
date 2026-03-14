import forge from "node-forge";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const HOSTNAME_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})*$/;

export function validateHostname(hostname: string): void {
  if (!hostname || hostname.length > 253) {
    throw new Error(`Invalid hostname: empty or too long`);
  }
  if (!HOSTNAME_RE.test(hostname)) {
    throw new Error(`Invalid hostname: ${hostname}`);
  }
}

export class CertManager {
  private caCert: forge.pki.Certificate | null = null;
  private caKey: forge.pki.PrivateKey | null = null;
  private certCache = new Map<string, tls.SecureContext>();
  private serialCounter = 0;
  private maxCacheSize: number;
  private caDir: string;

  constructor(opts?: { caDir?: string; maxCacheSize?: number }) {
    this.caDir = opts?.caDir ?? (process.env.MWH_CA_DIR || "/var/lib/mwh-ca");
    this.maxCacheSize = opts?.maxCacheSize ?? 1000;
  }

  get caCertPath(): string {
    return path.join(this.caDir, "ca.crt");
  }

  get caKeyPath(): string {
    return path.join(this.caDir, "ca.key");
  }

  initCA(): void {
    fs.mkdirSync(this.caDir, { recursive: true });

    if (fs.existsSync(this.caCertPath) && fs.existsSync(this.caKeyPath)) {
      const certPem = fs.readFileSync(this.caCertPath, "utf-8");
      const keyPem = fs.readFileSync(this.caKeyPath, "utf-8");
      this.caCert = forge.pki.certificateFromPem(certPem);
      this.caKey = forge.pki.privateKeyFromPem(keyPem);
      console.log("[cert-manager] Loaded existing CA from", this.caDir);
      return;
    }

    console.log("[cert-manager] Generating new CA...");
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

    const attrs = [
      { name: "commonName", value: "Wormhole CA" },
      { name: "organizationName", value: "wormhole" },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    cert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      { name: "subjectKeyIdentifier" },
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    fs.writeFileSync(this.caCertPath, certPem);
    fs.writeFileSync(this.caKeyPath, keyPem, { mode: 0o600 });

    this.caCert = cert;
    this.caKey = keys.privateKey;
    console.log("[cert-manager] CA written to", this.caDir);
  }

  private nextSerial(): string {
    this.serialCounter++;
    // Serial must be valid hex (ASN.1 integer). Pad counter to avoid collisions.
    return Date.now().toString(16) + this.serialCounter.toString(16).padStart(4, "0");
  }

  generateDomainCert(rawHostname: string): tls.SecureContext {
    const hostname = rawHostname.toLowerCase();
    validateHostname(hostname);

    // LRU: on cache hit, delete + re-set to promote to MRU
    const cached = this.certCache.get(hostname);
    if (cached) {
      this.certCache.delete(hostname);
      this.certCache.set(hostname, cached);
      return cached;
    }

    // Evict LRU (first entry in Map) if cache is full
    if (this.certCache.size >= this.maxCacheSize) {
      const firstKey = this.certCache.keys().next().value!;
      this.certCache.delete(firstKey);
    }

    if (!this.caCert || !this.caKey) {
      throw new Error("CA not initialized. Call initCA() first.");
    }

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = this.nextSerial();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

    cert.setSubject([{ name: "commonName", value: hostname }]);
    cert.setIssuer(this.caCert.subject.attributes);

    cert.setExtensions([
      { name: "subjectAltName", altNames: [{ type: 2, value: hostname }] },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
    ]);

    cert.sign(this.caKey as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

    const ctx = tls.createSecureContext({
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
    });

    this.certCache.set(hostname, ctx);
    console.log("[cert-manager] Generated cert for", hostname);
    return ctx;
  }

  getSNICallback(): (
    hostname: string,
    cb: (err: Error | null, ctx?: tls.SecureContext) => void
  ) => void {
    return (hostname, cb) => {
      try {
        const ctx = this.generateDomainCert(hostname);
        cb(null, ctx);
      } catch (err) {
        console.error("[cert-manager] SNICallback error for", hostname, err);
        cb(err as Error);
      }
    };
  }

  getCACertPath(): string {
    return this.caCertPath;
  }

  /** Exposed for testing */
  get cacheSize(): number {
    return this.certCache.size;
  }
}

// Default singleton for production use
const defaultManager = new CertManager();

export function initCA(): void {
  defaultManager.initCA();
}
export function generateDomainCert(hostname: string): tls.SecureContext {
  return defaultManager.generateDomainCert(hostname);
}
export function getSNICallback() {
  return defaultManager.getSNICallback();
}
export function getCACertPath(): string {
  return defaultManager.getCACertPath();
}
