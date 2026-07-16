import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: webRoot,
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "http://localhost:3100" } },
    setupFiles: "./src/test/setup.ts",
  },
  server: {
    host: "127.0.0.1",
    port: 3100,
    proxy: {
      "/api": "http://127.0.0.1:4100",
    },
  },
});
