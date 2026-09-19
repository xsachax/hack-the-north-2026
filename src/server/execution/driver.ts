import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type { Page, Request } from "playwright-core";
import { SECOND_COUPON_SIGNATURE } from "../../lib/demo";
import { allowsNavigation, controlledSite, type NavigationScope } from "../../lib/controlled-sites";
import type { ArtifactSinks, TelemetryRecord } from "./artifacts";
import { sanitizeTelemetry } from "./artifacts";
import { FIXTURE_ORIGIN } from "./fixture-network";
import {
  ExecutionError, type BrowserAction, type BrowserDriver, type Candidate,
  type CleanupOutcome, type CriterionCheck, type Observation, type TelemetrySignal,
} from "./types";

export const fixtureCapabilities = Object.freeze({
  navigation: true, click: true, type: true, select: true, back: true,
  scroll: true, keyboard: true, screenshots: true, cdpPerformance: true,
  tabs: "denied", frames: "main_frame_only", dialogs: "dismiss",
  workers: "denied", webSockets: "denied", webRTC: "denied",
  downloads: "cancel", uploads: "unsupported", contextReuse: "unsupported",
  humanTakeover: "unsupported", networkThrottling: "unsupported",
  arbitraryTargets: "disabled",
} as const);
export const readOnlyCapabilities = Object.freeze({
  ...fixtureCapabilities, click: "links_only", type: false, select: false, keyboard: false,
  arbitraryTargets: "requires_native_policy",
} as const);

export type CriterionVerifier = (page: Page, observation: Observation) => Promise<readonly CriterionCheck[]>;
export type DriverOptions = {
  page: Page;
  artifacts: ArtifactSinks;
  cleanupJson?: ArtifactSinks["json"];
  onCleanupError?: (code: "telemetry_write_failed", error: unknown) => void;
  verify?: CriterionVerifier;
  close: () => Promise<CleanupOutcome>;
  networkErrors: readonly string[];
  keyboardOnly?: boolean;
  readOnly?: boolean;
  networkFailureCode?: "fixture_network_failed" | "public_transport_failed";
  assertActive?: () => void;
};
export type ScopedDriverOptions = DriverOptions & {
  scope: NavigationScope;
  /** Trusted application policy, never model-generated code or selectors. */
  classifyFunctionalError?: (error: Error) => string | undefined;
};

export class ScopedBrowserDriver implements BrowserDriver {
  get capabilities() { return this.options.readOnly ? readOnlyCapabilities : fixtureCapabilities; }
  private readonly page: Page;
  private actionId = "setup";
  private actionNumber = 0;
  private closed = false;
  private candidates = new Map<string, Candidate>();
  private signals: TelemetrySignal[] = [];
  private telemetry: TelemetryRecord[] = [];
  private errors: string[] = [];
  private requests = new WeakMap<Request, { start: number; actionId: string }>();
  private lastObservationUrl = "";
  private closing?: Promise<CleanupOutcome>;
  private unsupported?: string;

  constructor(private readonly options: ScopedDriverOptions) {
    this.page = options.page;
    this.page.setDefaultTimeout(5000);
    this.page.setDefaultNavigationTimeout(10000);
    this.page.on("console", () => this.record("console", "CONSOLE_EVENT"));
    this.page.on("pageerror", (error) => {
      if (error.message === "FLASH_FLOOD_UNSUPPORTED_TABS") this.unsupported = "tabs_unsupported";
      const confirmed = options.classifyFunctionalError?.(error);
      this.record("pageerror", confirmed ?? "PAGE_ERROR");
      this.addSignal({
        kind: confirmed ? "functional_failure" : "console",
        message: confirmed ?? "PAGE_ERROR",
        evidence: `page-main/${this.actionId}`,
      });
    });
    this.page.on("request", (request) => this.requests.set(request, { start: Date.now(), actionId: this.actionId }));
    this.page.on("requestfailed", (request) => {
      const pending = this.requests.get(request);
      this.record("requestfailure", "REQUEST_FAILED", { url: request.url(), actionId: pending?.actionId });
    });
    this.page.on("response", (response) => {
      if (response.status() >= 400) {
        const pending = this.requests.get(response.request());
        this.record("http_error", "HTTP_ERROR", { url: response.url(), status: response.status(), actionId: pending?.actionId });
        this.addSignal({ kind: "http", message: "HTTP_ERROR", status: response.status() });
      }
    });
    this.page.on("requestfinished", (request) => {
      const pending = this.requests.get(request);
      if (pending && Date.now() - pending.start >= 1000) {
        this.record("slow_request", "SLOW_REQUEST", { url: request.url(), durationMs: Date.now() - pending.start, actionId: pending.actionId });
      }
    });
  }

