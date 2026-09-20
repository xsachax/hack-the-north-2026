import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { packagedReleaseDeployment, assertPackagePath } from "./release-runtime";
import { releasePolicy, readReleaseLedger } from "./release-proof";
import { writePrivateJson } from "./advanced-proof";

process.umask(0o077);
const directory = resolve("data", `release-package-check-${randomUUID()}`);
await mkdir(directory, { mode: 0o700 });
const packagePath = await assertPackagePath(process.env.RELEASE_PACKAGE_DIR ?? "data/release-package");
const deployment = packagedReleaseDeployment(packagePath, { apiKey: "", projectId: "", replayOrigins: "" });
const digest = await deployment.verifyPackage();
execFileSync(process.execPath, [
  "--conditions=react-server", "--require", resolve("tests/native-sdk-offline-guard.cjs"),
  "--import", "tsx", "scripts/deployment-sdk-check.ts",
], {
  cwd: packagePath, stdio: "pipe", timeout: 20000,
  env: { PATH: process.env.PATH, NODE_ENV: "production", TMPDIR: directory, TSX_DISABLE_CACHE: "1" },
});
const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
const input = {
  directory, dataDir: directory, accessCode: randomBytes(32).toString("hex"),
  policy: releasePolicy, offline: true, signal: controller.signal,
};
const sessionSchema = z.object({ data: z.object({ ownerId: z.uuid(), csrfToken: z.string() }) });
let originalOwner = "", originalCookie = "";
for (let restart = 0; restart < 2; restart++) {
  const runtime = await deployment.start(input);
  try {
    controller.signal.throwIfAborted();
    const context = await runtime.browser.newContext({ ignoreHTTPSErrors: true });
    if (originalCookie) await context.addCookies([{
      name: "__Host-ff_owner", value: originalCookie, url: runtime.origin, httpOnly: true,
      secure: true, sameSite: "Strict",
    }]);
    const session = await context.request.post(`${runtime.origin}/api/v1/session`, {
      data: restart ? {} : { accessCode: input.accessCode }, headers: { Origin: runtime.origin },
      maxRedirects: 0, maxRetries: 0,
    });
    if (!session.ok()) throw new Error("release_package_owner_failed");
    const owner = sessionSchema.parse(await session.json()).data;
    if (restart && owner.ownerId !== originalOwner) throw new Error("release_package_restart_changed_owner");
    originalOwner = owner.ownerId;
    originalCookie = (await context.cookies()).find((cookie) => cookie.name === "__Host-ff_owner")?.value ?? "";
    if (!originalCookie) throw new Error("release_package_owner_cookie_missing");
    const caps = await context.request.get(`${runtime.origin}/api/v1/capabilities`);
    if (!caps.ok()) throw new Error("release_package_capabilities_failed");
    const { data } = await caps.json();
    if (data.websiteExecutionEnabled !== false || data.controlledRunsEnabled !== false || data.browserbaseKeyConfigured !== false) {
      throw new Error("release_package_offline_gate_failed");
    }
    let denied = false;
    try { await runtime.startWorker(); } catch (error) {
      if (!(error instanceof Error) || error.message !== "release_worker_start_forbidden") throw error;
      denied = true;
    }
    if (!denied) throw new Error("release_package_offline_worker_started");
    const page = await context.newPage();
    await page.goto(`${runtime.origin}/`);
    await page.getByLabel("Target mode").waitFor();
    await page.getByText("Website execution is not enabled.", { exact: false }).waitFor();
    await context.close();
  } finally { await runtime.close(); }
}
const db = new DatabaseSync(resolve(directory, "flash-flood.sqlite"), { readOnly: true });
try {
  const ledger = readReleaseLedger(db);
  if (ledger.launches.length || ledger.reservedSeconds) throw new Error("release_package_offline_allocation");
} finally { db.close(); }
await writePrivateJson(resolve(directory, "package-check.json"), {
  packageDigest: digest, actualSupervisor: true, httpsOwnerRestart: true, isolatedSdkWorker: true,
  providerCalls: 0, reservations: 0, paidAcceptance: false,
});
console.log("Clean packaged supervisor HTTPS/owner restart and graceful shutdown passed; zero provider calls.");
process.off("SIGINT", abort);
process.off("SIGTERM", abort);
