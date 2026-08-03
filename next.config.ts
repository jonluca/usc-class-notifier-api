// @ts-check
import "dotenv/config";
import { type NextConfig } from "next";
const nextConfig = {
  transpilePackages: ["@mui/icons-material", "@mui/material"],
  poweredByHeader: false,
  experimental: {
    largePageDataBytes: 100000000,
    optimizeServerReact: true,
    useTypeScriptCli: true,
  },
} satisfies NextConfig;

export default nextConfig;
