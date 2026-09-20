import { readdir } from "node:fs/promises";
import { join } from "node:path";

const nativeExtension = "src/server/execution/native-policy-extension/";

// The clean package and its receipt must select the same public runtime inputs.
export async function releaseSourceFiles(root = process.cwd()): Promise<string[]> {
  const files = ["package.json", "package-lock.json", ".npmrc", "next.config.ts", "tsconfig.json"];
  async function walk(directory: string) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("deployment_source_symlink");
      if (entry.name.startsWith(".env")) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && !entry.name.endsWith(".test.ts") &&
        (/\.(ts|tsx|css)$/.test(entry.name) ||
          (path.startsWith(nativeExtension) && /\.(js|json)$/.test(entry.name)) ||
          (path.startsWith("public/surfers/") && entry.name.endsWith(".svg")))) files.push(path);
    }
  }
  await walk("src");
  const publicDirectory = (await readdir(root, { withFileTypes: true })).find((entry) => entry.name === "public");
  if (publicDirectory) {
    if (!publicDirectory.isDirectory()) throw new Error("deployment_source_symlink");
    await walk("public");
  }
  for (const entry of await readdir(join(root, "scripts"))) {
    if (entry === "worker.ts" || /^deployment.*\.ts$/.test(entry)) files.push(join("scripts", entry));
  }
  return files.sort();
}
