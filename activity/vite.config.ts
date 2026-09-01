import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * The client is a plain TypeScript app: no framework, one canvas, and a small
 * amount of DOM. `shared/` is compiled from source rather than pre-built so the
 * browser and the server always run byte-identical game logic.
 */
export default defineConfig({
  root: "client",
  base: "",
  resolve: {
    alias: { "@shared": resolve(import.meta.dirname, "shared") },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
  server: {
    port: 3000,
    proxy: { "/api": "http://localhost:3001" },
  },
});