  policySignal(url: string, code?: string): void {
    if (code === "popup_denied") this.unsupported = "tabs_unsupported";
    this.record("policy_block", "POLICY_BLOCK", { url });
  }

  private addSignal(signal: TelemetrySignal): void {
    if (this.signals.length < 256) this.signals.push(signal);
    else if (!this.errors.length) this.errors.push("telemetry_limit");
  }

  private record(kind: TelemetryRecord["kind"], code: string, extra: Partial<TelemetryRecord> = {}): void {
    if (this.telemetry.length >= 256) { if (!this.errors.length) this.errors.push("telemetry_limit"); return; }
    this.telemetry.push(sanitizeTelemetry({
      timestamp: new Date().toISOString(), pageId: "page-main", actionId: extra.actionId ?? this.actionId,
      kind, code, url: extra.url ?? this.page.url(), status: extra.status, durationMs: extra.durationMs,
    }));
  }

  private guard(signal: AbortSignal): void {
    signal.throwIfAborted();
    this.options.assertActive?.();
    if (this.closed) throw new ExecutionError("infra", "driver_closed");
    if (this.unsupported) throw new ExecutionError("unsupported", this.unsupported);
    if (this.options.networkErrors.length) throw new ExecutionError("infra", this.options.networkFailureCode ?? "fixture_network_failed");
    if (this.errors.length) throw new ExecutionError("limit", "telemetry_limit");
    if (!allowsNavigation(this.options.scope, this.page.url())) throw new ExecutionError("block", "page_out_of_scope");
    if (this.page.frames().length !== 1) throw new ExecutionError("unsupported", "subframes_unsupported");
  }

