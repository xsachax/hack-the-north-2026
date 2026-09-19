import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { demoCriteria } from "../src/lib/demo-run";

await access(".next/BUILD_ID");
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const address = listener.address();
assert(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
const dataDir = await mkdtemp(join(tmpdir(), "flash-flood-http-"));
const origin = "https://flash-flood.invalid";
const base = `http://127.0.0.1:${port}`;
const accessCode = "offline-fixture-not-a-deployment-access-code";
const server = spawn(process.execPath, [
  resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port),
], {
  env: {
    ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, DATA_DIR: dataDir,
    FLASH_FLOOD_ACCESS_CODE: accessCode, BROWSERBASE_API_KEY: "", BROWSERBASE_PROJECT_ID: "",
    NEXT_TELEMETRY_DISABLED: "1",
    ENABLE_DEMO_RUNS: "true",
  },
  stdio: "ignore",
});
const exited = once(server, "exit");
// Node fetch replaces Host; use HTTP directly to simulate a TLS-terminating proxy.
const request = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Promise<Response>((resolve, reject) => {
    const call = httpRequest(`${base}/api/v1${path}`, {
      method: init.method ?? "GET",
      headers: { host: new URL(origin).host, origin, ...init.headers },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, item);
        }
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }));
      });
    });
    call.on("error", reject);
    call.setTimeout(5000, () => call.destroy(new Error("Offline HTTP request timed out")));
    call.end(init.body);
  });
const jsonHeaders = { "content-type": "application/json" };

try {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (health.ok) break;
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof DOMException)) throw error;
    }
    assert(server.exitCode === null && Date.now() < deadline, "Production server failed to start");
    await delay(100);
  }
  const bootstrap = async () => {
    const response = await request("/session", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ accessCode }),
    });
    assert.equal(response.status, 201);
    const cookie = response.headers.get("set-cookie");
    assert(cookie);
    assert.match(cookie, /^__Host-ff_owner=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    const body = await response.json();
    assert.equal(typeof body.data.csrfToken, "string");
    return { cookie: cookie.split(";")[0], "x-csrf-token": String(body.data.csrfToken) };
  };
  const owner = await bootstrap();
  const other = await bootstrap();
  const listing = await request("/personas", { headers: owner });
  assert.equal(listing.status, 200);
  assert.equal((await listing.json()).data.items.length, 12);
  const profile = {
    name: "Offline HTTP fixture", character: "Careful shopper", device: "desktop",
    techComfort: "medium", patienceSteps: 8, readingStyle: "careful",
    quirks: ["Reads labels"], worries: ["Time"],
  };
  const missingCsrf = await request("/personas", {
    method: "POST", headers: { ...jsonHeaders, cookie: owner.cookie }, body: JSON.stringify(profile),
  });
  assert.equal(missingCsrf.status, 403);
  const created = await request("/personas", {
    method: "POST", headers: { ...jsonHeaders, ...owner }, body: JSON.stringify(profile),
  });
  assert.equal(created.status, 201);
  const persona = (await created.json()).data;
  assert.equal(typeof persona.id, "string");
  const otherList = await request("/personas", { headers: other });
  assert.equal((await otherList.json()).data.items.length, 12);
  assert.equal((await request(`/personas/${persona.id}`, { method: "DELETE", headers: other })).status, 404);
  const updated = await request(`/personas/${persona.id}`, {
    method: "PUT", headers: { ...jsonHeaders, ...owner }, body: JSON.stringify({ ...profile, name: "Edited fixture" }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.name, "Edited fixture");
  assert.equal((await request("/runs", { headers: owner })).status, 200);
  assert.equal((await request("/personas", { headers: { ...owner, origin: "https://foreign.invalid" } })).status, 403);
  const demo = await request("/demo-runs", {
    method: "POST", headers: { ...owner, ...jsonHeaders, "idempotency-key": "offline-demo-run-0001" },
    body: JSON.stringify({
      authorizationAcknowledged: true, scenario: "fixed",
      assignments: [{ personaId: "bargain-hunter", goal: "Apply the advertised coupons", criteria: [demoCriteria[0]] }],
    }),
  });
  assert.equal(demo.status, 201);
  const run = (await demo.json()).data;
  assert.equal(run.executionMode, "controlled-fixture");
  for (const suffix of ["sessions", "summaries", "events", "events/stream"]) {
    assert.equal((await request(`/runs/${run.id}/${suffix}`, { headers: other })).status, 404);
  }
  assert.equal((await request(`/runs/${run.id}/cancel`, {
    method: "POST", headers: { ...owner, ...jsonHeaders }, body: "{}",
  })).status, 200);
  const events = (await (await request(`/runs/${run.id}/events`, { headers: owner })).json()).data.items;
  assert.equal(events.at(-1).kind, "run.finished");
  const stream = await request(`/runs/${run.id}/events/stream?after=0`, { headers: { ...owner, "last-event-id": "1" } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  const streamed = await stream.text();
  assert(!streamed.includes("id: 1\n"));
  assert(streamed.includes(`id: ${events.at(-1).sequence}\n`));
  assert(streamed.includes("event: run.finished"));
  assert(!streamed.includes("browserbase.com"));
  const summaries = (await (await request(`/runs/${run.id}/summaries`, { headers: owner })).json()).data.items;
  assert.equal(summaries[0].reservedSeconds, 0);
  const controlledBody = {
    authorizationAcknowledged: true, controlledSiteId: "project-board",
    assignments: [{
      personaId: persona.id, goal: "Create a synthetic garden project",
      criteria: ["The garden project is visibly listed."],
    }],
  };
  const controlled = await request("/controlled-runs", {
    method: "POST", headers: { ...owner, ...jsonHeaders, "idempotency-key": "offline-board-run-0001" },
    body: JSON.stringify(controlledBody),
  });
  assert.equal(controlled.status, 201);
  const boardRun = (await controlled.json()).data;
  assert.equal(new URL(boardRun.scope.targetUrl).hostname, "board.flash-flood.invalid");
  const attempts = (await (await request(`/runs/${boardRun.id}/attempts`, { headers: owner })).json()).data.items;
  assert.deepEqual(attempts[0].criteria, controlledBody.assignments[0].criteria);
  assert.equal(attempts[0].persona.name, "Edited fixture");
  assert.equal((await request(`/personas/${persona.id}`, { method: "DELETE", headers: owner })).status, 200);
  const immutable = (await (await request(`/runs/${boardRun.id}/attempts`, { headers: owner })).json()).data.items;
  assert.deepEqual(immutable[0].persona, attempts[0].persona);
  assert.equal((await request(`/runs/${boardRun.id}`, { headers: other })).status, 404);
  const badTarget = await request("/controlled-runs", {
    method: "POST", headers: { ...owner, ...jsonHeaders, "idempotency-key": "offline-board-run-0002" },
    body: JSON.stringify({ ...controlledBody, targetUrl: "https://example.com" }),
  });
  assert.equal(badTarget.status, 400);
  assert.equal((await request(`/runs/${boardRun.id}/cancel`, {
    method: "POST", headers: { ...owner, ...jsonHeaders }, body: "{}",
  })).status, 200);
  console.log("Offline production HTTP smoke passed: TLS-proxy Host, sessions, CSRF, CRUD, demo/controlled admission and cancellation, SSE replay and owner isolation. Zero cloud calls.");
} finally {
  server.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
  if (!stopped) {
    server.kill("SIGKILL");
    await exited;
  }
  await rm(dataDir, { recursive: true, force: true });
}
