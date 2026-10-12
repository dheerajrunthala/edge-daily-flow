import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // _shared/time.ts is pure TypeScript with no npm:/jsr: imports, so the Edge copy of
    // the timezone helpers can be unit-tested here alongside the browser's. Keep that
    // true of anything added under this pattern: the rest of _shared imports
    // jsr:@supabase/supabase-js and will not resolve under vitest.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "supabase/functions/_shared/*.{test,spec}.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
