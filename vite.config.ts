import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { apiPlugin } from "./src/server/plugin.ts";

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: { host: "127.0.0.1", port: 5254, strictPort: true },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
  },
});
