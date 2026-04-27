/**
 * Tiny key/value settings store backed by localStorage.
 *
 * Kept separate from `best.ts` because settings are global (not per-day,
 * not per-song) and have very different lifecycle than score persistence.
 */

const VOL_KEY = "syncle.volume";
// Default master volume on first launch (when no persisted value is
// found). This slider is the MASTER bus - `AudioEngine.setVolume()`
// ramps both the song gain AND the SFX gain in lockstep, so it
// controls music, hit feedback, metronome, and milestone cues
// together. UI labels call it "Volume" (not "Music volume") for
// this reason.
// 0.5 = 50% - half of the perceptually-tapered slider, which lands at
// roughly 44% perceived loudness with the song bus's quadratic curve
// and ~70% perceived on the SFX bus's gentler square-root curve. This
// is the "polite default": loud enough that a brand-new player hears
// the chart and the feedback SFX clearly on first launch, quiet
// enough that we don't blow out anyone wearing headphones at full
// system volume. Was 1.0 historically; landing at 50% gives the slider
// usable headroom in BOTH directions out of the box, which matters
// more now that the taper is honest end-to-end.
const DEFAULT_VOLUME = 0.5;
const FPS_LOCK_KEY = "syncle.fpsLock";
// Uncapped by default - the rAF loop runs one draw per vblank, which
// matches the player's monitor refresh rate out of the box. Exported
// so VIDEO's "Reset to defaults" can snap back to `null` without each
// call site having to hardcode the sentinel. Players who want to save
// battery (30 FPS) or match a 60 Hz monitor exactly (60 FPS) can cycle
// from the Video popover; the choice persists in `FPS_LOCK_KEY`.
export const DEFAULT_FPS_LOCK: FpsLock = null;
const SFX_KEY = "syncle.sfx";
const DEFAULT_SFX = true;
const METRONOME_KEY = "syncle.metronome";
// Off by default - most players treat the metronome as a learning aid
// for unfamiliar tracks rather than a permanent gameplay layer, and a
// surprise click on every beat the first time the app loads reads as a
// bug instead of a feature. Players who want it can flip it on from
// the StartCard / HUD / Lobby tile (key: M); the choice persists in
// `METRONOME_KEY` across sessions.
const DEFAULT_METRONOME = false;
// Strict Inputs (anti-mash combo-break on empty presses) is
// USER-CONFIGURABLE in multiplayer only (host-controlled via
// `RoomSnapshot.strictInputs` in `lib/multi/protocol.ts`, flipped
// from `PlayerSettingsModal` in the lobby). In solo the behavior
// is ALWAYS ON - no toggle, no localStorage - so home-page
// leaderboards stay comparable across players (otherwise a
// solo player who'd flipped strict off could rack up inflated
// "best" scores by panic-mashing). The previous
// `syncle.strictInputs` localStorage key is no longer read or
// written; orphaned entries from older installs will stay in
// localStorage but are harmless (nothing reads them).
const QUALITY_KEY = "syncle.quality";
// High (Quality) is the default - the canvas is tuned to look its
// best with the full VFX reel (particles, shockwaves, glow halos,
// milestone vignette, lane-gate anticipation), and modern GPUs
// (including integrated ones on recent laptops) handle it cleanly.
// Players on low-end hardware, on battery, or who prefer a calmer
// canvas can flip to PERFORMANCE from the StartCard / HUD / Lobby
// tile; the choice persists across sessions in `QUALITY_KEY`.
// Exported so VIDEO's "Reset to defaults" can snap back without
// each call site having to duplicate the literal.
export const DEFAULT_QUALITY: RenderQuality = "high";
const PERSPECTIVE_KEY = "syncle.perspective";
// 2D (osu!-style flat lanes) is the default: parallel rails,
// constant note size, no perspective depth. Chosen as the default
// because player feedback flagged the 3D perspective highway as
// disorienting for a subset of players (the notes grew as they
// approached and the rails converged, which paired with flat
// 2D input buttons read as inconsistent and mildly dizzying).
// The 2D view is the stabler "first impression" - flat playfield,
// flat inputs, flat notes, everything in the screen plane.
// Players who prefer the Guitar Hero / Rock Band look can flip
// to `"3d"` from the StartCard / HUD / Lobby tile; the choice
// persists in `PERSPECTIVE_KEY` across sessions. The switch is
// purely visual - gameplay math (timing windows, hit registration,
// scoring) is identical in both modes, so it's stored as a per-
// player preference and never synced over the multiplayer wire.
// Exported so VIDEO's "Reset to defaults" can snap back without
// each call site having to duplicate the literal.
export const DEFAULT_PERSPECTIVE_MODE: PerspectiveMode = "2d";
const NOTE_SHAPE_KEY = "syncle.noteShape";
// Rectangles are the shipping default - they match the brutalist
// theme of the rest of the app (hard-edged cards, buttons, borders,
// chips) and the osu!mania 4K canonical look. Circles are offered
// as a secondary mode for players who prefer the classic osu!/
// rhythm-game disc aesthetic ("the dots from back in the day").
// Local-only setting like Quality / FPS / Perspective - never
// synced over the multiplayer wire, two players in the same room
// can run different note shapes with zero impact on fairness.
// Exported so VIDEO's "Reset to defaults" can snap back without
// each call site having to duplicate the literal.
export const DEFAULT_NOTE_SHAPE: NoteShape = "rect";

