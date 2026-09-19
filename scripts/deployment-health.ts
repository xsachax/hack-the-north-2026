const kind = process.argv[2] ?? "readiness";
export {};
if (!["startup", "readiness", "liveness"].includes(kind)) process.exit(1);
try {
  const response = await fetch(`http://127.0.0.1:4322/${kind}`, { signal: AbortSignal.timeout(3000) });
  console.log(await response.text());
  process.exitCode = response.ok ? 0 : 1;
} catch { process.exitCode = 1; }
