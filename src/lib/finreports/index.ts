/**
 * Financial Reports module — public surface (see docs/FINANCIAL_REPORTS.md).
 *
 * Pure shaping/validation (types, statement, tabular, catalog, capabilities) is
 * safe to import anywhere, including unit tests. The IO layer lives in
 * `./service` and is imported directly by server components / actions so a test
 * never pulls Prisma in transitively.
 */
export * from "./types";
export * from "./statement";
export * from "./tabular";
export * from "./catalog";
export * from "./capabilities";
