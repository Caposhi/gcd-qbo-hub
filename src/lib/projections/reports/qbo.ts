/**
 * Generic, IO-free parser for QuickBooks Online Report API payloads
 * (Financial Reporting, Phase 1).
 *
 * QBO returns every report (ProfitAndLoss, BalanceSheet, AgedReceivables, …) in
 * the same recursive envelope: a `Header`, a `Columns.Column[]` describing each
 * column, and a `Rows.Row[]` tree where a row is either a leaf (`ColData`) or a
 * `Section` (`Header` + nested `Rows` + a `Summary`). This module flattens that
 * tree into typed, position-addressable rows so the report-specific normalizers
 * (see normalize.ts) never touch QBO's nesting.
 *
 * Deliberately pure — no Prisma, Next, or network imports (§20). Same discipline
 * as src/lib/cashsheet: the parsing that everything else trusts is unit-tested
 * in isolation against captured sample payloads.
 */

/** A single report column ("" / "Total" / "Jan 2026" / "1 - 30" …). */
export interface QboColumn {
  title: string;
  /** QBO ColType, e.g. "Account", "Money", "Customer", "Vendor". */
  type: string;
  /** ColKey from the column MetaData when present (e.g. "total"). */
  colKey?: string;
}

export type QboRowKind = "data" | "section_summary";

/**
 * One flattened report row, addressable by column position.
 *
 * `values[i]` corresponds to the (i+1)-th column — i.e. the value columns AFTER
 * the leading label column. A value is a parsed number, or `null` when the cell
 * is blank / non-numeric.
 */
export interface QboFlatRow {
  /** Section-header labels above this row, outermost first. */
  group: string[];
  /** The QBO row `group` code (e.g. "Income", "GrossProfit", "NetIncome"), resolved from the nearest section when the row itself has none. */
  groupCode?: string;
  /** Display label (first ColData cell). */
  label: string;
  /** Account / customer / item id when QBO provides one. */
  id?: string;
  /** Parsed numeric value per value-column (null when blank/non-numeric). */
  values: Array<number | null>;
  /** Raw string cells for the value-columns (before parsing). */
  rawValues: string[];
  kind: QboRowKind;
  /** Nesting depth (0 = top level). */
  depth: number;
}

export interface QboReport {
  reportName: string;
  startPeriod?: string;
  endPeriod?: string;
  accountingMethod?: string;
  currency?: string;
  /** Value columns only (the leading label column is dropped). */
  columns: QboColumn[];
  /** Index into `columns` of the grand-total column, or -1 when there is none. */
  totalColumnIndex: number;
  rows: QboFlatRow[];
}

