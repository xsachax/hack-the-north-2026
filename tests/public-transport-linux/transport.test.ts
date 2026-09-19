import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as nodeRequest, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createPublicTransport, PUBLIC_TRANSPORT_LIMITS } from "../../src/server/execution/public-transport";
import { ownedDns, verifyNetworkNamespace } from "../network-fixtures";

const public4 = "93.184.216.34";
const public6 = "2606:4700:4700::1111";
const private4 = "10.77.0.1";
const ips = [public4, public6, private4, "169.254.77.1", "::1", "fd00::1"];

test("real pinned sockets, same-instance DNS flip and reachable private controls in isolated Linux", async () => {
  const scratch = await verifyNetworkNamespace();
  const servers: Server[] = [];
  const sockets = new Set<Duplex>();
  const connections = new Map(ips.map((ip) => [ip, 0]));
  const hits: { ip: string; path: string; host: string }[] = [];
  const broker = createPublicTransport({
    authorize: ({ url }) => ips.some((ip) => new URL(url).hostname === (ip.includes(":") ? `[${ip}]` : ip))
      || new URL(url).hostname === "example.com",
    assertActive: () => {},
    signal: new AbortController().signal,
    limits: { ...PUBLIC_TRANSPORT_LIMITS, requestMs: 2000 },
  });
  let resolver: Awaited<ReturnType<typeof ownedDns>> | undefined;
  let certDirectory: string | undefined;
  try {
    for (const ip of ips) {
      const server = createServer((req, res) => {
        assert.equal(req.socket.localAddress, ip, "Actual socket must terminate on its pinned alias");
        hits.push({ ip, path: req.url ?? "", host: req.headers.host ?? "" });
        if (req.url === "/redirect-private") { res.writeHead(302, { location: `http://${private4}/no-connect` }); res.end(); }
        else if (req.url === "/stall") { res.writeHead(200); res.write("partial"); }
        else res.end(`owned ${ip}`);
      });
      servers.push(server);
      server.on("connection", (socket) => {
        connections.set(ip, connections.get(ip)! + 1);
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: ip, port: 80, ipv6Only: ip.includes(":") }, resolve);
      });
    }
    // Positive controls prove the namespace itself is not the private-IP deny mechanism.
    for (const ip of ips) {
      await new Promise<void>((resolve, reject) => {
        const req = nodeRequest({ hostname: ip, port: 80, path: "/positive-control", agent: false }, (res) => {
          res.resume();
          res.once("end", resolve);
          res.once("error", reject);
        });
        req.once("error", reject);
        req.end();
      });
      expect(connections.get(ip)).toBe(1);
    }
    let flip = true;
    resolver = await ownedDns({
      names: ["example.com", "wrong.example.com"], addresses: [public4],
      onAnswer: (type) => {
        // Flip immediately after serializing the first A answer, BEFORE the
        // transport can open a socket. Any second unchecked lookup is unsafe.
        if (flip && type === 1) { flip = false; resolver!.setAddresses([private4]); }
      },
    });
    const request = (url: string, signal?: AbortSignal) => broker.request({ url, method: "GET", kind: "navigation", signal });
    const first = await request("http://example.com/pinned");
    expect(first.body.toString()).toBe(`owned ${public4}`);
    expect(hits.at(-1)).toEqual({ ip: public4, path: "/pinned", host: "example.com" });
    expect(resolver.questions.filter(({ type }) => type === 1)).toHaveLength(1);
    expect(resolver.questions.filter(({ type }) => type === 28)).toHaveLength(1);
    const before = [...connections];
    await expect(request("http://example.com/rebound")).rejects.toMatchObject({ code: "unsafe_destination" });
    expect([...connections]).toEqual(before);
    expect(resolver.answers).toEqual([public4, private4]);
    expect(resolver.questions.filter(({ type }) => type === 1)).toHaveLength(2);
    expect(resolver.questions.filter(({ type }) => type === 28)).toHaveLength(2);

    for (const answers of [[public4, private4], [public4, "fd00::1"], [public4, "64:ff9b::a4d:1"]]) {
      resolver.setAddresses(answers);
      await expect(request("http://example.com/mixed")).rejects.toMatchObject({ code: "unsafe_destination" });
      expect([...connections]).toEqual(before);
    }
    resolver.setAddresses([public6]);
    expect((await request("http://example.com/ipv6")).body.toString()).toBe(`owned ${public6}`);
    expect((await request(`http://[${public6}]/literal`)).body.toString()).toBe(`owned ${public6}`);
    const noDns = resolver.questions.length;
    for (const ip of ips.slice(2)) {
      await expect(request(`http://${ip.includes(":") ? `[${ip}]` : ip}/blocked`)).rejects.toMatchObject({ code: "unsafe_destination" });
      expect(connections.get(ip)).toBe(1);
    }
    await expect(request("http://0x7f000001/blocked")).rejects.toMatchObject({ code: "invalid_url" });
    expect(resolver.questions).toHaveLength(noDns);
    await expect(request(`http://${public4}/redirect-private`)).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(connections.get(private4)).toBe(1);

    const cancel = new AbortController();
    const pending = request(`http://${public4}/stall`, cancel.signal);
    const aborted = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await expect.poll(() => hits.some(({ path }) => path === "/stall")).toBe(true);
    cancel.abort();
    await aborted;
    await broker.drain();

    certDirectory = await mkdtemp(join(scratch, "broker-tls-"));
    const keyFile = join(certDirectory, "key.pem");
    const certFile = join(certDirectory, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=example.com",
      "-addext", `subjectAltName=DNS:example.com,IP:${public4},IP:${public6}`,
      "-keyout", keyFile, "-out", certFile,
    ], { stdio: "ignore" });
    const certificate = new X509Certificate(await readFile(certFile));
    expect(certificate.checkIP(public4)).toBe(public4);
    expect(certificate.checkIP(public6)).toBe(public6);
    expect(certificate.checkIP("2606:4700:4700::1112")).toBeUndefined();
    const sni: string[] = [];
    const tlsHits: string[] = [];
    for (const ip of [public4, public6, "2606:4700:4700::1112"]) {
      const server = createHttpsServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, (req, res) => {
        assert.equal(req.socket.localAddress, ip);
        tlsHits.push(req.url ?? "");
        res.end("owned TLS");
      });
      servers.push(server);
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      server.on("secureConnection", (socket) => { if ("servername" in socket) sni.push(String(socket.servername)); });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: ip, port: 443, ipv6Only: ip.includes(":") }, resolve);
      });
    }
    resolver.setAddresses([public4, public6]);
    const probe = (trusted: boolean) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--conditions=react-server", "--import", "tsx", "tests/public-transport-linux/tls-probe.ts",
        trusted ? "--trusted-ca" : "--untrusted-ca",
      ], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: trusted ? certFile : "", NODE_TLS_REJECT_UNAUTHORIZED: "1" },
        stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL",
      });
      let output = "";
      child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
      child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Owned TLS probe failed: ${code}\n${output}`)));
    });
    await probe(false);
    expect(tlsHits).toHaveLength(0);
    await probe(true);
    expect(tlsHits).toEqual(["/tls-positive", "/tls-positive", "/tls-positive"]);
    expect(sni).toContain("example.com");
    expect(resolver.errors).toEqual([]);
    console.log("Offline namespace broker proof: actual public IPv4/IPv6 alias sockets; public-to-private DNS flip; private positive controls; verified TLS/SNI/IP SANs; no external connectivity claim.");
  } finally {
    await broker.close();
    await resolver?.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    if (certDirectory) await rm(certDirectory, { recursive: true, force: true });
  }
});
