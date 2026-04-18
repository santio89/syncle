"use client";

/**
 * Live chat panel used in the lobby / loading / results phases of a
 * multiplayer room. Self-contained: feeds off the `chat` array surfaced
 * by `useRoomSocket`, fires `actions.sendChat` on submit, and shows the
 * mute state inline so a silenced player understands why their messages
 * aren't appearing.
 *
 * UX choices:
 *
 *   - Auto-scroll to the bottom on new message UNLESS the user has
 *     scrolled up (i.e. they're reading history). The bottom-distance
 *     threshold is generous (32 px) so the natural "lock to live" feel
 *     survives a quick wheel-flick over a recent message.
 *
 *   - Submit on Enter, Shift+Enter inserts newline. Mirrors Discord /
 *     Slack so the muscle memory transfers.
 *
 *   - System messages (kicks, mutes, "X is now host") render inline in
 *     the chat stream as a centered, uppercase, dimmer pill so the
 *     room narrative lives in one place instead of being scattered
 *     across notices + chat.
 *
 *   - Empty state: "Be the first to say something." Friendlier than a
 *     blank panel, and tells the user the input actually works without
 *     needing to test it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChatMessage } from "@/lib/multi/protocol";
import { CHAT_MAX_LEN } from "@/lib/multi/protocol";

export function ChatPanel({
  chat,
  meId,
  meIsMuted,
  onSend,
  className = "",
  /**
   * Visual variant:
   *   - "card"     → standard brut-card surface (lobby / results)
   *   - "embedded" → no outer card; assume parent already provides it
   *                  (e.g. a sidebar inside the loading screen)
   */
  variant = "card",
  /** Optional max-height override for the message scroller. */
  maxHeight,
}: {
  chat: ChatMessage[];
  meId: string;
  meIsMuted: boolean;
  onSend: (text: string) => void;
  className?: string;
  variant?: "card" | "embedded";
  maxHeight?: number;
}) {
  const [draft, setDraft] = useState("");
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user has scrolled up away from the bottom. We
  // pause auto-scroll while they're reading history so a chatty room
  // doesn't yank the viewport away from the message they're reading.
  const stuckBottomRef = useRef(true);

  // Auto-scroll to the bottom on new message (when stuck-bottom).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (!stuckBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [chat]);

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    stuckBottomRef.current = distanceFromBottom <= 32;
  }, []);

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const text = draft.trim();
      if (!text) return;
      if (meIsMuted) return;
      onSend(text);
      setDraft("");
      // Sending a message snaps us back to live, even if we'd been
      // reading history — most chat apps behave the same way and it's
      // the obvious user intent (you spoke; you want to see the reply).
      stuckBottomRef.current = true;
    },
    [draft, meIsMuted, onSend],
  );

  // Group consecutive messages from the same author into a single bubble
  // so a chatty player's 4-message burst doesn't render 4 names + 4
  // timestamps. Cuts visual noise considerably without losing info.
  const grouped = useMemo(() => {
    type Group = {
      authorId: string;
      authorName: string;
      kind: ChatMessage["kind"];
      first: ChatMessage;
      messages: ChatMessage[];
    };
    const out: Group[] = [];
    for (const m of chat) {
      const last = out[out.length - 1];
      if (
        last &&
        last.authorId === m.authorId &&
        last.kind === m.kind &&
        m.at - last.first.at < 60_000 // 1-min coalescing window
      ) {
        last.messages.push(m);
      } else {
        out.push({
          authorId: m.authorId,
          authorName: m.authorName,
          kind: m.kind,
          first: m,
          messages: [m],
        });
      }
    }
    return out;
  }, [chat]);

  const wrapperClass =
    variant === "card"
      ? "brut-card flex h-full flex-col p-5 sm:p-6"
      : "flex h-full flex-col";

  return (
    <div className={`${wrapperClass} ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.4em] text-accent">
          ░ Chat
        </p>
        <span className="font-mono text-[9.5px] uppercase tracking-widest text-bone-50/40">
          {chat.length === 0 ? "—" : `${chat.length} ${chat.length === 1 ? "msg" : "msgs"}`}
        </span>
      </div>

      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className="mt-3 flex-1 min-h-[8rem] overflow-y-auto pr-1"
        style={maxHeight ? { maxHeight } : undefined}
      >
        {grouped.length === 0 ? (
          <p className="py-6 text-center font-mono text-[11.5px] uppercase tracking-widest text-bone-50/35">
            Be the first to say something.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {grouped.map((g) => (
              <li key={g.first.id}>
                {g.kind === "system" ? (
                  <SystemRow text={g.messages.map((m) => m.text).join(" · ")} />
                ) : (
                  <MessageGroup
                    g={g}
                    isMe={g.authorId === meId}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {meIsMuted && (
        <p className="mt-2 border-2 border-rose-500/60 px-2 py-1 text-center font-mono text-[10.5px] uppercase tracking-widest text-rose-400">
          You were muted by the host
        </p>
      )}

      <form
        onSubmit={handleSubmit}
        className="mt-3 flex items-end gap-2 border-t-2 border-bone-50/10 pt-3"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, CHAT_MAX_LEN))}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline so multi-line
            // chat is still possible if someone really wants it.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          rows={1}
          maxLength={CHAT_MAX_LEN}
          placeholder={meIsMuted ? "Muted." : "Say something…"}
          disabled={meIsMuted}
          className="flex-1 resize-none border-2 border-bone-50/20 bg-transparent px-2 py-1.5 font-mono text-[0.86rem] text-bone-50 outline-none focus:border-accent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={meIsMuted || !draft.trim()}
          className="brut-btn-accent shrink-0 px-3 py-1.5 font-mono text-[0.79rem] uppercase tracking-widest disabled:opacity-40"
          data-tooltip="Send (Enter)"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function MessageGroup({
  g,
  isMe,
}: {
  g: {
    authorId: string;
    authorName: string;
    first: ChatMessage;
    messages: ChatMessage[];
  };
  isMe: boolean;
}) {
  return (
    <div
      className={`border-l-2 px-2 ${
        isMe ? "border-accent" : "border-bone-50/15"
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span
          className={`truncate font-mono text-[10.5px] uppercase tracking-widest ${
            isMe ? "text-accent" : "text-bone-50/70"
          }`}
        >
          {g.authorName}
          {isMe && <span className="ml-1 text-bone-50/40">(you)</span>}
        </span>
        <RelativeTime at={g.first.at} />
      </div>
      <div className="mt-0.5 space-y-0.5">
        {g.messages.map((m) => (
          <p
            key={m.id}
            className="whitespace-pre-wrap break-words font-mono text-[0.86rem] leading-snug text-bone-50/95"
          >
            {m.text}
          </p>
        ))}
      </div>
    </div>
  );
}

function SystemRow({ text }: { text: string }) {
  return (
    <p className="text-center font-mono text-[10.5px] uppercase tracking-widest text-bone-50/40">
      ░ {text}
    </p>
  );
}

function RelativeTime({ at }: { at: number }) {
  // Re-rendered by parent on every chat tick; cheap to recompute. We
  // don't bother with a per-second updater because chat panels see
  // enough re-renders to keep "x seconds ago" feeling fresh.
  const label = useMemo(() => formatRelative(at), [at]);
  return (
    <span
      className="font-mono text-[9.5px] uppercase tracking-widest text-bone-50/35"
      data-tooltip={new Date(at).toLocaleString()}
    >
      {label}
    </span>
  );
}

function formatRelative(at: number): string {
  const diff = Date.now() - at;
  if (diff < 5_000) return "now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(at).toLocaleDateString();
}
