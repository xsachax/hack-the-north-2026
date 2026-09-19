import { targetScopeSchema, type TargetScope } from "../../lib/target-scope";
import { PUBLIC_ASSET_POLICY, PUBLIC_EXECUTION_POLICY } from "../../lib/public-execution";
import { admitPublicNavigation, parsePublicTargetUrl } from "../target-policy";
import type { NavigationScope } from "../../lib/controlled-sites";
import type { PublicRequestContext } from "./public-transport";

const controlHosts = new Set(["api.browserbase.com", "api.stagehand.browserbase.com"]);
function publicUrl(raw: string) {
  const url = parsePublicTargetUrl(raw);
  if (controlHosts.has(url.hostname)) throw new Error("public_control_plane_denied");
  return url;
}

export function publicExecutionPolicy(input: { scope: TargetScope; executionPolicy: string; assetPolicy: string }) {
  if (input.executionPolicy !== PUBLIC_EXECUTION_POLICY || input.assetPolicy !== PUBLIC_ASSET_POLICY) {
    throw new Error("public_policy_unsupported");
  }
  const scope = targetScopeSchema.parse(input.scope);
  publicUrl(scope.targetUrl);
  admitPublicNavigation(scope.targetUrl, scope);
  const navigation: NavigationScope = Object.freeze({
    allows(raw: string) {
      try { publicUrl(raw); admitPublicNavigation(raw, scope); return true; }
      catch { return false; }
    },
  });
  return {
    navigation,
    authorize(request: PublicRequestContext): boolean {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
      try {
        publicUrl(request.url);
        if (request.kind === "navigation") admitPublicNavigation(request.url, scope);
        else if (request.kind === "asset") return true;
        else return false;
        return true;
      } catch { return false; }
    },
  };
}
