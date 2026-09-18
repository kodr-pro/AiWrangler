import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    tools: "src/tools.ts",
    plugin: "src/plugin.ts",
    "webui/bin": "src/webui/bin.ts",
  },
  format: ["esm"],
  dts: { entry: ["src/index.ts"] },
  clean: true,
  sourcemap: true,
  target: "node22",
})
