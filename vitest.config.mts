import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * `@/…` is the repo's own import convention (`tsconfig.json` "paths"), and Next
 * resolves it in the app. Vite does NOT read tsconfig paths, so without this
 * alias a `lib/**` module that imports `@/lib/x` type-checks clean and then
 * fails to import under vitest with "Cannot find package '@/lib/x'". The two
 * resolvers have to agree or the gate lies.
 */
const repoRoot = fileURLToPath(new URL(".", import.meta.url)).replace(/[\\/]$/, "");

export default defineConfig({
  resolve: {
    // A bare "@" only matches the id "@" or an id starting "@/", so scoped
    // packages like "@supabase/supabase-js" are untouched.
    alias: { "@": repoRoot },
  },
  test: { include: ["lib/**/*.test.ts"] },
});
