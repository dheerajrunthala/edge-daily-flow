import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Edge-runtime modules are testable here as long as every npm:/jsr: specifier they
    // reach is erased at compile time. A bare `import type { SupabaseClient } from
    // "jsr:..."` qualifies — esbuild strips it — which is why agent-tools.ts,
    // agent-registry.ts, features.ts and tasks.ts all run under vitest despite naming a
    // jsr package. What does not work is a *value* import: feeds.ts and time.ts have no
    // imports at all, gemini.ts only fetch.
    //
    // So before adding a file here, check that its imports are either type-only or
    // relative. If vitest cannot resolve a specifier, that is what went wrong.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "supabase/functions/_shared/*.{test,spec}.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
