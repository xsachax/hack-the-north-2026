import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type { Page, Request } from "playwright-core";
import { SECOND_COUPON_SIGNATURE } from "../../lib/demo";
import type { ArtifactSinks, TelemetryRecord } from "./artifacts";
import { sanitizeTelemetry } from "./artifacts";
import { FIXTURE_ORIGIN, isFixtureRequest } from "./fixture-network";
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

export type CriterionVerifier = (page: Page, observation: Pick<Observation, "id" | "text">) => Promise<readonly CriterionCheck[]>;
export type DriverOptions = {
  page: Page;
  artifacts: ArtifactSinks;
  verify: CriterionVerifier;
  close: () => Promise<CleanupOutcome>;
  networkErrors: readonly string[];
  keyboardOnly?: boolean;
};

export class FixtureDriver implements BrowserDriver {
  readonly capabilities = fixtureCapabilities;
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

  constructor(private readonly options: DriverOptions) {
    this.page = options.page;
    this.page.setDefaultTimeout(5000);
    this.page.setDefaultNavigationTimeout(10000);
    this.page.on("console", () => this.record("console", "CONSOLE_EVENT"));
    this.page.on("pageerror", (error) => {
      const confirmed = error.message === SECOND_COUPON_SIGNATURE;
      this.record("pageerror", confirmed ? "FF_DEMO_SECOND_COUPON" : "PAGE_ERROR");
      this.signals.push({
        kind: confirmed ? "functional_failure" : "console",
        message: confirmed ? "FF_DEMO_SECOND_COUPON" : "PAGE_ERROR",
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
        this.signals.push({ kind: "http", message: "HTTP_ERROR", status: response.status() });
      }
    });
    this.page.on("requestfinished", (request) => {
      const pending = this.requests.get(request);
      if (pending && Date.now() - pending.start >= 1000) {
        this.record("slow_request", "SLOW_REQUEST", { url: request.url(), durationMs: Date.now() - pending.start, actionId: pending.actionId });
      }
    });
  }

  policySignal(url: string): void { this.record("policy_block", "POLICY_BLOCK", { url }); }

  private record(kind: TelemetryRecord["kind"], code: string, extra: Partial<TelemetryRecord> = {}): void {
    if (this.telemetry.length >= 256) { this.errors.push("telemetry_limit"); return; }
    this.telemetry.push(sanitizeTelemetry({
      timestamp: new Date().toISOString(), pageId: "page-main", actionId: extra.actionId ?? this.actionId,
      kind, code, url: extra.url ?? this.page.url(), status: extra.status, durationMs: extra.durationMs,
    }));
  }

  private guard(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closed) throw new ExecutionError("infra", "driver_closed");
    if (this.options.networkErrors.length) throw new ExecutionError("infra", "fixture_network_failed");
    if (this.errors.length) throw new ExecutionError("limit", "telemetry_limit");
    if (!isFixtureRequest(this.page.url(), true)) throw new ExecutionError("block", "page_out_of_scope");
    if (this.page.frames().length !== 1) throw new ExecutionError("unsupported", "subframes_unsupported");
  }

  async observe(signal: AbortSignal): Promise<Observation> {
    this.guard(signal);
    const visible = await this.page.evaluate(() => {
      const geometry = { visible(element: Element) {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0
          && box.top < innerHeight && box.left < innerWidth
          && style.visibility === "visible" && style.display !== "none" && style.opacity !== "0";
      } };
      document.querySelectorAll("[data-ff-candidate]").forEach((element) => element.removeAttribute("data-ff-candidate"));
      const candidates: Candidate[] = [];
      for (const element of document.querySelectorAll("a[href],button,input,textarea,select,[role=button]")) {
        if (!geometry.visible(element) || element.matches(":disabled,[aria-disabled=true]")) continue;
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
        });
        if (candidates.length === 80) break;
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const text: string[] = [];
      let node: Node | null;
      while ((node = walker.nextNode()) && text.join(" ").length < 12000) {
        if (!node.parentElement || node.parentElement.closest("script,style,noscript") || !geometry.visible(node.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        if (box.bottom > 0 && box.top < innerHeight && box.width > 0) text.push(node.textContent?.trim() ?? "");
      }
      for (const input of document.querySelectorAll<HTMLInputElement>("input[data-ff-candidate]")) {
        text.push(`Input ${input.getAttribute("data-ff-candidate")}: ${input.value.slice(0, 100)}`);
      }
      text.unshift(`Focused control: ${document.activeElement?.getAttribute("data-ff-candidate") ?? "none"}`);
      return { candidates, text: text.join(" ").slice(0, 12000), title: document.title };
    });
    this.guard(signal);
    const url = this.page.url();
    this.lastObservationUrl = url;
    this.candidates = new Map(visible.candidates.map((candidate) => [candidate.id, candidate]));
    const id = createHash("sha256").update(JSON.stringify({ url, ...visible })).digest("hex");
    const screenshot = await this.options.artifacts.screenshot(await this.page.screenshot({ fullPage: false, timeout: 5000 }));
    const checks = await this.options.verify(this.page, { id, text: visible.text });
    if (this.telemetry.length) {
      await this.options.artifacts.json({ telemetry: this.telemetry.splice(0) });
    }
    this.guard(signal);
    return {
      id, url, title: visible.title, text: visible.text, candidates: visible.candidates,
      screenshotKey: screenshot.key, checks, signals: this.signals.splice(0, 64),
    };
  }

  async act(action: BrowserAction, signal: AbortSignal): Promise<void> {
    this.guard(signal);
    if (action.actor !== "agent") throw new ExecutionError("unsupported", "human_actor_not_enabled");
    if (this.lastObservationUrl !== this.page.url()) throw new ExecutionError("block", "stale_observation");
    this.actionId = `action-${++this.actionNumber}`;
    const candidate = action.candidateId ? this.candidates.get(action.candidateId) : undefined;
    const locator = candidate ? this.page.locator(`[data-ff-candidate="${candidate.id}"]`) : undefined;
    if (["click", "type", "select"].includes(action.action)) {
      if (!candidate || !locator || !await locator.isVisible() || !await locator.isEnabled()) throw new ExecutionError("block", "ungrounded_candidate");
      const box = await locator.boundingBox();
      const viewport = this.page.viewportSize();
      if (!box || !viewport || box.y + box.height <= 0 || box.y >= viewport.height) throw new ExecutionError("block", "candidate_outside_viewport");
    }
    switch (action.action) {
      case "click":
        if (this.options.keyboardOnly) throw new ExecutionError("unsupported", "pointer_disabled");
        if (candidate?.kind === "link") {
          const href = await locator!.getAttribute("href");
          if (!href || !isFixtureRequest(new URL(href, this.page.url()).href, true)) throw new ExecutionError("block", "link_out_of_scope");
        }
        if (candidate?.kind !== "link" && candidate?.kind !== "button") throw new ExecutionError("block", "not_clickable");
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
        if (!action.value || !isFixtureRequest(action.value, true)) throw new ExecutionError("block", "navigation_out_of_scope");
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
    const cdp = await this.page.context().newCDPSession(this.page);
    try {
      await cdp.send("Performance.enable");
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
      if (this.telemetry.length) await this.options.artifacts.json({ telemetry: this.telemetry.splice(0) });
    } catch { errors.push("telemetry_write_failed"); }
    const outcome = await this.options.close();
    return { status: errors.length || outcome.status === "failed" ? "failed" : "closed", errors: [...errors, ...outcome.errors] };
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
      }
      checks.push({ criterion, passed, evidence: passed ? `observation:${observation.id}` : "" });
    }
    return checks;
  };
}
