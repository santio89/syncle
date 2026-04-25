"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * Theme name. `system` isn't exposed yet - could be added later by reading
 * `prefers-color-scheme` and listening to its `change` event. For now the
 * toggle is binary so the UI stays predictable.
 */
export type Theme = "light" | "dark";

const STORAGE_KEY = "syncle.theme";
const DEFAULT_THEME: Theme = "dark";
/**
 * The class added to <html> for the duration of a theme swap. Scoped here
 * (not in `*` selector globally) so transitions don't fire on every hover
 * or first paint - only when the user actually toggles. Matches a class
 * defined in globals.css.
 */
const TRANSITION_CLASS = "theme-transitioning";
/** How long to keep TRANSITION_CLASS on. Slightly longer than --dur-theme
 *  (currently 220ms in globals.css) so no animation gets clipped mid-curve.
 *  Bumped a bit beyond the strict transition window to absorb scheduling
 *  jitter on slower devices. */
const TRANSITION_HOLD_MS = 320;

interface ThemeContextValue {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Read the user's preferred theme from localStorage, falling back to the
 * default. Safe on the server: returns the default without touching DOM.
 */
function readStoredTheme(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* localStorage blocked (Safari private mode etc.) - fall through. */
  }
  return DEFAULT_THEME;
}

/**
 * Provider mounted at the root. Reads the persisted theme on mount, syncs
 * the `data-theme` attribute on <html>, and exposes a context API.
 *
 * The initial paint is handled by the inline script in app/layout.tsx -
 * by the time React hydrates, <html> already has the right attribute.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());

  // Mirror state → DOM. Add a short-lived class around the swap so CSS can
  // animate the change with the cubic-bezier curve from globals.css. We
  // only add it AFTER the initial mount so first paint isn't animated.
  const initialMount = useTrueOnFirstRender();
  useEffect(() => {
    const html = document.documentElement;
    html.dataset.theme = theme;

    if (initialMount) return; // skip animation on the very first render
    html.classList.add(TRANSITION_CLASS);
    const t = window.setTimeout(
      () => html.classList.remove(TRANSITION_CLASS),
      TRANSITION_HOLD_MS,
    );
    return () => {
      window.clearTimeout(t);
      html.classList.remove(TRANSITION_CLASS);
    };
  }, [theme, initialMount]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore - we still update in-memory state */
    }
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Returns true on the very first render only. */
function useTrueOnFirstRender(): boolean {
  const [first, setFirst] = useState(true);
  useEffect(() => {
    setFirst(false);
  }, []);
  return first;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return ctx;
}
