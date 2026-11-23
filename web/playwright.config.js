import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: { baseURL: "http://127.0.0.1:4374" },
  webServer: {
    command: "npm run dev -- --port 4374 --strictPort",
    url: "http://127.0.0.1:4374",
  },
});
