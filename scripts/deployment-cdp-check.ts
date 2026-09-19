import { lstat, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";

export async function checkCdpScratch(): Promise<void> {
  const scratch = tmpdir();
  const info = await lstat(scratch);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) ||
    (process.getuid && info.uid !== process.getuid())) throw new Error("deployment_cdp_scratch_not_private");
  const before = new Set(await readdir(scratch));
  let reached = false;
  const stub = createServer((_request, response) => {
    reached = true;
    response.writeHead(503);
    response.end("offline CDP stub");
  });
  await new Promise<void>((done, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", done);
  });
  try {
    const address = stub.address();
    if (!address || typeof address === "string") throw new Error("deployment_cdp_stub_missing");
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${address.port}`, { timeout: 3000 });
      await browser.close();
      throw new Error("deployment_cdp_stub_unexpected_success");
    } catch (error) {
      if (!reached || !(error instanceof Error) || !error.message.includes("503")) {
        throw new Error("deployment_cdp_scratch_or_transport_failed");
      }
    }
    const added = (await readdir(scratch)).filter((file) => !before.has(file));
    if (added.length) throw new Error("deployment_cdp_scratch_cleanup_failed");
  } finally {
    stub.closeAllConnections();
    await new Promise<void>((done, reject) => stub.close((error) => error ? reject(error) : done()));
  }
}

await checkCdpScratch();
console.log("offline_real_playwright_cdp_scratch_pass");
