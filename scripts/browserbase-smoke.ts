import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import nextEnv from "@next/env";
import { z } from "zod";
import { readConfig } from "../src/lib/config";
import { withBrowserSession } from "../src/server/browserbase";
import { safeErrorMessage } from "../src/server/redact";

nextEnv.loadEnvConfig(process.cwd());

async function main() {
  const config = readConfig(process.env);
  const runId = randomUUID();
  const directory = path.resolve(config.DATA_DIR, "smoke", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  console.log("Starting one Browserbase session; at most 120 seconds, two inference calls, one click.");

  const report = await withBrowserSession(
    { ...config, SESSION_TIMEOUT_SECONDS: Math.min(config.SESSION_TIMEOUT_SECONDS, 120) },
    { runId, personaId: "foundation-smoke" },
    async ({ browser, stagehand, sessionId, liveViewUrl, replayUrl }) => {
      // Live-view URLs grant access to a browser. Store privately, never in CI logs.
      await writeFile(path.join(directory, "session.json"), JSON.stringify({
        sessionId, liveViewUrl, replayUrl, startedAt,
      }, null, 2), { mode: 0o600 });
      console.log(`Session created: ${sessionId}`);
      const page = await browser.context.activePage();
      if (!page) throw new Error("Browserbase session has no active page.");
      await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30_000 });

      const { data: extracted } = await stagehand.extract(
        "Return the main heading of this page.",
        z.object({ heading: z.string() }),
        { timeout: 30_000 },
      );
      if (extracted.heading.trim() !== "Example Domain") {
        throw new Error("Gateway extraction did not return the expected Example Domain heading.");
      }
      const { data: actions } = await stagehand.observe(
        "Find the link to learn more about example domains.",
        { timeout: 30_000 },
      );
      const action = actions.find((candidate) => candidate.method === "click");
      if (!action) throw new Error("Stagehand did not observe the expected navigation link.");
      const { data: result } = await stagehand.act(action, { timeout: 30_000 });
      if (!result.success) throw new Error("Stagehand could not perform the observed action.");
      const finalUrl = await page.url();
      const final = new URL(finalUrl);
      if (final.hostname !== "www.iana.org" && final.hostname !== "iana.org") {
        throw new Error("The smoke action did not reach the expected IANA destination.");
      }
      await writeFile(path.join(directory, "final.png"), await page.screenshot(), { mode: 0o600 });
      return {
        runId, sessionId, replayUrl, startedAt,
        completedAt: new Date().toISOString(),
        status: "passed",
        heading: extracted.heading,
        finalUrl,
        metrics: await stagehand.metrics(),
      };
    },
  );
  await writeFile(path.join(directory, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Smoke passed. Browser released. Private evidence: ${directory}`);
}

main().catch((error: unknown) => {
  console.error(`Smoke failed: ${safeErrorMessage(error, [process.env.BROWSERBASE_API_KEY ?? ""])}`);
  process.exitCode = 1;
});
