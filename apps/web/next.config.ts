import type { NextConfig } from "next";

const API_BACKEND = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3101";

const nextConfig: NextConfig = {
  transpilePackages: ["@clawnboard/shared"],
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_BACKEND}/api/:path*` },
      { source: "/health/:path*", destination: `${API_BACKEND}/health/:path*` },
    ];
  },
};

export default nextConfig;