/* -----------------------------------------------------------------------
 * Storage-health signal - fires the first time a settings / resume /
 * best-score write fails (quota exceeded, private mode, etc.). Components
 * can subscribe via `onStorageFailure` to surface a single discreet
 * "settings won't persist" toast so the player isn't silently surprised
 * later. Idempotent per session - we don't spam the listener after the
 * first failure since every subsequent save attempt would re-fire it.
 * ------------------------------------------------------------------- */

let storageFailureFired = false;
const storageFailureListeners = new Set<() => void>();

/**
 * Record a localStorage / sessionStorage write failure. Safe to call
 * from any try/catch arm - first call notifies listeners, subsequent
 * calls are no-ops for the rest of the session.
 */
export function reportStorageFailure(): void {
  if (storageFailureFired) return;
  storageFailureFired = true;
  for (const cb of storageFailureListeners) {
    try {
      cb();
    } catch {
      /* swallow - listener errors must not poison sibling listeners */
    }
  }
}

/**
 * Subscribe to the first storage failure. Returns an unsubscribe
 * function. If a failure has ALREADY been reported when the caller
 * subscribes (e.g. a save failed in a render-loop tick before the HUD
 * mounted), the listener fires synchronously so late subscribers still
 * see the signal.
 */
export function onStorageFailure(cb: () => void): () => void {
  storageFailureListeners.add(cb);
  if (storageFailureFired) {
    try {
      cb();
    } catch {
      /* swallow */
    }
  }
  return () => {
    storageFailureListeners.delete(cb);
  };
}

/** True if a write has failed at least once this session. */
export function hasStorageFailed(): boolean {
  return storageFailureFired;
}

/**
 * Optional render-loop frame-rate cap.
 *
 * - `null`  → uncapped (one draw per vblank - 60Hz on most monitors,
 *             144/200/240 Hz on high-refresh displays).
 * - `30/60` → render at most that many frames per second. The rAF loop
 *             still wakes every vblank but skips the draw call until the
 *             frame budget has elapsed, so the audio clock + input
 *             scheduling stay sample-accurate even under a render cap.
 *
 * Useful on laptops to extend battery life, on integrated GPUs that
 * struggle to hit 200 Hz, or just to keep fans quiet when the player
 * doesn't need every available frame.
 */
export type FpsLock = 30 | 60 | null;

/** Cycle order for the in-game lock toggle: off → 30 → 60 → off. */
export const FPS_LOCK_CYCLE: FpsLock[] = [null, 30, 60];

export function nextFpsLock(current: FpsLock): FpsLock {
  const i = FPS_LOCK_CYCLE.indexOf(current);
  return FPS_LOCK_CYCLE[(i + 1) % FPS_LOCK_CYCLE.length];
}

export function loadFpsLock(): FpsLock {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(FPS_LOCK_KEY);
    if (raw == null || raw === "off" || raw === "null") return null;
    const n = parseInt(raw, 10);
    if (n === 30 || n === 60) return n;
    return null;
  } catch {
    return null;
  }
}

export function saveFpsLock(v: FpsLock): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FPS_LOCK_KEY, v == null ? "off" : String(v));
  } catch {
    reportStorageFailure();
  }
}

