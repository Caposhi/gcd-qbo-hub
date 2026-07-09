import { describe, it, expect } from "vitest";
import { generateRowUuid, isValidRowUuid, extractRowUuid, CONTROL_KEYS } from "@/lib/cashsheet/uuid";

describe("hidden row UUID handling (§3, §4)", () => {
  it("generates namespaced, valid uuids", () => {
    const u = generateRowUuid();
    expect(u.startsWith("gcdqbo-")).toBe(true);
    expect(isValidRowUuid(u)).toBe(true);
  });

  it("rejects malformed / stray values", () => {
    expect(isValidRowUuid("")).toBe(false);
    expect(isValidRowUuid("not-a-uuid")).toBe(false);
    expect(isValidRowUuid("gcdqbo-123")).toBe(false);
    expect(isValidRowUuid(null)).toBe(false);
    expect(isValidRowUuid(42)).toBe(false);
  });

  it("extracts a uuid from the hidden control column", () => {
    const u = generateRowUuid();
    expect(extractRowUuid({ [CONTROL_KEYS.rowId]: u })).toBe(u);
    expect(extractRowUuid({ [CONTROL_KEYS.rowId]: "  " + u + " " })).toBe(u);
    expect(extractRowUuid({})).toBeNull();
    expect(extractRowUuid(undefined)).toBeNull();
    expect(extractRowUuid({ [CONTROL_KEYS.rowId]: "garbage" })).toBeNull();
  });
});
