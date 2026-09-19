import assert from "node:assert/strict";
import { connect, getCACertificates } from "node:tls";
import { createPublicTransport, PUBLIC_TRANSPORT_LIMITS } from "../../src/server/execution/public-transport";
import { verifyNetworkNamespace } from "../network-fixtures";

await verifyNetworkNamespace();
const trusted = process.argv[2] === "--trusted-ca";
assert(trusted || process.argv[2] === "--untrusted-ca");
const broker = createPublicTransport({
  authorize: ({ url }) => ["https://example.com", "https://wrong.example.com", "https://93.184.216.34", "https://[2606:4700:4700::1111]"].includes(new URL(url).origin),
  assertActive: () => {},
  signal: new AbortController().signal,
  limits: { ...PUBLIC_TRANSPORT_LIMITS, requestMs: 2000 },
});
try {
  const request = (url: string) => broker.request({ url, method: "GET", kind: "navigation" });
  if (!trusted) {
    await assert.rejects(request("https://example.com/tls-untrusted"), { code: "network_failure" });
  } else {
    assert(getCACertificates("extra").length > 0, "Owned extra CA must load in the fresh Node process");
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: "93.184.216.34", port: 443, servername: "example.com", rejectUnauthorized: true });
      socket.once("secureConnect", () => {
        assert(socket.authorized, "Independent owned TLS control must verify the certificate");
        socket.end();
      });
      socket.once("close", () => resolve());
      socket.once("error", (error: NodeJS.ErrnoException) => reject(new Error(`owned_tls_control_${error.code ?? "failed"}`)));
      socket.setTimeout(2000, () => socket.destroy(new Error("owned_tls_control_timeout")));
    });
    console.log("owned_tls_trust_control_passed");
    for (const host of ["example.com", "93.184.216.34", "[2606:4700:4700::1111]"]) {
      console.log(`owned_broker_tls_phase_${host.includes(":") ? "ipv6" : host === "example.com" ? "hostname" : "ipv4"}`);
      const result = await request(`https://${host}/tls-positive`);
      assert.equal(result.status, 200);
      assert.equal(result.body.toString(), "owned TLS");
    }
    await assert.rejects(request("https://wrong.example.com/tls-wrong-name"), { code: "network_failure" });
  }
  console.log(trusted ? "trusted_tls_controls_passed" : "untrusted_tls_control_passed");
} finally { await broker.close(); }
