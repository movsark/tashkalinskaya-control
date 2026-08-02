import { X509Certificate } from "node:crypto";
import { connect as connectTcp, isIP } from "node:net";
import { connect as connectTls } from "node:tls";

const postgresSslRequest = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new Error("DATABASE_URL is required");
  }

  const url = new URL(connectionString);
  const host = url.hostname;
  const port = Number(url.port || "5432");
  const tcpSocket = connectTcp({ host, port });

  await new Promise<void>((resolve, reject) => {
    tcpSocket.once("error", reject);
    tcpSocket.once("connect", () => tcpSocket.write(postgresSslRequest));
    tcpSocket.once("data", (response) => {
      tcpSocket.removeListener("error", reject);
      if (response[0] !== "S".charCodeAt(0)) {
        reject(new Error("PostgreSQL endpoint rejected the SSL request"));
        return;
      }

      const tlsSocket = connectTls({
        rejectUnauthorized: false,
        ...(isIP(host) === 0 ? { servername: host } : {}),
        socket: tcpSocket,
      });
      tlsSocket.once("error", reject);
      tlsSocket.once("secureConnect", () => {
        const peer = tlsSocket.getPeerCertificate(true);
        if (peer.raw === undefined) {
          reject(new Error("PostgreSQL endpoint did not present a certificate"));
          return;
        }
        const certificate = new X509Certificate(peer.raw);
        process.stdout.write(
          [
            "DB_CERTIFICATE_BEGIN",
            certificate.toString().trim(),
            `DB_CERTIFICATE_SHA256=${certificate.fingerprint256}`,
            `DB_CERTIFICATE_VALID_FROM=${certificate.validFrom}`,
            `DB_CERTIFICATE_VALID_TO=${certificate.validTo}`,
            "DB_CERTIFICATE_END",
            "",
          ].join("\n"),
        );
        tlsSocket.end();
        resolve();
      });
    });
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`DB certificate inspection failed: ${message}\n`);
  process.exitCode = 1;
});
