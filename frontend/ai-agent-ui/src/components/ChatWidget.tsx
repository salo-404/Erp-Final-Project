import { useState, type FormEvent } from "react";
import type { ChatMessage } from "../types";

interface ChatWidgetProps {
  messages: ChatMessage[];
  onSend: (content: string) => void;
}

/**
 * Chat interface for the Supervisor agent. Purely presentational: it holds
 * only local input-box state, never calls anything itself - the parent
 * owns `messages` and receives new user text via `onSend`, then is
 * responsible for actually calling the Supervisor (e.g. POST to
 * agentcore_entrypoint.py's /invocations with {"prompt": content}) and
 * appending both the user turn and the {"role": "supervisor", ...} reply.
 */
export function ChatWidget({ messages, onSend }: ChatWidgetProps) {
  const [draft, setDraft] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setDraft("");
  }

  return (
    <div className="flex h-[32rem] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Supervisor
        </h2>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400 dark:text-slate-500">
            Ask about inventory, orders, invoices, or suppliers.
          </p>
        )}
        {messages.map((message, index) => (
          <div
            key={index}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm leading-relaxed ${
                message.role === "user"
                  ? "rounded-br-sm bg-indigo-600 text-white"
                  : "rounded-bl-sm bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100"
              }`}
            >
              {message.content}
            </div>
          </div>
        ))}
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 border-t border-slate-200 px-3 py-3 dark:border-slate-700"
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type a message..."
          className="flex-1 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
