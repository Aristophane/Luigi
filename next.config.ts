import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/install/vps": ["./agent/**/*"],
    "/install/vps/[artifact]": ["./agent/**/*"],
  },
};

export default nextConfig;
