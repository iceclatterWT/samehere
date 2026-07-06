"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import MessageThread from "@/components/messages/MessageThread";
import type { DmMessage } from "@/lib/messages";

// Client wrapper that makes an open thread live. Seeds from the server-rendered
// messages, then subscribes to Realtime INSERTs on this conversation so a new
// message shows without a refresh. Realtime respects RLS, so a subscriber only
// receives rows in conversations they're already allowed to read.
//
// Requires `messages` to be in the `supabase_realtime` publication — see
// supabase/migrations/*_messages_realtime.sql.
export default function MessageThreadLive({
  conversationId,
  initialMessages,
  viewerId,
}: {
  conversationId: string;
  initialMessages: DmMessage[];
  viewerId: string;
}) {
  const [messages, setMessages] = useState<DmMessage[]>(initialMessages);
  const [supabase] = useState(createClient);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Merge revalidated server messages (e.g. after the viewer sends) so the
  // sender's own message is never missed if the Realtime event races the
  // server-action refresh. Dedupe by id keeps this idempotent.
  useEffect(() => {
    setMessages((prev) => mergeById(prev, initialMessages));
  }, [initialMessages]);

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    (async () => {
      // postgres_changes on an RLS-protected table only delivers rows the socket
      // is authorized to read, so the realtime connection must carry the user's
      // JWT — not the anon key. Set it explicitly before subscribing to avoid a
      // race where the socket joins before the cookie session has hydrated
      // (which silently yields zero events).
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session?.access_token) supabase.realtime.setAuth(session.access_token);

      channel = supabase
        .channel(`dm:${conversationId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            filter: `conversation_id=eq.${conversationId}`,
          },
          (payload) => {
            const m = payload.new as {
              id: string;
              sender_id: string;
              content: string;
              created_at: string;
            };
            setMessages((prev) =>
              prev.some((x) => x.id === m.id)
                ? prev
                : [...prev, { id: m.id, sender_id: m.sender_id, content: m.content, created_at: m.created_at, sender: null }],
            );
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [supabase, conversationId]);

  // Scroll to newest whenever the count changes (initial load or a live message).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages.length]);

  return (
    <>
      <MessageThread messages={messages} viewerId={viewerId} />
      <div ref={bottomRef} aria-hidden className="h-px shrink-0" />
    </>
  );
}

// Append any messages from `incoming` not already present, sorted by created_at.
function mergeById(current: DmMessage[], incoming: DmMessage[]): DmMessage[] {
  const seen = new Set(current.map((m) => m.id));
  const added = incoming.filter((m) => !seen.has(m.id));
  if (added.length === 0) return current;
  return [...current, ...added].sort((a, b) => a.created_at.localeCompare(b.created_at));
}
