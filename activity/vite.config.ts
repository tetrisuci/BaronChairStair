import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * The client is a plain TypeScript app: no framework, one canvas, and a small
 * amount of DOM. `shared/` is compiled from source rather than pre-built so the
 * browser and the server always run byte-identical game logic.
 *
 * Two pages come out of it. The activity is `client/index.html`; the officers'
 * review tool is `client/review/index.html`, and the **directory** in that path
 * is load-bearing rather than tidy. Hono's static middleware appends
 * `index.html` only when the path it resolved is a directory, and never tries
 * `<path>.html` — so `dist/review/index.html` is served at `/review`, while a
 * flat `dist/review.html` would fall through to the single-page fallback and
 * answer 200 with the game. See `server/static-routes.ts`, which pins it.
 *
 * `base: ""` stays, and that is what makes the nested entry work: it emits
 * asset URLs relative to the document, so `dist/review/index.html` references
 * `../assets/…` and resolves to the same bundle the activity loads. An absolute
 * base would be fine here and wrong inside Discord's proxy, which is what it
 * was set for.
 *
 * Both pages always build together — `emptyOutDir` empties the lot — and the
 * review page importing anything from `client/src` re-chunks the activity's
 * bundle. Neither matters, and both mean "ship the review page" is never an
 * independent deploy.
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
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "client/index.html"),
        review: resolve(import.meta.dirname, "client/review/index.html"),
      },
    },
  },
  server: {
    port: 3000,
    proxy: { "/api": "http://localhost:3001" },
  },
});
