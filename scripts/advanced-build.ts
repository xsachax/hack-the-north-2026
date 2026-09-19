import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

const receiptSchema = z.strictObject({
  version: z.literal(1), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  buildDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const receiptName = "advanced-build-receipt.json";

export async function advancedSourceDigest(cwd = process.cwd()): Promise<string> {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--",
    "src", "scripts", "tests", "public", "package.json", "package-lock.json", "tsconfig.json",
    "next.config.*", "next-env.d.ts", "playwright.config.*", "vitest.config.*", "eslint.config.*",
    ".nvmrc", ".github/workflows",
  ], { cwd, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const digest = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    digest.update(file).update("\0").update(await readFile(join(cwd, file))).update("\0");
  }
  return digest.digest("hex");
}

async function buildDigest(cwd: string): Promise<string> {
  const root = join(cwd, ".next");
  const excluded = new Set(["cache", "dev", "diagnostics", "types", "trace", "trace-build", "lock", receiptName]);
  const digest = createHash("sha256");
  const modules = resolve(cwd, "node_modules");
  async function walk(directory: string, prefix: string, ancestors: readonly string[]): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && excluded.has(entry.name)) continue;
      const path = join(prefix, entry.name), absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(absolute);
        const inside = relative(modules, target);
        if (!inside || inside === ".." || inside.startsWith("../") || isAbsolute(inside) || ancestors.includes(target)) {
          throw new Error("advanced_build_link_outside_dependencies");
        }
        digest.update(path).update("\0link\0").update(relative(cwd, target)).update("\0");
        if ((await lstat(target)).isDirectory()) await walk(target, path, [...ancestors, target]);
        else digest.update(await readFile(target)).update("\0");
      } else if (entry.isDirectory()) await walk(absolute, path, [...ancestors, absolute]);
      else if (entry.isFile()) digest.update(path).update("\0").update(await readFile(absolute)).update("\0");
      else throw new Error("advanced_build_entry_unsupported");
    }
  }
  if (!(await lstat(join(root, "BUILD_ID"))).isFile()) throw new Error("advanced_build_missing");
  await walk(root, "", [root]);
  return digest.digest("hex");
}

export async function writeAdvancedBuildReceipt(sourceDigest: string, cwd = process.cwd()): Promise<void> {
  if (sourceDigest !== await advancedSourceDigest(cwd)) throw new Error("advanced_source_changed_during_build");
  const receipt = receiptSchema.parse({ version: 1, sourceDigest, buildDigest: await buildDigest(cwd) });
  await writeFile(join(cwd, ".next", receiptName), JSON.stringify(receipt), { mode: 0o600 });
}

export async function assertAdvancedBuild(sourceDigest: string, cwd = process.cwd()): Promise<void> {
  const receipt = receiptSchema.parse(JSON.parse(await readFile(join(cwd, ".next", receiptName), "utf8")));
  if (receipt.sourceDigest !== sourceDigest || receipt.buildDigest !== await buildDigest(cwd)) {
    throw new Error("advanced_build_not_approved_source");
  }
}