/* -----------------------------------------------------------------------
 * Render quality preset.
 *
 * - `"high"`       → full visual feedback: particles, shockwaves, glow
 *                    halos, milestone vignette, lane-gate anticipation.
 *                    The default and what every player sees out of the
 *                    box. Tuned to look great on a desktop GPU.
 *
 * - `"performance"` → pruned VFX for low-end / integrated GPUs and
 *                     accessibility-conscious players who want a
 *                     calmer canvas. Particles + shockwaves + the
 *                     milestone vignette + the canvas combo glow are
 *                     skipped entirely; lane-gate and tap-note
 *                     shadowBlur are also disabled (the most
 *                     fillrate-expensive operations on the highway).
 *                     Notes, hold trails, judgment line, and beat
 *                     dot are still drawn - gameplay reads identical,
 *                     just without the celebratory polish.
 *
 * Live-applied via `RenderOptions.quality` - the renderer's hot
 * paths gate the heavy effects on this flag without re-allocating
 * any state, so toggling the setting mid-match takes effect on the
 * next frame.
 * ------------------------------------------------------------------- */
export type RenderQuality = "high" | "performance";

/** Cycle order for the in-game quality toggle. */
export const QUALITY_CYCLE: RenderQuality[] = ["high", "performance"];

export function nextRenderQuality(current: RenderQuality): RenderQuality {
  return current === "high" ? "performance" : "high";
}

export function loadRenderQuality(): RenderQuality {
  if (typeof window === "undefined") return DEFAULT_QUALITY;
  try {
    const raw = window.localStorage.getItem(QUALITY_KEY);
    if (raw === "performance") return "performance";
    if (raw === "high") return "high";
    return DEFAULT_QUALITY;
  } catch {
    return DEFAULT_QUALITY;
  }
}

export function saveRenderQuality(v: RenderQuality): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(QUALITY_KEY, v);
  } catch {
    reportStorageFailure();
  }
}

/* -----------------------------------------------------------------------
 * Playfield perspective mode.
 *
 * Controls the geometry of the highway, notes, rails, and hold trails:
 *
 * - `"3d"` → the Guitar Hero / Rock Band layout that has always
 *            shipped. The highway is a trapezoid: top edge at 50% of
 *            the bottom width, rails converge toward the top, notes
 *            and hold trails scale from ~15 px wide at the top to
 *            ~26 px at the judgment line. Beat lines also taper
 *            horizontally to match the rail slope. Gives the game
 *            visible depth and a "rushing toward the player" feel.
 *
 * - `"2d"` → osu!mania-style flat layout. Top edge = bottom edge
 *            (rectangular highway), rails are perfectly vertical,
 *            notes are a constant size, hold trails are constant
 *            width. Pairs better with the flat 2D lane-gate buttons
 *            at the bottom, eliminating the 2D/3D mismatch that
 *            several players reported as mildly disorienting.
 *
 * Gameplay math (timing windows, hit registration, scoring,
 * combo/score deltas, replay-worthy events) is IDENTICAL in both
 * modes - this is a purely visual choice. Because it's purely
 * visual, the setting is local-only (like Quality, FPS lock,
 * metronome, feedback) and never synced over the multiplayer wire.
 * Two players in the same room can run different perspective modes
 * without any impact on fairness or leaderboard comparability.
 * ------------------------------------------------------------------- */
export type PerspectiveMode = "2d" | "3d";

/** Cycle order for the in-game View toggle. */
export const PERSPECTIVE_CYCLE: PerspectiveMode[] = ["2d", "3d"];

export function nextPerspectiveMode(current: PerspectiveMode): PerspectiveMode {
  return current === "3d" ? "2d" : "3d";
}

export function loadPerspectiveMode(): PerspectiveMode {
  if (typeof window === "undefined") return DEFAULT_PERSPECTIVE_MODE;
  try {
    const raw = window.localStorage.getItem(PERSPECTIVE_KEY);
    if (raw === "2d") return "2d";
    if (raw === "3d") return "3d";
    return DEFAULT_PERSPECTIVE_MODE;
  } catch {
    return DEFAULT_PERSPECTIVE_MODE;
  }
}

export function savePerspectiveMode(v: PerspectiveMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PERSPECTIVE_KEY, v);
  } catch {
    reportStorageFailure();
  }
}

