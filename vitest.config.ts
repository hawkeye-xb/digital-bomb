import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    root: ".",
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@room": resolve(__dirname, "src/room"),
      "@worker": resolve(__dirname, "src/worker"),
    },
  },
});
