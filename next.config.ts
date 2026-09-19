import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@browserbasehq/stagehand", "@browserbasehq/sdk"],
  poweredByHeader: false,
};

export default nextConfig;
