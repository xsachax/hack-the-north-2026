import { z } from "zod";
import { isIP } from "node:net";
import { parsePublicTargetUrl } from "../target-policy";
import { publicAddress } from "../public-address";
import { MANAGED_EXECUTION_POLICY, MANAGED_POLICY_NOTICE, type ManagedCapabilities } from "../../lib/managed-contracts";
import type { TargetScope } from "../../lib/target-scope";

export function managedAllowedOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length > 16 || new Set(entries).size !== entries.length) throw new Error("managed_origins_invalid");
  return entries.map((entry) => {
    const url = parsePublicTargetUrl(entry);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.origin !== entry || url.search || url.hash || isIP(host) && !publicAddress(host)) {
      throw new Error("managed_origins_invalid");
    }
    return entry;
  });
}

export function assertManagedScope(scope: TargetScope, allowedOrigins: readonly string[]) {
  const target = parsePublicTargetUrl(scope.targetUrl);
  if (!allowedOrigins.includes(target.origin) || scope.allowedSubdomains.length) throw new Error("managed_target_not_approved");
}

export function managedConfiguration(env: NodeJS.ProcessEnv) {
  const allowedOrigins = managedAllowedOrigins(env.MANAGED_AGENT_ALLOWED_ORIGINS);
  const agentId = env.BROWSERBASE_MANAGED_AGENT_ID?.trim();
  if (agentId && !/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) throw new Error("managed_agent_id_invalid");
  return {
    enabled: env.ENABLE_MANAGED_AGENTS === "true",
    allowedOrigins,
    agentId,
  };
}

export function managedCapabilities(options: {
  enabled?: boolean; allowedOrigins?: readonly string[]; agentConfigured?: boolean;
  accessCode?: string; keyConfigured?: boolean; projectConfigured?: boolean;
}): ManagedCapabilities {
  return {
    enabled: options.enabled === true && options.agentConfigured === true && options.keyConfigured === true && options.projectConfigured === true
      && (options.accessCode?.length ?? 0) >= 32 && !!options.allowedOrigins?.length,
    allowedOrigins: [...(options.allowedOrigins ?? [])],
    maxAgents: 8, policy: MANAGED_EXECUTION_POLICY, notice: MANAGED_POLICY_NOTICE,
  };
}

export function requireManagedWorker(env: NodeJS.ProcessEnv) {
  const config = managedConfiguration(env);
  if (!managedCapabilities({
    ...config, agentConfigured: !!config.agentId, accessCode: env.FLASH_FLOOD_ACCESS_CODE,
    keyConfigured: !!env.BROWSERBASE_API_KEY?.trim(),
    projectConfigured: z.uuid().safeParse(env.BROWSERBASE_PROJECT_ID).success,
  }).enabled) throw new Error("managed_worker_configuration_required");
  return {
    apiKey: z.string().trim().min(1).parse(env.BROWSERBASE_API_KEY),
    projectId: z.uuid().parse(env.BROWSERBASE_PROJECT_ID),
    agentId: z.string().min(1).parse(config.agentId),
    allowedOrigins: config.allowedOrigins,
  };
}
