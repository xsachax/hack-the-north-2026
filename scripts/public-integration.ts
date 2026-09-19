import nextEnv from "@next/env";
import { pathToFileURL } from "node:url";
import { assertCleanEnvironment, assertReleaseBuild, releaseSourceDigest } from "../src/server/deployment/build";
import { buildComposedExtension, COMPOSED_POLICY_VERSION } from "../src/server/execution/composed-extension";
import { PROVED_CHROMIUM_VERSION } from "../src/server/execution/native-policy-session";
import { publicHarnessDigest } from "./public-proof-source";

export async function publicPreflight(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0] !== "--offline-preflight") throw new Error("public_checkpoint_disabled");
  await assertCleanEnvironment();
  nextEnv.loadEnvConfig(process.cwd());
  const packageDigest = await assertReleaseBuild();
  const bundle = await buildComposedExtension();
  return {
    phase: "offline-preflight", providerCalls: 0, modelCalls: 0,
    policyVersion: COMPOSED_POLICY_VERSION, provedLocalChromiumVersion: PROVED_CHROMIUM_VERSION,
    sourceDigest: await releaseSourceDigest(), packageDigest,
    harnessDigest: await publicHarnessDigest(),
    archiveDigest: bundle.sha256, vendorArchiveDigest: bundle.provenance.vendorArchiveSha256,
    remotePolicyProved: false,
    publicExecutionEnabled: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const result = args.length === 1 && args[0] === "--offline-native-probe"
    ? import("./public-native-offline").then(({ offlineNativeProbe }) => offlineNativeProbe())
    : publicPreflight(args);
  result.then((receipt) => console.log(JSON.stringify(receipt))).catch(() => {
    console.error("Public offline preflight failed closed; paid public execution is unavailable in this checkpoint.");
    process.exitCode = 1;
  });
}
