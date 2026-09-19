import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  // Turbopack's persistent caches can retain local dotenv contents.
  experimental: {
    turbopackFileSystemCacheForBuild: false,
    turbopackFileSystemCacheForDev: false,
  },
  serverExternalPackages: ["@browserbasehq/stagehand", "@browserbasehq/sdk"],
  poweredByHeader: false,
  outputFileTracingExcludes: { "*": ["./data/**/*", "./artifacts/**/*", "./.stagehand/**/*", "./.env*"] },
  async headers() {
    return [{
      source: "/runs/:id/reports",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; img-src 'self' blob: data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'none'" },
      ],
    }];
  },
};

export default nextConfig;
