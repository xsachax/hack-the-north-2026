import { resolve } from "node:path";

export function isolatedValidationCompose(input: string, root: string, directory: string): string {
  const replacements: [string, string][] = [
    ["build: .", `build:\n      context: ${JSON.stringify(root)}`],
    ["./deploy/runtime.env", JSON.stringify(resolve(directory, "runtime.env"))],
    ["./deploy/secrets/access-code", JSON.stringify(resolve(directory, "secrets/access-code"))],
    ["./deploy/secrets/browserbase-api-key", JSON.stringify(resolve(directory, "secrets/browserbase-api-key"))],
    ["127.0.0.1:3000:4321", "127.0.0.1::4321"],
  ];
  let output = input;
  for (const [from, to] of replacements) {
    if (!output.includes(from)) throw new Error("compose_contract_changed_update_validation");
    output = output.replaceAll(from, to);
  }
  return output;
}

export function offlineReadinessPassed(output: string): boolean {
  const health = JSON.parse(output) as Record<string, unknown>;
  return health.operationalReady === true && health.websiteExecutionEnabled === false &&
    health.productReleaseReady === false && health.releaseBlockedBy === "issue8";
}