/* -----------------------------------------------------------------------
 * Note + receptor shape.
 *
 * - `"rect"`   → brutalist rectangular tiles (default). Filled lane-
 *                colored rectangles matching the rest of the app's
 *                hard-edged design language. In 3D mode they render
 *                as true single-vanishing-point trapezoids that read
 *                as "lying flat on the tilted fret." Matches the
 *                osu!mania 4K canonical look.
 *
 * - `"circle"` → classic rhythm-game discs. Filled lane-colored
 *                circles with a subtle inner core. Drops the 3D
 *                perspective tilt on the note itself (width taper
 *                doesn't apply to circles), but the highway still
 *                foreshortens, so the scene still reads as 3D.
 *                Pick this if you grew up on osu!/BMS and want the
 *                "dots falling" look instead of the tile look.
 *
 * Gameplay math (timing windows, hit registration, scoring) is
 * identical in both shapes - purely visual choice. Persists across
 * sessions; local-only (not synced over multiplayer).
 * ------------------------------------------------------------------- */
export type NoteShape = "rect" | "circle";

/** Cycle order for the in-game Shape toggle. */
export const NOTE_SHAPE_CYCLE: NoteShape[] = ["rect", "circle"];

export function nextNoteShape(current: NoteShape): NoteShape {
  return current === "rect" ? "circle" : "rect";
}

export function loadNoteShape(): NoteShape {
  if (typeof window === "undefined") return DEFAULT_NOTE_SHAPE;
  try {
    const raw = window.localStorage.getItem(NOTE_SHAPE_KEY);
    if (raw === "rect") return "rect";
    if (raw === "circle") return "circle";
    return DEFAULT_NOTE_SHAPE;
  } catch {
    return DEFAULT_NOTE_SHAPE;
  }
}

export function saveNoteShape(v: NoteShape): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NOTE_SHAPE_KEY, v);
  } catch {
    reportStorageFailure();
  }
}

export function loadVolume(): number {
  if (typeof window === "undefined") return DEFAULT_VOLUME;
  try {
    const raw = window.localStorage.getItem(VOL_KEY);
    if (raw == null) return DEFAULT_VOLUME;
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return DEFAULT_VOLUME;
    return Math.min(1, Math.max(0, v));
  } catch {
    return DEFAULT_VOLUME;
  }
}

export function saveVolume(v: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VOL_KEY, String(Math.min(1, Math.max(0, v))));
  } catch {
    reportStorageFailure();
  }
}

/**
 * Input sound effects toggle. When `false`, the engine suppresses
 * hit / miss / release / combo-milestone SFX (and the song's "duck"
 * cue that fires on a miss). The metronome and song playback itself
 * are deliberately NOT affected - those have their own controls and
 * silencing them here would surprise the player.
 */
export function loadSfx(): boolean {
  if (typeof window === "undefined") return DEFAULT_SFX;
  try {
    const raw = window.localStorage.getItem(SFX_KEY);
    if (raw == null) return DEFAULT_SFX;
    return raw === "1" || raw === "true" || raw === "on";
  } catch {
    return DEFAULT_SFX;
  }
}

export function saveSfx(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SFX_KEY, on ? "1" : "0");
  } catch {
    reportStorageFailure();
  }
}

/**
 * Metronome (audible click track on every beat) toggle. Local only -
 * never affects other players in multiplayer. Mirrored into the
 * AudioEngine via `setMetronome` when the React state changes.
 */
export function loadMetronome(): boolean {
  if (typeof window === "undefined") return DEFAULT_METRONOME;
  try {
    const raw = window.localStorage.getItem(METRONOME_KEY);
    if (raw == null) return DEFAULT_METRONOME;
    return raw === "1" || raw === "true" || raw === "on";
  } catch {
    return DEFAULT_METRONOME;
  }
}

export function saveMetronome(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(METRONOME_KEY, on ? "1" : "0");
  } catch {
    reportStorageFailure();
  }
}

/**
 * Strict Inputs has no load / save helpers on purpose - solo is
 * hardcoded on (for scoreboard parity) and the multiplayer value
 * lives on `RoomSnapshot.strictInputs` (server-authoritative). See
 * the top-of-file comment on the removed `STRICT_INPUTS_KEY` for
 * the full rationale.
 */