  async observe(signal: AbortSignal): Promise<Observation> {
    this.guard(signal);
    const visible = await this.page.evaluate(() => {
      const geometry = { visible(element: Element, content: Node = element) {
        if (!element.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false;
        const box = element.getBoundingClientRect();
        let left = Math.max(0, box.left), right = Math.min(innerWidth, box.right);
        let top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor instanceof HTMLDetailsElement && !ancestor.open && content !== ancestor &&
            !ancestor.querySelector(":scope > summary")?.contains(content)) return false;
          const style = getComputedStyle(ancestor);
          if (content !== ancestor && style.contentVisibility === "hidden") return false;
          if (style.visibility !== "visible" || style.display === "none" || style.opacity === "0") return false;
          const clip = ancestor.getBoundingClientRect();
          if (["hidden", "clip", "scroll", "auto"].includes(style.overflowX)) {
            left = Math.max(left, clip.left + ancestor.clientLeft);
            right = Math.min(right, clip.left + ancestor.clientLeft + ancestor.clientWidth);
          }
          if (["hidden", "clip", "scroll", "auto"].includes(style.overflowY)) {
            top = Math.max(top, clip.top + ancestor.clientTop);
            bottom = Math.min(bottom, clip.top + ancestor.clientTop + ancestor.clientHeight);
          }
        }
        return right > left && bottom > top;
      } };
      document.querySelectorAll("[data-ff-candidate]").forEach((element) => element.removeAttribute("data-ff-candidate"));
      const candidates: Candidate[] = [];
      for (const element of document.querySelectorAll("a[href],button,input,textarea,select,[role=button],details > summary:first-of-type")) {
        if (!geometry.visible(element)) continue;
        if (element instanceof HTMLInputElement && ["hidden", "password", "file"].includes(element.type)) continue;
        const kind = element instanceof HTMLAnchorElement ? "link"
          : element instanceof HTMLSelectElement ? "select"
          : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? "input" : "button";
        const labels = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
          ? [...(element.labels ?? [])].map((label) => {
            const copy = label.cloneNode(true) as HTMLElement;
            copy.querySelectorAll("input,select,textarea,button").forEach((control) => control.remove());
            return copy.textContent ?? "";
          }).join(" ") : "";
        const label = (element.getAttribute("aria-label") || labels || (element as HTMLElement).innerText || element.getAttribute("placeholder") || "").trim().slice(0, 200);
        const id = `c${candidates.length}`;
        element.setAttribute("data-ff-candidate", id);
        candidates.push({
          id, kind, label,
          ...(element instanceof HTMLAnchorElement ? { href: element.href } : {}),
          ...(element instanceof HTMLInputElement ? { inputType: element.type } : {}),
          disabled: element.matches(":disabled,[aria-disabled=true]"),
          ...(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
            ? { value: element.value.slice(0, 200) } : {}),
          ...(element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)
            ? { checked: element.checked } : {}),
          ...(element instanceof HTMLSelectElement
            ? { selected: [...element.selectedOptions].map((option) => option.value.slice(0, 200)).slice(0, 80) } : {}),
        });
        if (candidates.length === 80) break;
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const text: string[] = [];
      type TextBlock = { text: string; complete: boolean; lastLine?: { top: number; bottom: number } };
      const blocks = new Map<Element, TextBlock>();
      let node: Node | null;
      while ((node = walker.nextNode()) && text.join(" ").length < 12000) {
        if (!node.parentElement || node.parentElement.closest("script,style,noscript") || !geometry.visible(node.parentElement, node)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        let block = node.parentElement;
        while (block.parentElement && ["inline", "contents"].includes(getComputedStyle(block).display)) block = block.parentElement;
        const lines = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
        let fullyVisible = lines.every((rect) => rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth);
        let hidden = false;
        for (let ancestor: Element | null = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.opacity === "0" || style.visibility !== "visible" || style.display === "none") hidden = true;
          const clip = ancestor.getBoundingClientRect();
          if (["hidden", "clip", "scroll", "auto"].includes(style.overflowX)
            && (box.left < clip.left + ancestor.clientLeft || box.right > clip.left + ancestor.clientLeft + ancestor.clientWidth)) fullyVisible = false;
          if (["hidden", "clip", "scroll", "auto"].includes(style.overflowY)
            && (box.top < clip.top + ancestor.clientTop || box.bottom > clip.top + ancestor.clientTop + ancestor.clientHeight)) fullyVisible = false;
        }
        if (!hidden && fullyVisible && lines.length) text.push(node.textContent?.trim() ?? "");
        if (!hidden && node.textContent?.trim()) {
          const group: TextBlock = blocks.get(block) ?? { text: "", complete: true };
          const firstLine = lines[0];
          if (firstLine && group.lastLine
            && (firstLine.top >= group.lastLine.bottom || firstLine.bottom <= group.lastLine.top)) {
            group.text += " ";
          }
          group.text += node.textContent;
          group.lastLine = lines.at(-1);
          group.complete &&= fullyVisible && box.width > 0 && box.height > 0;
          blocks.set(block, group);
        } else if (!hidden && blocks.has(block)) {
          blocks.get(block)!.text += node.textContent ?? "";
        }
      }
      const textBlocks: string[] = [];
      let blockCharacters = 0;
      for (const [element, group] of blocks) {
        const value = group.text.replace(/\s+/g, " ").trim();
        // Never turn an incomplete/truncated rendered block into exact-match evidence.
        if (!group.complete || (node && element.contains(node)) || !value || value.length > 1000) continue;
        if (textBlocks.length >= 80 || blockCharacters + value.length > 12000) break;
        textBlocks.push(value);
        blockCharacters += value.length;
      }
      for (const input of document.querySelectorAll<HTMLInputElement>("input[data-ff-candidate]")) {
        text.push(`Input ${input.getAttribute("data-ff-candidate")}: ${input.value.slice(0, 100)}`);
      }
      text.unshift(`Focused control: ${document.activeElement?.getAttribute("data-ff-candidate") ?? "none"}`);
      return { candidates, text: text.join(" ").slice(0, 12000), textBlocks, title: document.title };
    });
    this.guard(signal);
    const url = this.page.url();
    this.lastObservationUrl = url;
    this.candidates = new Map(visible.candidates.map((candidate) => [candidate.id, candidate]));
    const id = createHash("sha256").update(JSON.stringify({ url, ...visible })).digest("hex");
    const screenshot = await this.options.artifacts.screenshot(await this.page.screenshot({ fullPage: false, timeout: 5000 }));
    this.guard(signal);
    const observation: Observation = {
      id, url, title: visible.title, text: visible.text, textBlocks: visible.textBlocks, candidates: visible.candidates,
      screenshotKey: screenshot.key, checks: [], signals: this.signals.splice(0, 64),
    };
    const checks = await this.options.verify?.(this.page, observation) ?? [];
    if (this.telemetry.length) {
      await this.options.artifacts.json({ telemetry: this.telemetry.splice(0) });
    }
    this.guard(signal);
    return {
      ...observation, checks,
    };
  }

  async act(action: BrowserAction, signal: AbortSignal): Promise<void> {
    this.guard(signal);
    if (action.actor !== "agent") throw new ExecutionError("unsupported", "human_actor_not_enabled");
    if (this.options.readOnly && !["click", "navigate", "back", "scroll", "wait"].includes(action.action)) {
      throw new ExecutionError("unsupported", "read_only_action_required");
    }
    if (this.lastObservationUrl !== this.page.url()) throw new ExecutionError("block", "stale_observation");
    this.actionId = `action-${++this.actionNumber}`;
    const candidate = action.candidateId ? this.candidates.get(action.candidateId) : undefined;
    const locator = candidate ? this.page.locator(`[data-ff-candidate="${candidate.id}"]`) : undefined;
    if (this.options.readOnly && action.action === "click" && candidate?.kind !== "link") {
      throw new ExecutionError("unsupported", "read_only_link_required");
    }
    if (["click", "type", "select"].includes(action.action)) {
      if (!candidate || !locator || !await locator.isVisible() || !await locator.isEnabled()) throw new ExecutionError("block", "ungrounded_candidate");
      const box = await locator.boundingBox();
      const viewport = this.page.viewportSize();
      if (!box || !viewport || box.y + box.height <= 0 || box.y >= viewport.height
        || box.x + box.width <= 0 || box.x >= viewport.width) throw new ExecutionError("block", "candidate_outside_viewport");
    }
    switch (action.action) {
      case "click":
        if (this.options.keyboardOnly) throw new ExecutionError("unsupported", "pointer_disabled");
        if (this.options.readOnly) {
          const href = await locator!.evaluate((element) => {
            if (!(element instanceof HTMLAnchorElement) || !element.isConnected
              || element.hasAttribute("download") || !["", "_self"].includes(element.getAttribute("target") ?? "")) return null;
            return element.hasAttribute("href") ? element.href : null;
          });
          if (href === null) throw new ExecutionError("unsupported", "read_only_link_required");
          if (!href || !allowsNavigation(this.options.scope, href)) throw new ExecutionError("block", "link_out_of_scope");
          this.guard(signal);
          // Follow the captured URL, never re-resolve or dispatch a page-controlled click handler.
          await this.page.goto(href, { waitUntil: "domcontentloaded" });
          break;
        }
        if (candidate?.kind === "link") {
          const href = await locator!.getAttribute("href");
          if (!href || !allowsNavigation(this.options.scope, new URL(href, this.page.url()).href)) throw new ExecutionError("block", "link_out_of_scope");
        }
        if (candidate?.kind !== "link" && candidate?.kind !== "button"
          && !(candidate?.kind === "input" && ["checkbox", "radio"].includes(candidate.inputType ?? ""))) throw new ExecutionError("block", "not_clickable");
        this.guard(signal);
        await locator!.click();
        break;
      case "type":
        if (candidate?.kind !== "input" || !action.value || action.value.length > 100) throw new ExecutionError("block", "invalid_input");
        if (this.options.keyboardOnly) {
          if (!await locator!.evaluate((element) => document.activeElement === element)) throw new ExecutionError("block", "input_not_focused");
          this.guard(signal);
          await this.page.keyboard.type(action.value);
        } else {
          this.guard(signal);
          await locator!.fill(action.value);
        }
        break;
      case "select":
        if (candidate?.kind !== "select" || !action.value) throw new ExecutionError("block", "invalid_select");
        if (this.options.keyboardOnly) throw new ExecutionError("unsupported", "use_keyboard_for_select");
        this.guard(signal);
        await locator!.selectOption(action.value);
        break;
      case "navigate":
        if (!action.value || !allowsNavigation(this.options.scope, action.value)) throw new ExecutionError("block", "navigation_out_of_scope");
        this.guard(signal);
        await this.page.goto(action.value, { waitUntil: "domcontentloaded" });
        break;
      case "back":
        this.guard(signal);
        await this.page.goBack({ waitUntil: "domcontentloaded" });
        break;
      case "scroll":
        if (!["up", "down"].includes(action.value ?? "")) throw new ExecutionError("block", "invalid_scroll");
        this.guard(signal);
        await this.page.mouse.wheel(0, action.value === "down" ? 500 : -500);
        break;
      case "key":
        if (!["Tab", "Shift+Tab", "Enter", "Space", "ArrowDown", "ArrowUp", "Escape"].includes(action.value ?? "")) throw new ExecutionError("block", "key_denied");
        this.guard(signal);
        await this.page.keyboard.press(action.value!);
        break;
      case "wait": {
        const milliseconds = action.value === null ? 250 : Number(action.value);
        if (action.value === "" || !Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 5000) throw new ExecutionError("block", "invalid_wait");
        this.guard(signal);
        await pause(milliseconds, undefined, { signal });
        break;
      }
      default: throw new ExecutionError("unsupported", "not_a_browser_action");
    }
    // Hydration/render/scroll settling, not simulated network slowness.
    await pause(150, undefined, { signal });
    this.guard(signal);
  }

  async diagnostics(): Promise<{ name: string; value: number }[]> {
    if (this.closed) throw new ExecutionError("infra", "driver_closed");
    this.options.assertActive?.();
    const cdp = await this.page.context().newCDPSession(this.page);
    try {
      this.options.assertActive?.();
      await cdp.send("Performance.enable");
      this.options.assertActive?.();
      const result = await cdp.send("Performance.getMetrics");
      return result.metrics.filter((metric) => ["Documents", "Nodes", "JSHeapUsedSize", "TaskDuration"].includes(metric.name));
    } finally { await cdp.detach(); }
  }

  close(): Promise<CleanupOutcome> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }
  private async closeOnce(): Promise<CleanupOutcome> {
    this.closed = true;
    const errors: string[] = [];
    try {
      if (this.telemetry.length) await (this.options.cleanupJson ?? this.options.artifacts.json)({ telemetry: this.telemetry.splice(0) });
    } catch (error) {
      errors.push("telemetry_write_failed");
      this.options.onCleanupError?.("telemetry_write_failed", error);
    }
    const outcome = await this.options.close();
    return { status: errors.length || outcome.status === "failed" ? "failed" : "closed", errors: [...errors, ...outcome.errors] };
  }
}

