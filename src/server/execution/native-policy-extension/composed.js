/* global chrome */
import { controlled, installPolicy, readPolicy, settings } from "./policy.js";

const state = { ready: false, fault: null, proxyErrors: 0, phase: "bootstrap" };
let activating = false;
function fault(code) {
  state.ready = false;
  state.fault ??= code;
  state.phase = "fault";
}
for (const [setting, value] of settings(chrome)) {
  setting.onChange.addListener((details) => {
    if (state.phase !== "bootstrap" && !activating && !controlled(details, value)) {
      fault("native_policy_changed");
    }
  });
}
chrome.proxy.onProxyError.addListener((details) => {
  state.proxyErrors = Math.min(state.proxyErrors + 1, 1000);
  if (!details.fatal) fault("native_proxy_direct_fallback");
});

// This entry point is reachable only through the trusted extension debugger.
// No page message handler or new privileged networking bridge is installed.
Object.defineProperty(globalThis, "flashFloodNativePolicy", { value: Object.freeze({
  snapshot: () => ({ ...state }),
  async activate() {
    if (state.phase !== "bootstrap" || activating) throw new Error("native_policy_activation_rejected");
    activating = true;
    try {
      await installPolicy(chrome);
      if (!await readPolicy(chrome) || state.fault) throw new Error("native_policy_readback_failed");
      state.phase = "active";
      state.ready = true;
    } catch {
      fault("native_policy_install_failed");
      throw new Error("native_policy_install_failed");
    } finally { activating = false; }
  },
  async verify() {
    if (state.phase !== "active" || !state.ready || state.fault || !await readPolicy(chrome)) {
      fault("native_policy_readback_failed");
      throw new Error("native_policy_readback_failed");
    }
    return { ...state };
  },
}) });