/* -----------------------------------------------------------------------
 * Lane keybinds.
 *
 * Each of the 4 lanes accepts up to TWO keys: a "primary" slot and a
 * "secondary" slot. The historical default - kept on first launch and
 * after a reset - is the osu!mania 4K layout that has always shipped:
 *
 *   Lane 0 (red)    : KeyD  +  ArrowLeft
 *   Lane 1 (yellow) : KeyF  +  ArrowDown
 *   Lane 2 (green)  : KeyJ  +  ArrowUp
 *   Lane 3 (blue)   : KeyK  +  ArrowRight
 *
 * Codes are `KeyboardEvent.code` values (physical-position, layout-
 * independent), NOT `KeyboardEvent.key` (which is the printed character
 * and varies with the active OS keyboard layout). Game inputs care about
 * the position of the key under the player's finger, not what character
 * a French AZERTY layout would have produced - that's the whole point
 * of the `.code` property and matches what other rhythm games do.
 *
 * An empty string `""` means "unbound" - the lane is still playable as
 * long as at least one slot per lane is non-empty (the editor lets the
 * player wipe a slot if they want a single-key lane, or both if they
 * want to disable a lane entirely - the press handler simply skips
 * unmapped codes).
 *
 * Storage is purely local: bindings never sync over the multiplayer
 * wire, just like the visual settings (FPS lock / Quality / View /
 * Shape). Two players in the same room can run completely different
 * bindings - gameplay math is identical and scores stay comparable.
 * ------------------------------------------------------------------- */
export type KeyBinding = readonly [string, string];
export type KeyBindings = readonly [KeyBinding, KeyBinding, KeyBinding, KeyBinding];

const KEYBINDS_KEY = "syncle.keybinds";

export const DEFAULT_KEYBINDS: KeyBindings = [
  ["KeyD", "ArrowLeft"],
  ["KeyF", "ArrowDown"],
  ["KeyJ", "ArrowUp"],
  ["KeyK", "ArrowRight"],
];

/**
 * Codes the user can never bind to a lane. These would either trap
 * the browser (Tab focus, F-keys for devtools / fullscreen),
 * reserved for game meta-commands (Escape pause, M metronome,
 * N feedback), or are physically awkward / unlikely to be intended
 * (Win / Cmd / PrintScreen). The keybinds editor's capture handler
 * silently ignores keydowns for these codes so the slot stays in
 * "press a key" state until the player picks something usable.
 */
export const RESERVED_KEYBIND_CODES: ReadonlySet<string> = new Set([
  "Escape",
  "Tab",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "ContextMenu",
  "PrintScreen",
  "ScrollLock",
  "Pause",
  "MetaLeft", "MetaRight",
  "KeyM",
  "KeyN",
]);

/**
 * Build a fast `code -> lane` lookup from a `KeyBindings`. Empty slots
 * are skipped. Both `setKeybind` and the editor enforce uniqueness
 * across slots, so each non-empty code maps to exactly one lane in
 * practice; this helper is hot (called per keydown via a ref) so it
 * stays a plain object lookup.
 */
export function keybindsToLaneMap(bindings: KeyBindings): Record<string, number> {
  const out: Record<string, number> = {};
  for (let lane = 0; lane < bindings.length; lane++) {
    for (const code of bindings[lane]) {
      if (!code) continue;
      out[code] = lane;
    }
  }
  return out;
}

/**
 * Human-readable label for a `KeyboardEvent.code`. Used by the
 * keybinds editor button captions, the StartCard `KeyCap` row, the
 * countdown overlay's "press X / Y / Z / W" hint, and the canvas
 * receptor letter (via `deriveLaneLabels`). Returns the empty string
 * for unbound slots so callers can short-circuit to a placeholder
 * dash.
 *
 * Letter / digit / numpad codes get their bare character; arrows
 * become the unicode glyph (matches the rest of the UI's arrow
 * rendering). Symbol keys get their printed glyph for QWERTY
 * (acceptable approximation - this is purely a label, not an input
 * mapping). Modifier keys keep their L-/R- prefix so the editor
 * doesn't claim "Shift" when only one Shift is bound.
 */
