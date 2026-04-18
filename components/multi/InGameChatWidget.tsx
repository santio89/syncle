"use client";

/**
 * Floating chat widget overlaid on top of the MultiGame canvas during the
 * countdown / playing phases.
 *
 *   - Collapsed by default to a small bottom-right "Chat" pill so it never
 *     blocks gameplay. The pill flashes accent + bumps the unread count
 *     when new messages arrive while collapsed.
 *
 *   - Click the pill (or hit `T` for "talk") to expand into a compact
 *     ChatPanel hovering above the lanes. Click outside, hit Escape, or
 *     hit the close button to collapse again.
 *
 *   - While the input is focused we stop bubbling key events so the
 *     gameplay key handler in MultiGame doesn't think the user is
 *     hammering D/F/J/K.
 *
 * Designed to be a sibling of MultiGame inside a `position:relative`
 * container so it floats over the canvas without participating in the
 * canvas's layout.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { RoomActions } from "@/hooks/useRoomSocket";
import type { ChatMessage } from "@/lib/multi/protocol";

import { ChatPanel } from "./ChatPanel";

export function InGameChatWidget({
  chat,
  meId,
  meIsMuted,
  actions,
}: {
  chat: ChatMessage[];
  meId: string;
  meIsMuted: boolean;
  actions: RoomActions;
}) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const lastSeenIdRef = useRef<number>(
    chat.length ? chat[chat.length - 1].id : -1,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Track unread messages while collapsed. When opened, mark everything
  // as seen and reset the badge.
  useEffect(() => {
    if (chat.length === 0) return;
    const last = chat[chat.length - 1];
    if (open) {
      lastSeenIdRef.current = last.id;
      setUnread(0);
      return;
    }
    if (last.id > lastSeenIdRef.current) {
      // Don't count my own messages as unread — they're not "new" to me.
      const newOnes = chat.filter(
        (m) => m.id > lastSeenIdRef.current && m.authorId !== meId,
      ).length;
      if (newOnes > 0) setUnread((u) => Math.min(99, u + newOnes));
      lastSeenIdRef.current = last.id;
    }
  }, [chat, open, meId]);

  // Global hotkey: T toggles chat. Escape closes it. Both ignore events
  // that originate from any input/textarea/contenteditable so they
  // don't fight with the chat textarea or other form fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (inField) return;
      if (e.key.toLowerCase() === "t" && !e.repeat && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Click-outside collapses the panel — but only when actually open,
  // otherwise we'd be adding a useless global listener every render.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const handlePillClick = useCallback(() => {
    setOpen((v) => !v);
  }, []);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute bottom-4 right-4 z-30 flex flex-col items-end gap-2"
    >
      {open && (
        <div
          // pointer-events-auto only on the panel itself so the rest of
          // the gameplay surface stays click-through.
          className="pointer-events-auto w-[min(92vw,22rem)] animate-fade-in border-2 border-bone-50/20 bg-ink-900/90 shadow-[6px_6px_0_rgb(var(--shadow-base))] backdrop-blur"
          // Stop bubbling key events from any input inside so the
          // gameplay key handler upstairs (D/F/J/K) doesn't treat
          // typing as note hits. Capture phase ensures we run before
          // the window-level handler in MultiGame.
          onKeyDownCapture={(e) => {
            // Only swallow non-modifier "lane" keys when typing.
            const target = e.target as HTMLElement | null;
            const inField =
              target &&
              (target.tagName === "INPUT" ||
                target.tagName === "TEXTAREA" ||
                target.isContentEditable);
            if (!inField) return;
            const k = e.key.toLowerCase();
            if (
              ["d", "f", "j", "k", "arrowleft", "arrowright", "arrowup", "arrowdown"].includes(k)
            ) {
              e.stopPropagation();
            }
          }}
        >
          <div className="flex items-center justify-between gap-2 border-b-2 border-bone-50/15 px-3 py-1.5">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
              ░ Chat
            </span>
            <button
              onClick={() => setOpen(false)}
              className="font-mono text-[10.5px] uppercase tracking-widest text-bone-50/55 hover:text-accent transition-colors"
              aria-label="Close chat"
              title="Close (Esc)"
            >
              ✕ close
            </button>
          </div>
          <div className="p-3">
            <ChatPanel
              chat={chat}
              meId={meId}
              meIsMuted={meIsMuted}
              onSend={actions.sendChat}
              variant="embedded"
              maxHeight={200}
            />
          </div>
        </div>
      )}

      {!open && (
        <button
          type="button"
          onClick={handlePillClick}
          // Pointer events only on the pill itself; the wrapper stays
          // click-through so gameplay around it isn't blocked.
          className={`pointer-events-auto group inline-flex items-center gap-2 border-2 px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-widest backdrop-blur transition-all ${
            unread > 0
              ? "border-accent bg-accent/15 text-accent shadow-[4px_4px_0_rgb(var(--shadow-accent))] animate-pulse"
              : "border-bone-50/30 bg-ink-900/70 text-bone-50/80 hover:border-accent hover:text-accent"
          }`}
          aria-label={
            unread > 0 ? `Open chat (${unread} unread)` : "Open chat"
          }
          title="Open chat (T)"
        >
          <ChatBubbleIcon />
          <span>Chat</span>
          {unread > 0 && (
            <span className="ml-1 inline-flex min-w-[1.1rem] items-center justify-center border-2 border-accent bg-accent px-1 text-[10px] leading-none text-ink-900">
              {unread}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

function ChatBubbleIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="square"
      aria-hidden
    >
      <path d="M1.5 2h9v6.5H4.5L2 10.5V8.5H1.5z" />
    </svg>
  );
}
