import { spawn } from "node:child_process";
import { assertCleanEnvironment, releaseSourceDigest, writeReleaseBuildReceipt } from "../src/server/deployment/build";

if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("deployment_node22_required");
await assertCleanEnvironment();
const sourceDigest = await releaseSourceDigest();
// A clean build has no runtime credential/configuration dependency.
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
  stdio: "inherit",
  env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
});
const code = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (status) => resolve(status ?? 1));
});
if (code !== 0) process.exitCode = code;
else await writeReleaseBuildReceipt(sourceDigest);
