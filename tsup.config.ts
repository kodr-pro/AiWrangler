import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    tools: "src/tools.ts",
    plugin: "src/plugin.ts",
    mcp: "src/mcp.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: { entry: ["src/index.ts"] },
  clean: true,
  sourcemap: true,
  target: "node22",
  // Host SDKs for the native opencode entry points only. Do not bundle them.
  external: ["@opencode-ai/plugin", "@opencode/plugin"],
})
