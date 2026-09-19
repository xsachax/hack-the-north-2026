import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { releaseSourceFiles } from "./source";

export async function releaseSourceDigest(root = process.cwd()): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await releaseSourceFiles(root)) {
    hash.update(file).update("\0").update(await readFile(join(root, file))).update("\0");
  }
  return hash.digest("hex");
}

const receiptName = "deployment-release.json";

export async function releaseBuildDigest(cwd = process.cwd()): Promise<string> {
  const next = resolve(cwd, ".next");
  const modulesPath = resolve(cwd, "node_modules");
  for (const directory of [next, modulesPath]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("deployment_build_root_invalid");
  }
  const modules = await realpath(modulesPath);
  const excluded = new Set(["cache", "dev", "diagnostics", "types", "trace", "trace-build", "lock", receiptName]);
  const hash = createHash("sha256");
  function record(kind: string, path: string, content: Buffer | string) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    hash.update(JSON.stringify([kind, path, bytes.length])).update("\0").update(bytes);
  }
  async function walk(directory: string, prefix: string, ancestors: readonly string[]) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (prefix === ".next" && excluded.has(entry.name)) continue;
      const path = join(prefix, entry.name), absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(absolute);
        const inside = relative(modules, target);
        if (!inside || inside === ".." || inside.startsWith("../") || isAbsolute(inside) || ancestors.includes(target)) {
          throw new Error("deployment_build_link_outside_dependencies");
        }
        record("link", path, inside);
        const stat = await lstat(target);
        if (stat.isDirectory()) await walk(target, path, [...ancestors, target]);
        else if (stat.isFile()) record("file", path, await readFile(target));
        else throw new Error("deployment_build_entry_unsupported");
      } else if (entry.isDirectory()) {
        record("directory", path, "");
        await walk(absolute, path, [...ancestors, await realpath(absolute)]);
      } else if (entry.isFile()) record("file", path, await readFile(absolute));
      else throw new Error("deployment_build_entry_unsupported");
    }
  }
  if (!(await lstat(join(next, "BUILD_ID"))).isFile()) throw new Error("deployment_build_missing");
  await walk(next, ".next", [await realpath(next)]);
  // External packages are loaded directly by Next, tsx and the normal worker;
  // hash all installed bytes, including Stagehand's input extension archive,
  // not only dependencies linked from .next. Composed private archives are
  // derived at runtime from these pinned inputs and the source-bound composer.
  await walk(modulesPath, "node_modules", [modules]);
  return hash.digest("hex");
}

export async function writeReleaseBuildReceipt(sourceDigest: string, cwd = process.cwd()): Promise<void> {
  if (sourceDigest !== await releaseSourceDigest(cwd)) throw new Error("deployment_sources_changed_during_build");
  const receipt = {
    version: 2, sourceDigest,
    buildId: (await readFile(join(cwd, ".next/BUILD_ID"), "utf8")).trim(),
    buildDigest: await releaseBuildDigest(cwd),
  };
  if (sourceDigest !== await releaseSourceDigest(cwd)) throw new Error("deployment_sources_changed_during_build");
  await writeFile(join(cwd, ".next", receiptName), JSON.stringify(receipt));
}

// The returned fingerprint binds both source/configuration and runnable bytes.
export async function assertReleaseBuild(cwd = process.cwd()): Promise<string> {
  await assertCleanEnvironment(cwd);
  const receipt = JSON.parse(await readFile(join(cwd, ".next", receiptName), "utf8")) as Record<string, unknown>;
  const sourceDigest = await releaseSourceDigest(cwd);
  const buildId = (await readFile(join(cwd, ".next/BUILD_ID"), "utf8")).trim();
  const buildDigest = await releaseBuildDigest(cwd);
  if (receipt.version !== 2 || receipt.sourceDigest !== sourceDigest ||
    receipt.buildId !== buildId || receipt.buildDigest !== buildDigest) throw new Error("deployment_build_mismatch");
  return createHash("sha256").update(JSON.stringify({ version: 2, sourceDigest, buildId, buildDigest })).digest("hex");
}

export async function assertCleanEnvironment(cwd = process.cwd()): Promise<void> {
  if ((await readdir(cwd)).some((name) => name.startsWith(".env") && name !== ".env.example")) {
    throw new Error("deployment_env_files_forbidden");
  }
}