/**
 * Parse a QBO money/quantity cell into a number.
 *
 * Handles thousands separators, currency symbols, parenthesised negatives
 * "(123.45)", stray whitespace, and QBO's blank "" / "-" placeholders. Returns
 * null when there is nothing numeric to parse, so callers never treat a missing
 * cell as zero by accident.
 */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s === "" || s === "-") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (s === "" || !/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

interface RawColData {
  value?: string;
  id?: string;
}
interface RawRow {
  Header?: { ColData?: RawColData[] };
  Rows?: { Row?: RawRow[] };
  Summary?: { ColData?: RawColData[] };
  ColData?: RawColData[];
  type?: string;
  group?: string;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function colDataToValues(colData: RawColData[] | undefined): {
  label: string;
  id?: string;
  values: Array<number | null>;
  rawValues: string[];
} {
  const cells = Array.isArray(colData) ? colData : [];
  const first = cells[0] ?? {};
  const rest = cells.slice(1);
  return {
    label: typeof first.value === "string" ? first.value : "",
    id: typeof first.id === "string" && first.id !== "" ? first.id : undefined,
    values: rest.map((c) => parseAmount(c?.value)),
    rawValues: rest.map((c) => (typeof c?.value === "string" ? c.value : "")),
  };
}

function walk(
  rows: RawRow[],
  path: string[],
  parentGroup: string | undefined,
  depth: number,
  out: QboFlatRow[]
): void {
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const isSection = !!(row.Header && row.Rows);
    const ownGroup = typeof row.group === "string" && row.group !== "" ? row.group : undefined;

    if (isSection) {
      const headerCells = colDataToValues(row.Header?.ColData);
      const sectionLabel = headerCells.label;
      const childRows = Array.isArray(row.Rows?.Row) ? (row.Rows!.Row as RawRow[]) : [];
      walk(childRows, [...path, sectionLabel], ownGroup ?? parentGroup, depth + 1, out);
      if (row.Summary?.ColData) {
        const s = colDataToValues(row.Summary.ColData);
        out.push({
          group: path,
          groupCode: ownGroup ?? parentGroup,
          label: s.label || `Total ${sectionLabel}`,
          values: s.values,
          rawValues: s.rawValues,
          kind: "section_summary",
          depth,
        });
      }
    } else if (row.ColData) {
      const d = colDataToValues(row.ColData);
      out.push({
        group: path,
        groupCode: ownGroup ?? parentGroup,
        label: d.label,
        id: d.id,
        values: d.values,
        rawValues: d.rawValues,
        kind: "data",
        depth,
      });
    } else if (row.Summary?.ColData) {
      // A summary-only row: QBO emits the single-line P&L totals (Gross Profit,
      // Net Operating Income, Net Income) as a row carrying a `group` code and a
      // `Summary` but NO `Header`/`Rows` and NO top-level `ColData`. Without this
      // branch those totals are dropped entirely and read back as 0. Capture the
      // summary as a section_summary so findByGroup can resolve it.
      const s = colDataToValues(row.Summary.ColData);
      out.push({
        group: path,
        groupCode: ownGroup ?? parentGroup,
        label: s.label,
        values: s.values,
        rawValues: s.rawValues,
        kind: "section_summary",
        depth,
      });
    }
  }
}

/**
 * Parse a raw QBO report payload into a flat, typed {@link QboReport}.
 *
 * Tolerant by design: a missing/!object payload yields an empty report rather
 * than throwing, so a malformed snapshot can never crash a page (§ handoff).
 */
export function parseQboReport(payload: unknown): QboReport {
  const root = asObject(payload);
  const header = asObject(root.Header);
  const columnsWrap = asObject(root.Columns);
  const rawColumns = Array.isArray(columnsWrap.Column) ? (columnsWrap.Column as unknown[]) : [];

  // Drop the leading label column; keep the value columns.
  const valueColumns: QboColumn[] = rawColumns.slice(1).map((c) => {
    const col = asObject(c);
    const meta = Array.isArray(col.MetaData) ? (col.MetaData as unknown[]) : [];
    const colKeyEntry = meta.map(asObject).find((m) => m.Name === "ColKey");
    return {
      title: typeof col.ColTitle === "string" ? col.ColTitle : "",
      type: typeof col.ColType === "string" ? col.ColType : "",
      colKey: colKeyEntry && typeof colKeyEntry.Value === "string" ? colKeyEntry.Value : undefined,
    };
  });

  const totalColumnIndex = valueColumns.findIndex(
    (c) => c.colKey === "total" || /^total$/i.test(c.title)
  );

  const option = Array.isArray(header.Option) ? (header.Option as unknown[]).map(asObject) : [];
  const accountingMethod = option.find((o) => o.Name === "AccountingMethod")?.Value;

  const rowsWrap = asObject(root.Rows);
  const rawRows = Array.isArray(rowsWrap.Row) ? (rowsWrap.Row as RawRow[]) : [];
  const flat: QboFlatRow[] = [];
  walk(rawRows, [], undefined, 0, flat);

  return {
    reportName: typeof header.ReportName === "string" ? header.ReportName : "",
    startPeriod: typeof header.StartPeriod === "string" ? header.StartPeriod : undefined,
    endPeriod: typeof header.EndPeriod === "string" ? header.EndPeriod : undefined,
    accountingMethod: typeof accountingMethod === "string" ? accountingMethod : undefined,
    currency: typeof header.Currency === "string" ? header.Currency : undefined,
    columns: valueColumns,
    totalColumnIndex,
    rows: flat,
  };
}

/** Value-column indices that are NOT the grand-total column (period columns). */
export function periodColumnIndices(report: QboReport): number[] {
  return report.columns.map((_, i) => i).filter((i) => i !== report.totalColumnIndex);
}
