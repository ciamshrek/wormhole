import http from "node:http";
import https from "node:https";
import forge from "node-forge";

const HTTPS_PORT = parseInt(process.env.PORT || "443", 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || "80", 10);

function generateSelfSignedCert() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: "commonName", value: "echo-server" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "subjectAltName", altNames: [{ type: 2, value: "echo-server" }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

const { cert, key } = generateSelfSignedCert();

function echoHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const response = JSON.stringify({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: body || undefined,
    }, null, 2);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(response);
  });
}

const httpsServer = https.createServer({ cert, key }, echoHandler);
const httpServer = http.createServer(echoHandler);

httpsServer.listen(HTTPS_PORT, () => {
  console.log(`[echo-server] HTTPS listening on port ${HTTPS_PORT}`);
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[echo-server] HTTP listening on port ${HTTP_PORT}`);
});
