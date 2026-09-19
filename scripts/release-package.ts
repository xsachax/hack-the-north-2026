import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assertPrivateDirectory } from "./advanced-proof";
import { releaseSourceFiles } from "../src/server/deployment/source";

const destination = resolve(process.argv[2] ?? "data/release-package");
if (process.argv.length > 3 || dirname(destination) !== resolve("data") ||
  !/^release-package(?:-[a-z0-9-]+)?$/.test(basename(destination))) throw new Error("release_package_destination_invalid");
process.umask(0o077);
await mkdir("data", { recursive: true, mode: 0o700 });
await assertPrivateDirectory(resolve("data"));
await mkdir(destination, { mode: 0o700 });
for (const file of await releaseSourceFiles()) {
  await mkdir(dirname(join(destination, file)), { recursive: true, mode: 0o700 });
  await copyFile(file, join(destination, file));
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
