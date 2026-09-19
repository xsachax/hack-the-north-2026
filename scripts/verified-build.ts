import { spawn } from "node:child_process";
import { advancedSourceDigest, writeAdvancedBuildReceipt } from "./advanced-build";

process.umask(0o077);
const before = await advancedSourceDigest();
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build", ...process.argv.slice(2)], { stdio: "inherit" });
const code = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (status) => resolve(status ?? 1));
});
if (code !== 0) process.exitCode = code;
else await writeAdvancedBuildReceipt(before);
