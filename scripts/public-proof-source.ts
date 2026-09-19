import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { advancedSourceDigest } from "./advanced-build";

const documents = ["API", "EXECUTION", "CAPABILITIES", "WORKER", "DELIVERY_PLAN"];

/** Separate from the deployable package: approval must also bind the proof harness. */
export async function publicHarnessDigest(cwd = fileURLToPath(new URL("..", import.meta.url))): Promise<string> {
  const files = [
    ...documents.map((name) => `docs/${name}.md`),
    ...(await readdir(cwd)).filter((name) => /^(?:playwright|vitest|eslint|next)\..*config\.[cm]?[jt]s$/.test(name)),
  ].sort();
  for (const file of files) {
    const stat = await lstat(join(cwd, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("public_harness_input_rejected");
  }
  const digest = createHash("sha256").update("public-proof-harness-v1\0")
    .update(await advancedSourceDigest(cwd)).update("\0");
  for (const file of files) digest.update(file).update("\0").update(await readFile(join(cwd, file))).update("\0");
  return digest.digest("hex");
}
