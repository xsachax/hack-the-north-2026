import { targetScopeSchema, type TargetScope } from "./target-scope";

export type ControlledSiteId = "store" | "project-board";
export type ControlledSite = Readonly<{
  id: ControlledSiteId;
  origin: string;
  entryPath: string;
  navigationPaths: readonly string[];
  resourcePaths: readonly string[];
}>;

export const controlledSites: Readonly<Record<ControlledSiteId, ControlledSite>> = Object.freeze({
  store: Object.freeze({
    id: "store", origin: "https://fixture.flash-flood.invalid", entryPath: "/demo",
    navigationPaths: Object.freeze([
      "/demo", "/demo/category/home", "/demo/category/paper", "/demo/product/mug",
      "/demo/product/candle", "/demo/product/journal", "/demo/cart", "/demo/checkout",
      "/demo/checkout/review", "/demo/complete",
    ]),
    resourcePaths: Object.freeze(["/demo/cart-summary?variant=fixed", "/demo/cart-summary?variant=broken"]),
  }),
  "project-board": Object.freeze({
    id: "project-board", origin: "https://board.flash-flood.invalid", entryPath: "/project-board",
    navigationPaths: Object.freeze(["/project-board", "/project-board/new", "/project-board/projects"]),
    resourcePaths: Object.freeze([]),
  }),
});

export function controlledSite(id: ControlledSiteId): ControlledSite {
  if (!Object.hasOwn(controlledSites, id)) throw new Error("Unknown controlled site");
  return controlledSites[id];
}

export type NavigationScope = Readonly<{
  allowedOrigins: readonly string[];
  navigationPaths: readonly string[];
}>;

export function allowsNavigation(scope: NavigationScope, raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  return !url.username && !url.password && !url.hash && !url.search
    && scope.allowedOrigins.includes(url.origin) && scope.navigationPaths.includes(url.pathname);
}

/** User scope can only narrow the immutable controlled-site document allowlist. */
export function controlledNavigationScope(site: ControlledSite, targetUrl: string, input?: TargetScope): NavigationScope {
  let paths = site.navigationPaths;
  if (input) {
    const scope = targetScopeSchema.parse(input);
    if (scope.targetUrl !== targetUrl || scope.allowedSubdomains.length
      || scope.pathPrefixes.some((path) => !/^\/[a-zA-Z0-9/_-]*$/.test(path)
        || path.includes("//") || (path.length > 1 && path.endsWith("/")))) {
      throw new Error("Invalid controlled-site scope");
    }
    paths = paths.filter((path) => scope.pathPrefixes.some((prefix) =>
      prefix === "/" || path === prefix || path.startsWith(`${prefix}/`)));
  }
  const result = { allowedOrigins: [site.origin], navigationPaths: [...paths] };
  if (!allowsNavigation(result, targetUrl)) throw new Error("Controlled target outside navigation scope");
  return result;
}
