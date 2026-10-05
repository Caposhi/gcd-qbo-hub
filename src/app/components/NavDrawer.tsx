"use client";
/* =============================================================================
   Mobile navigation drawer. On wide screens the sidebar is a permanent rail and
   none of this is visible. At the mobile breakpoint (see globals.css §11) the
   sidebar becomes an off-canvas drawer: the top bar's menu button opens it, and
   tapping the backdrop, pressing Esc, or following any link closes it. The
   page behind is scroll-locked while it is open.
   ========================================================================== */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

interface DrawerState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const DrawerContext = createContext<DrawerState>({ open: false, setOpen: () => {} });

export const useNavDrawer = () => useContext(DrawerContext);

export function NavDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  const pathname = usePathname();
  const setOpen = useCallback((v: boolean) => setOpenState(v), []);

  // Any navigation closes the drawer.
  useEffect(() => {
    setOpenState(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenState(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.classList.add("nav-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("nav-open");
    };
  }, [open]);

  return <DrawerContext.Provider value={{ open, setOpen }}>{children}</DrawerContext.Provider>;
}

/** Hamburger in the top bar — hidden on wide screens by CSS. */
export function MenuButton() {
  const { open, setOpen } = useNavDrawer();
  return (
    <button
      type="button"
      className="icon-btn menu-btn"
      aria-label="Open menu"
      aria-controls="hub-sidebar"
      aria-expanded={open}
      onClick={() => setOpen(true)}
    >
      <Menu size={22} />
    </button>
  );
}

/** Close button inside the drawer — hidden on wide screens by CSS. */
export function DrawerCloseButton() {
  const { setOpen } = useNavDrawer();
  return (
    <button type="button" className="icon-btn drawer-close" aria-label="Close menu" onClick={() => setOpen(false)}>
      <X size={20} />
    </button>
  );
}

/** Dimmed backdrop behind the open drawer; tap to dismiss. */
export function NavBackdrop() {
  const { open, setOpen } = useNavDrawer();
  return <div className={"nav-backdrop" + (open ? " open" : "")} aria-hidden onClick={() => setOpen(false)} />;
}
