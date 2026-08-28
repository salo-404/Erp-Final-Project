import { useState, type FormEvent } from "react";
import type { MockChatMessage } from "../types";

const INITIAL_MESSAGES: MockChatMessage[] = [
  {
    role: "supervisor",
    content: "Ask me about inventory, orders, invoices, or suppliers.",
  },
];

/**
 * Floating chat button + slide-in panel. Visually modeled after
 * ai-agent-ui/src/components/ChatWidget.tsx (bubble layout, indigo accent)
 * but deliberately a separate, self-contained component - this mockup does
 * not import across the ai-agent-ui/ and erp-frontend-mockup/ folders.
 *
 * MERGE-AI: onSend below only appends a canned local reply. Replace with a
 * real call to the Supervisor (see ai-agent/agentcore_entrypoint.py's
 * POST /invocations, {"prompt": string} in / {"result": string} out), and
 * consider swapping this component entirely for ai-agent-ui's real
 * ChatWidget once these two folders are merged.
 */
export function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<MockChatMessage[]>(INITIAL_MESSAGES);
  const [draft, setDraft] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    setMessages((prev) => [
      ...prev,
      { role: "user", content: trimmed },
      {
        role: "supervisor",
        content: "(mock reply - not a real Supervisor call, see the MERGE-AI comment in ChatPanel.tsx)",
      },
    ]);
    setDraft("");
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open chat"
        className={`fixed right-6 bottom-6 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-2xl text-white shadow-lg transition hover:bg-indigo-500 ${
          open ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        💬
      </button>

      <div
        className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-sm transform flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">Supervisor</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close chat"
            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.map((message, index) => (
            <div
              key={index}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm leading-relaxed ${
                  message.role === "user"
                    ? "rounded-br-sm bg-indigo-600 text-white"
                    : "rounded-bl-sm bg-zinc-800 text-zinc-100"
                }`}
              >
                {message.content}
              </div>
            </div>
          ))}
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-2 border-t border-zinc-800 px-3 py-3"
        >
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Type a message..."
            className="flex-1 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}
    </>
  );
}
