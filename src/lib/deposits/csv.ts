/**
 * Minimal, dependency-free CSV parser for processor exports.
 *
 * Handles quoted fields, embedded commas/quotes ("" escaping), and the Excel
 * text-guard some exports use on numeric-looking id columns (e.g. `="6585954"`
 * and `="190001"` in the Chase Paymentech file). Returns an array of row objects
 * keyed by the (trimmed) header names.
 */

/** Parse one CSV line into fields, honoring RFC-4180 quoting. */
function parseLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      // A quote only opens a quoted field at the field start. This keeps Excel's
      // text-guard `="189001"` intact (the `=` comes first) so stripGuard can
      // unwrap it, rather than mangling it mid-parse.
      inQuotes = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

/** Strip an Excel text-guard wrapper: `="6585954"` → `6585954`. */
export function stripGuard(v: string): string {
  const m = /^="(.*)"$/.exec(v.trim());
  return (m ? m[1] : v).trim();
}

export function parseCsv(text: string): Array<Record<string, string>> {
  // Split on CR?LF but not inside quotes. Since our exports don't embed newlines
  // in fields, a straightforward line split is safe and simpler.
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const headers = parseLine(lines[0]).map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = stripGuard(cells[idx] ?? "");
    });
    rows.push(row);
  }
  return rows;
}
