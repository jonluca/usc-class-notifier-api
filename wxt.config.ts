import { resolve } from "node:path";
import { defineConfig } from "wxt";

export default defineConfig({
  imports: false,
  modules: ["@wxt-dev/module-react"],
  targetBrowsers: ["chrome", "edge", "firefox", "safari"],
  srcDir: "src",
  publicDir: "extension-public",
  alias: {
    "-": resolve("assets"),
  },
  zip: {
    includeSources: [
      ".gitignore",
      "SOURCE_CODE_REVIEW.md",
      "assets/**",
      "extension-public/**",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "prisma.config.ts",
      "prisma/schema.prisma",
      "src/**",
      "tsconfig.json",
      "wxt.config.ts",
    ],
    excludeSources: ["db/**", "jobs/**", "logs/**", "tsconfig.tsbuildinfo"],
  },
  manifest: ({ browser }) => ({
    name: "USC Schedule Helper",
    short_name: "USC Schedule Helper",
    description: "Improve USC class search and registration with ratings, schedule insights, and class notifications.",
    homepage_url: "https://usc.jonlu.ca",
    permissions: ["storage"],
    icons: {
      16: "/icon-16.png",
      32: "/icon-32.png",
      48: "/icon-48.png",
      128: "/icon.png",
    },
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "usc-schedule-helper@jonlu.ca",
              strict_min_version: "140.0",
              data_collection_permissions: {
                required: ["personallyIdentifyingInfo", "websiteContent"],
              },
            },
            gecko_android: {
              strict_min_version: "142.0",
            },
          },
        }
      : {}),
  }),
});
