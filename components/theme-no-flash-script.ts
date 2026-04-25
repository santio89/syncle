/**
 * Inline script that runs BEFORE React hydrates. Reads the persisted theme
 * from localStorage and writes it to <html data-theme> so the first paint
 * already uses the right colors - no flash of dark/light.
 *
 * Lives in its own file (NOT marked "use client") so the server component
 * `app/layout.tsx` can import it without dragging the ThemeProvider's
 * client-side code through the React Client Manifest.
 *
 * Keep the storage key + default in sync with components/ThemeProvider.tsx.
 */
const STORAGE_KEY = "syncle.theme";
const DEFAULT_THEME = "dark";

export const themeNoFlashScript = `
(function () {
  try {
    var t = localStorage.getItem("${STORAGE_KEY}");
    if (t !== "light" && t !== "dark") t = "${DEFAULT_THEME}";
    document.documentElement.dataset.theme = t;
  } catch (e) {
    document.documentElement.dataset.theme = "${DEFAULT_THEME}";
  }
})();
`;