export function formatKeyCode(code: string): string {
  if (!code) return "";
  if (code.length === 4 && code.startsWith("Key")) return code.slice(3);
  if (code.length === 6 && code.startsWith("Digit")) return code.slice(5);
  if (code.length === 7 && code.startsWith("Numpad")) return "Num" + code.slice(6);
  switch (code) {
    case "ArrowLeft":   return "\u2190";
    case "ArrowDown":   return "\u2193";
    case "ArrowUp":     return "\u2191";
    case "ArrowRight":  return "\u2192";
    case "Space":        return "Space";
    case "Enter":        return "Enter";
    case "Backspace":    return "Bksp";
    case "Backquote":    return "`";
    case "Minus":        return "-";
    case "Equal":        return "=";
    case "BracketLeft":  return "[";
    case "BracketRight": return "]";
    case "Backslash":    return "\\";
    case "Semicolon":    return ";";
    case "Quote":        return "'";
    case "Comma":        return ",";
    case "Period":       return ".";
    case "Slash":        return "/";
    case "ShiftLeft":    return "L-Shift";
    case "ShiftRight":   return "R-Shift";
    case "ControlLeft":  return "L-Ctrl";
    case "ControlRight": return "R-Ctrl";
    case "AltLeft":      return "L-Alt";
    case "AltRight":     return "R-Alt";
    case "CapsLock":     return "Caps";
    case "Insert":       return "Ins";
    case "Delete":       return "Del";
    case "Home":         return "Home";
    case "End":          return "End";
    case "PageUp":       return "PgUp";
    case "PageDown":     return "PgDn";
    case "NumpadAdd":      return "Num+";
    case "NumpadSubtract": return "Num-";
    case "NumpadMultiply": return "Num*";
    case "NumpadDivide":   return "Num/";
    case "NumpadEnter":    return "NumEnter";
    case "NumpadDecimal":  return "Num.";
    default: return code;
  }
}

/**
 * Return a copy of `bindings` with `(lane, slot)` set to `code`. If
 * `code` is currently bound to any OTHER slot, that other slot is
 * cleared to "" so each non-empty code maps to exactly one lane.
 * Setting `code = ""` is the editor's "unbind this slot" path.
 *
 * Pure / immutable - never mutates the input tuple, safe to use as a
 * `setState` reducer.
 */
export function setKeybind(
  bindings: KeyBindings,
  lane: number,
  slot: 0 | 1,
  code: string,
): KeyBindings {
  const next = bindings.map((pair) => [pair[0], pair[1]]) as [
    [string, string], [string, string], [string, string], [string, string],
  ];
  if (code) {
    for (let l = 0; l < next.length; l++) {
      for (const s of [0, 1] as const) {
        if (next[l][s] === code && (l !== lane || s !== slot)) {
          next[l][s] = "";
        }
      }
    }
  }
  next[lane][slot] = code;
  return next as unknown as KeyBindings;
}

/**
 * Primary lane labels derived from the current bindings. Each lane's
 * primary slot wins; if the primary is empty, the secondary takes
 * over. Both empty -> the historical default letter (D/F/J/K) so the
 * canvas receptor never renders blank. Used by the renderer (via
 * `RenderOptions.laneLabels`), the StartCard `KeyCap` row, and the
 * countdown overlay's keyboard hint.
 */
export function deriveLaneLabels(bindings: KeyBindings): string[] {
  const fallbacks = ["D", "F", "J", "K"];
  return bindings.map((pair, i) => {
    const primary = pair[0] || pair[1];
    return primary ? formatKeyCode(primary) : fallbacks[i];
  });
}

export function loadKeybinds(): KeyBindings {
  if (typeof window === "undefined") return DEFAULT_KEYBINDS;
  try {
    const raw = window.localStorage.getItem(KEYBINDS_KEY);
    if (!raw) return DEFAULT_KEYBINDS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 4) return DEFAULT_KEYBINDS;
    const out: [string, string][] = [];
    for (const lane of parsed) {
      if (!Array.isArray(lane) || lane.length !== 2) return DEFAULT_KEYBINDS;
      const a = typeof lane[0] === "string" ? lane[0] : "";
      const b = typeof lane[1] === "string" ? lane[1] : "";
      out.push([a, b]);
    }
    return out as unknown as KeyBindings;
  } catch {
    return DEFAULT_KEYBINDS;
  }
}

export function saveKeybinds(b: KeyBindings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEYBINDS_KEY, JSON.stringify(b));
  } catch {
    reportStorageFailure();
  }
}
