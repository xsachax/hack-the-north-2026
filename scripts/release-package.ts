import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assertPrivateDirectory } from "./advanced-proof";

const destination = resolve(process.argv[2] ?? "data/release-package");
if (process.argv.length > 3 || dirname(destination) !== resolve("data") ||
  !/^release-package(?:-[a-z0-9-]+)?$/.test(basename(destination))) throw new Error("release_package_destination_invalid");
process.umask(0o077);
await mkdir("data", { recursive: true, mode: 0o700 });
await assertPrivateDirectory(resolve("data"));
await mkdir(destination, { mode: 0o700 });
for (const file of ["package.json", "package-lock.json", ".npmrc", "next.config.ts", "tsconfig.json"]) {
  await copyFile(file, join(destination, file));
}
async function copySource(directory: string): Promise<void> {
  await mkdir(join(destination, directory), { recursive: true, mode: 0o700 });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("release_package_source_symlink");
    if (entry.isDirectory()) await copySource(path);
    else if (entry.isFile() && /\.(ts|tsx|css)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      await copyFile(path, join(destination, path));
    }
  }
}
await copySource("src");
await mkdir(join(destination, "scripts"), { mode: 0o700 });
for (const file of await readdir("scripts")) {
  if (file === "worker.ts" || /^deployment.*\.ts$/.test(file)) await copyFile(join("scripts", file), join(destination, "scripts", file));
}
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "development", PATH: process.env.PATH, HOME: process.env.HOME,
  NEXT_TELEMETRY_DISABLED: "1", DEBUG: "false",
};
async function command(executable: string, args: string[]) {
  const child = spawn(executable, args, { cwd: destination, env, stdio: "inherit" });
  const code = await new Promise<number>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => done(code ?? 1));
  });
  if (code !== 0) throw new Error("release_clean_install_or_build_failed");
}
await command("npm", ["ci", "--no-audit", "--no-fund"]);
await command(process.execPath, ["--import", "tsx", "scripts/deployment-build.ts"]);
console.log("Clean Node package prepared without runtime credentials. No provider operations.");
