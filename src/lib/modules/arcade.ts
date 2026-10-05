/**
 * GCD Arcade — the launcher hub every program links back to (top bar on wide
 * screens, the slide-out menu on phones). Override via env if Render ever
 * assigns the arcade's static site a different host.
 */
export const ARCADE_URL = process.env.NEXT_PUBLIC_ARCADE_URL || "https://gcd-arcade-web.onrender.com";
