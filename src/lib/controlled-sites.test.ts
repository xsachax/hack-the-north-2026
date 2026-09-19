import { describe, expect, it } from "vitest";
import { allowsNavigation, controlledNavigationScope, controlledSite } from "./controlled-sites";

describe("controlled-site registry", () => {
  it("keeps two disjoint immutable document allowlists", () => {
    const store = controlledSite("store");
    const board = controlledSite("project-board");
    expect(store.origin).not.toBe(board.origin);
    expect(board.navigationPaths).toEqual(["/project-board", "/project-board/new", "/project-board/projects"]);
    expect(Object.isFrozen(board.navigationPaths)).toBe(true);
    expect(() => controlledSite("constructor" as "store")).toThrow();
    const scope = controlledNavigationScope(board, `${board.origin}/project-board`);
    expect(allowsNavigation(scope, `${store.origin}/demo`)).toBe(false);
    expect(allowsNavigation(scope, `${board.origin}/project-board/unknown`)).toBe(false);
  });

  it("narrows exact routes with path-boundary prefixes without granting other documents", () => {
    const site = controlledSite("project-board");
    const targetUrl = `${site.origin}/project-board/new`;
    const scope = controlledNavigationScope(site, targetUrl, {
      targetUrl, allowedSubdomains: [], pathPrefixes: ["/project-board/new"],
    });
    expect(allowsNavigation(scope, targetUrl)).toBe(true);
    for (const path of ["/project-board", "/project-board/projects", "/project-board/new/other", "/project-board/new?x=1"]) {
      expect(allowsNavigation(scope, site.origin + path)).toBe(false);
    }
  });

  it.each([
    { pathPrefixes: ["/project-board/ne"] },
    { pathPrefixes: ["/project-board/../"] },
    { allowedSubdomains: ["board.flash-flood.invalid"] },
    { targetUrl: "https://example.com" },
  ])("rejects invalid narrowing input %j", (overrides) => {
    const site = controlledSite("project-board");
    const targetUrl = site.origin + "/project-board/new";
    expect(() => controlledNavigationScope(site, targetUrl, {
      targetUrl, allowedSubdomains: [], pathPrefixes: ["/project-board"], ...overrides,
    })).toThrow();
  });
});
