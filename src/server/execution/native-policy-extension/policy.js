export const proxyValue = {
  mode: "fixed_servers",
  rules: {
    proxyForHttp: { scheme: "http", host: "127.0.0.1", port: 65534 },
    proxyForHttps: { scheme: "http", host: "127.0.0.1", port: 65534 },
    fallbackProxy: { scheme: "socks5", host: "127.0.0.1", port: 65534 },
    bypassList: ["<-loopback>"],
  },
};

function equal(actual, expected) {
  if (actual === expected) return true;
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object") return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (Array.isArray(actual) && actual.length !== expected.length) return false;
  const keys = Object.keys(expected);
  return Object.keys(actual).length === keys.length
    && keys.every((key) => Object.hasOwn(actual, key) && equal(actual[key], expected[key]));
}

export function controlled(details, value) {
  return details?.levelOfControl === "controlled_by_this_extension" && equal(details.value, value);
}

export function settings(api) {
  return [
    [api.proxy.settings, proxyValue],
    [api.privacy.network.webRTCIPHandlingPolicy, "disable_non_proxied_udp"],
    [api.privacy.network.networkPredictionEnabled, false],
  ];
}

export async function readPolicy(api) {
  const entries = settings(api);
  const details = await Promise.all(entries.map(([setting]) => setting.get({ incognito: false })));
  return details.every((value, index) => controlled(value, entries[index][1]));
}

export async function installPolicy(api) {
  for (const [setting, value] of settings(api)) {
    const before = await setting.get({ incognito: false });
    if (!["controllable_by_this_extension", "controlled_by_this_extension"].includes(before.levelOfControl)) {
      throw new Error("native_policy_not_controllable");
    }
    await setting.set({ value, scope: "regular" });
  }
  if (!await readPolicy(api)) throw new Error("native_policy_readback_failed");
}