export class FixtureDriver extends ScopedBrowserDriver {
  constructor(options: DriverOptions) {
    const site = controlledSite("store");
    super({
      ...options, scope: { allowedOrigins: [site.origin], navigationPaths: site.navigationPaths },
      classifyFunctionalError: (error) => error.message === SECOND_COUPON_SIGNATURE ? "FF_DEMO_SECOND_COUPON" : undefined,
    });
  }
}

export const COUPON_CRITERION = "Both advertised coupons apply and the mug total is CA$21.60.";
export const COMPLETE_CRITERION = "The demo order is visibly complete.";

export function demoVerifier(criteria: readonly string[]): CriterionVerifier {
  return async (page, observation) => {
    const checks: CriterionCheck[] = [];
    for (const criterion of criteria) {
      let passed = false;
      if (criterion === COUPON_CRITERION) {
        if (page.url() !== `${FIXTURE_ORIGIN}/demo/cart`) continue;
        passed = observation.text.includes("Maple ceramic mug")
          && /Applied coupons: (?:SAVE10, COZY5|COZY5, SAVE10)/.test(observation.text)
          && await page.getByRole("heading", { name: "Order total: CA$21.60", exact: true }).isVisible();
      } else if (criterion === COMPLETE_CRITERION) {
        if (page.url() !== `${FIXTURE_ORIGIN}/demo/complete`) continue;
        passed = await page.getByRole("heading", { name: "Thank you! Your demo order is complete.", exact: true }).isVisible();
      } else continue;
      checks.push({ criterion, passed, evidence: passed ? `observation:${observation.id}` : "" });
    }
    return checks;
  };
}
