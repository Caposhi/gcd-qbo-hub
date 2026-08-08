import Link from "next/link";
import { DATE_RANGE_PRESETS, type DateRangePreset } from "@/lib/cashsheet/date-range";

/**
 * Shared date-range preset pills + custom-range form for any page listing
 * transactions (Queue, Deposits — §Phase 3 of the dashboard redesign). Server
 * component: every preset is a plain link so the range lives in the URL and
 * composes with every other filter already there (bookmarkable, shareable,
 * and safe for the dashboard's status tiles to link into without knowing
 * about date filtering at all).
 */
export function DateRangeFilter({
  activePreset,
  customFrom,
  customTo,
  hrefFor,
  otherHiddenFields,
}: {
  /** "" (unset) is treated the same as "all" — see date-range.ts. */
  activePreset: string;
  customFrom?: string;
  customTo?: string;
  /** Build the href for switching to a given preset, preserving other filters. */
  hrefFor: (preset: DateRangePreset) => string;
  /** Other active filters to carry through the custom-range GET form as hidden fields. */
  otherHiddenFields?: Record<string, string>;
}) {
  return (
    <div style={{ marginTop: "0.5rem" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
        {DATE_RANGE_PRESETS.map((p) => {
          const isActive = activePreset === p.value || (p.value === "all" && !activePreset);
          return (
            <Link
              key={p.value}
              href={hrefFor(p.value)}
              className="filter-pill"
              style={
                isActive
                  ? { borderColor: "var(--royal-blue)", color: "var(--royal-blue)", background: "var(--powder-blue-100)", fontWeight: 700 }
                  : {}
              }
            >
              {p.label}
            </Link>
          );
        })}
      </div>
      {activePreset === "custom" && (
        <form method="get" className="row-actions" style={{ marginTop: 8 }}>
          <input type="hidden" name="range" value="custom" />
          {otherHiddenFields &&
            Object.entries(otherHiddenFields).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
          <label className="card-subtitle" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
            From <input className="input" type="date" name="from" defaultValue={customFrom} />
          </label>
          <label className="card-subtitle" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
            To <input className="input" type="date" name="to" defaultValue={customTo} />
          </label>
          <button className="btn primary" type="submit">Apply</button>
        </form>
      )}
    </div>
  );
}
