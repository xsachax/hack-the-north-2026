import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advancedSourceDigest, assertAdvancedBuild, writeAdvancedBuildReceipt } from "../../../scripts/advanced-build";

describe("source and production-build approval binding", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(process.cwd(), ".advanced-build-test-"));
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    await mkdir(join(directory, ".next", "server"), { recursive: true });
    await writeFile(join(directory, ".next", "BUILD_ID"), "offline-build");
    await writeFile(join(directory, ".next", "server", "app.js"), "original build");
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it.each(["next.config.ts", "playwright.config.ts", "vitest.config.ts", "eslint.config.mjs",
    "tests/e2e/acceptance.spec.ts", ".github/workflows/ci.yml", "public/example.js"])(
    "invalidates approval when %s changes", async (file) => {
      const before = await advancedSourceDigest(directory);
      const parts = file.split("/");
      if (parts.length > 1) await mkdir(join(directory, ...parts.slice(0, -1)), { recursive: true });
      await writeFile(join(directory, file), "changed gate or executable input");
      expect(await advancedSourceDigest(directory)).not.toBe(before);
    },
  );
  it("binds the build bytes and rejects a stale source or modified production artifact", async () => {
    const source = await advancedSourceDigest(directory);
    await writeAdvancedBuildReceipt(source, directory);
    await expect(assertAdvancedBuild(source, directory)).resolves.toBeUndefined();
    await expect(assertAdvancedBuild("0".repeat(64), directory)).rejects.toThrow("advanced_build_not_approved_source");
    await writeFile(join(directory, ".next", "server", "app.js"), "modified after build");
    await expect(assertAdvancedBuild(source, directory)).rejects.toThrow("advanced_build_not_approved_source");
  });
  it("cannot stamp a build if its source changed while compilation was running", async () => {
    const before = await advancedSourceDigest(directory);
    await writeFile(join(directory, "next.config.ts"), "changed during build");
    await expect(writeAdvancedBuildReceipt(before, directory)).rejects.toThrow("advanced_source_changed_during_build");
  });
  it("hashes legitimate Next external-package links and refuses links outside dependencies", async () => {
    const dependency = join(directory, "node_modules", "example");
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, "index.js"), "original dependency");
    await symlink(dependency, join(directory, ".next", "external"));
    const source = await advancedSourceDigest(directory);
    await writeAdvancedBuildReceipt(source, directory);
    await expect(assertAdvancedBuild(source, directory)).resolves.toBeUndefined();
    await writeFile(join(dependency, "index.js"), "changed dependency");
    await expect(assertAdvancedBuild(source, directory)).rejects.toThrow("advanced_build_not_approved_source");
    await symlink(join(directory, ".git"), join(directory, ".next", "outside"));
    await expect(writeAdvancedBuildReceipt(source, directory)).rejects.toThrow("advanced_build_link_outside_dependencies");
  });
});
