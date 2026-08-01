import path from "node:path";

import type { NextConfig } from "next";

const internalApiUrl = process.env.INTERNAL_API_URL?.replace(/\/$/, "");

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  reactStrictMode: true,
  async rewrites() {
    if (!internalApiUrl) return [];

    return [
      {
        destination: `${internalApiUrl}/:path*`,
        source: "/api/v1/:path*",
      },
    ];
  },
  transpilePackages: ["@tashkalinskaya/contracts"],
};

export default nextConfig;
