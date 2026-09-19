import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicHarnessDigest } from "../../../scripts/public-proof-source";

let directory: string;
const inputs = [
  "scripts/public-integration.ts", "scripts/public-native-offline.ts",
  "tests/native-policy/composed-policy.spec.ts", "tests/public-browser/network.test.ts",
  "playwright.native-policy.config.ts", "vitest.public-browser.config.ts",
  "src/server/execution/native-policy-extension/policy.js",
  "src/server/execution/native-policy-extension/manifest.json",
  ...["API", "EXECUTION", "CAPABILITIES", "WORKER", "DELIVERY_PLAN"].map((name) => `docs/${name}.md`),
];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ff-public-harness-"));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  for (const file of [...inputs, ".next/BUILD_ID"]) {
    await mkdir(dirname(join(directory, file)), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, file), "original\n", { mode: 0o600 });
  }
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("separate public proof-harness approval binding", () => {
  it.each(inputs)("invalidates %s changes with unchanged BUILD_ID", async (file) => {
    const before = await publicHarnessDigest(directory);
    await writeFile(join(directory, file), "changed\n", { mode: 0o600 });
    expect(await publicHarnessDigest(directory)).not.toBe(before);
    expect(await readFile(join(directory, ".next/BUILD_ID"), "utf8")).toBe("original\n");
  });
  it("does not treat private ignored environment files as public proof inputs", async () => {
    await writeFile(join(directory, ".gitignore"), ".env.local\n");
    const before = await publicHarnessDigest(directory);
    await writeFile(join(directory, ".env.local"), "PRIVATE_OFFLINE_FIXTURE=not-a-credential\n", { mode: 0o600 });
    expect(await publicHarnessDigest(directory)).toBe(before);
  });
});
