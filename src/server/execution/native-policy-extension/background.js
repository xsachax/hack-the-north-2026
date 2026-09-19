/* global chrome */
import { controlled, installPolicy, readPolicy, settings } from "./policy.js";

// Only the privileged debugger can read this state. No page messaging, content
// scripts, web-accessible resources, or host permissions are exposed.
globalThis.flashFloodNativePolicy = { ready: false, fault: null, proxyErrors: 0 };
const state = globalThis.flashFloodNativePolicy;
let installed = false;
function fault(code) {
  state.ready = false;
  state.fault ??= code;
}
for (const [setting, value] of settings(chrome)) {
  setting.onChange.addListener((details) => {
    if (installed && !controlled(details, value)) fault("native_policy_changed");
  });
}
chrome.proxy.onProxyError.addListener((details) => {
  state.proxyErrors = Math.min(state.proxyErrors + 1, 1000);
  if (!details.fatal) fault("native_proxy_direct_fallback");
});
void (async () => {
  try {
    await installPolicy(chrome);
    installed = true;
    if (await readPolicy(chrome) && !state.fault) state.ready = true;
    else fault("native_policy_readback_failed");
  } catch {
    fault("native_policy_install_failed");
  }
})();
