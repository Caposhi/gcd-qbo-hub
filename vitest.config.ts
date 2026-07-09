import { defineConfig } from "vitest/config";

// Unit tests target the pure domain logic under src/lib/cashsheet and
// src/lib/auth — no Next.js, Prisma, or network required. Keeping these tests
// dependency-free is deliberate (see §20): the business rules that protect a
// real accounting system must be verifiable in isolation.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
