/**
 * Financial Reporting — pure normalization layer (Phase 1).
 *
 * Barrel for the IO-free report modules: parse QBO's nested report JSON, roll
 * up series, compute period-over-period deltas + KPIs, and validate stored
 * snapshot payloads. Nothing here imports Prisma, Next, or the network — the
 * QBO fetch + cache lives in ../report-service.ts.
 */
export * from "./qbo";
export * from "./ranges";
export * from "./normalize";
export * from "./metrics";
export * from "./rollup";
export * from "./snapshot";
