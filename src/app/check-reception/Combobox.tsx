"use client";

import { useMemo, useRef, useState } from "react";

export interface ComboOption {
  id: string;
  name: string;
  /** Optional group label shown as muted suffix (e.g. account type). */
  hint?: string;
}

/**
 * Typeahead combobox for the check-review form — a QBO-style picker: type to
 * filter the real vendor/category list, click to select, and keep the id + name
 * in hidden fields so the server action gets both. `allowCreate` lets the vendor
 * field accept a brand-new name (id stays empty → the action creates the vendor);
 * the category field requires a pick from the list.
 *
 * Emits hidden inputs `${name}Name` and `${name}Id`, matching the action's
 * expected form fields (vendorName/vendorId, categoryName/categoryId).
 */
export function Combobox({
  name,
  options,
  defaultName = "",
  defaultId = "",
  allowCreate = false,
  placeholder,
  width = 300,
}: {
  name: string;
  options: ComboOption[];
  defaultName?: string;
  defaultId?: string;
  allowCreate?: boolean;
  placeholder?: string;
  width?: number;
}) {
  const [text, setText] = useState(defaultName);
  const [id, setId] = useState(defaultId);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    const list = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
    return list.slice(0, 50);
  }, [text, options]);

  function select(o: ComboOption) {
    setText(o.name);
    setId(o.id);
    setOpen(false);
  }

  return (
    <div style={{ position: "relative", width }}>
      <input type="hidden" name={`${name}Name`} value={text} />
      <input type="hidden" name={`${name}Id`} value={id} />
      <input
        type="text"
        className="input"
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        style={{ width: "100%" }}
        onChange={(e) => {
          setText(e.target.value);
          // Typing invalidates a prior pick; re-establish an id only on an exact
          // (case-insensitive) name match, else leave blank.
          const exact = options.find((o) => o.name.toLowerCase() === e.target.value.trim().toLowerCase());
          setId(exact ? exact.id : "");
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Delay so a click on an option registers before we close.
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) setOpen(true);
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            if (open && filtered[active]) {
              e.preventDefault();
              select(filtered[active]);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && filtered.length > 0 && (
        <ul
          style={{
            position: "absolute",
            zIndex: 20,
            left: 0,
            right: 0,
            margin: "2px 0 0",
            padding: 0,
            listStyle: "none",
            maxHeight: 240,
            overflowY: "auto",
            background: "var(--surface-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          {filtered.map((o, i) => (
            <li
              key={o.id}
              onMouseDown={(e) => {
                e.preventDefault();
                if (blurTimer.current) clearTimeout(blurTimer.current);
                select(o);
              }}
              onMouseEnter={() => setActive(i)}
              style={{
                padding: "6px 10px",
                cursor: "pointer",
                fontSize: "0.8rem",
                background: i === active ? "var(--powder-blue-100)" : "transparent",
                color: i === active ? "var(--royal-blue)" : "var(--text-body)",
                display: "flex",
                justifyContent: "space-between",
                gap: "0.5rem",
              }}
            >
              <span>{o.name}</span>
              {o.hint && <span style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
      {allowCreate && text.trim() && !id && (
        <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", marginTop: 4 }}>
          New vendor — will be created in QBO on confirm.
        </div>
      )}
    </div>
  );
}
