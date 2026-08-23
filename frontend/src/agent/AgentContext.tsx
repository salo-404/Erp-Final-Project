import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { mockAgentService } from "./agentService";
import type { AgentConversation, AgentMessage, AgentPageContext, AgentStreamStatus } from "../types/agent";

const CONVERSATIONS_KEY = "nexora.agent.conversations";
const ACTIVE_ID_KEY = "nexora.agent.activeConversationId";
const MAX_TITLE_LENGTH = 42;

function readConversations(): AgentConversation[] {
  const raw = localStorage.getItem(CONVERSATIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AgentConversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeConversations(conversations: AgentConversation[]): void {
  localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
}

function readActiveId(): string | null {
  return localStorage.getItem(ACTIVE_ID_KEY);
}

function writeActiveId(id: string | null): void {
  if (id) localStorage.setItem(ACTIVE_ID_KEY, id);
  else localStorage.removeItem(ACTIVE_ID_KEY);
}

function makeTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_TITLE_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd() + "…";
}

interface AgentContextValue {
  conversations: AgentConversation[];
  activeConversationId: string | null;
  activeConversation: AgentConversation | null;
  isSending: boolean;
  streamingStatus: AgentStreamStatus | null;
  streamingText: string;
  isFloatingOpen: boolean;
  openFloating: () => void;
  closeFloating: () => void;
  toggleFloating: () => void;
  newConversation: () => void;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  sendMessage: (text: string, pageContext: AgentPageContext) => Promise<void>;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<AgentConversation[]>(readConversations);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(readActiveId);
  const [isSending, setIsSending] = useState(false);
  const [streamingStatus, setStreamingStatus] = useState<AgentStreamStatus | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [isFloatingOpen, setIsFloatingOpen] = useState(false);

  const setActive = useCallback((id: string | null) => {
    setActiveConversationId(id);
    writeActiveId(id);
  }, []);

  const streamGeneration = useRef(0);

  const newConversation = useCallback(() => {
    setActive(null);
  }, [setActive]);

  const selectConversation = useCallback(
    (id: string) => {
      setActive(id);
    },
    [setActive],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== id);
        writeConversations(next);
        return next;
      });
      setActiveConversationId((prev) => {
        const nextActive = prev === id ? null : prev;
        writeActiveId(nextActive);
        return nextActive;
      });
    },
    [],
  );

  const openFloating = useCallback(() => setIsFloatingOpen(true), []);
  const closeFloating = useCallback(() => setIsFloatingOpen(false), []);
  const toggleFloating = useCallback(() => setIsFloatingOpen((v) => !v), []);

  const sendMessage = useCallback(
    async (text: string, pageContext: AgentPageContext) => {
      const trimmed = text.trim();
      if (!trimmed || isSending) return;

      const generation = ++streamGeneration.current;
      const now = new Date().toISOString();

      const userMessage: AgentMessage = {
        id: crypto.randomUUID(),
        role: "user",
        createdAt: now,
        text: trimmed,
        pageContextLabel: pageContext.label,
      };

      const existing = activeConversationId ? conversations.find((c) => c.id === activeConversationId) ?? null : null;

      const snap: AgentConversation = existing
        ? { ...existing, updatedAt: now, messages: [...existing.messages, userMessage] }
        : { id: crypto.randomUUID(), title: makeTitle(trimmed), createdAt: now, updatedAt: now, messages: [userMessage] };

      const nextConversations = existing
        ? [snap, ...conversations.filter((c) => c.id !== existing.id)]
        : [snap, ...conversations];

      setConversations(nextConversations);
      writeConversations(nextConversations);
      setActive(snap.id);

      setIsSending(true);
      setStreamingStatus("thinking");
      setStreamingText("");

      try {
        for await (const event of mockAgentService.sendMessage({
          conversation: snap,
          userMessage: trimmed,
          pageContext,
        })) {
          if (streamGeneration.current !== generation) return;

          if (event.type === "status") {
            setStreamingStatus(event.status);
          } else if (event.type === "token") {
            setStreamingText((prev) => prev + event.token);
          } else if (event.type === "done") {
            setConversations((prev) => {
              const next = prev.map((c) =>
                c.id === snap.id ? { ...c, updatedAt: new Date().toISOString(), messages: [...c.messages, event.message] } : c,
              );
              writeConversations(next);
              return next;
            });
            setStreamingStatus(null);
            setStreamingText("");
          } else if (event.type === "error") {
            setStreamingStatus(null);
          }
        }
      } finally {
        if (streamGeneration.current === generation) {
          setIsSending(false);
        }
      }
    },
    [activeConversationId, conversations, isSending, setActive],
  );

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

  const value = useMemo<AgentContextValue>(
    () => ({
      conversations,
      activeConversationId,
      activeConversation,
      isSending,
      streamingStatus,
      streamingText,
      isFloatingOpen,
      openFloating,
      closeFloating,
      toggleFloating,
      newConversation,
      selectConversation,
      deleteConversation,
      sendMessage,
    }),
    [
      conversations,
      activeConversationId,
      activeConversation,
      isSending,
      streamingStatus,
      streamingText,
      isFloatingOpen,
      openFloating,
      closeFloating,
      toggleFloating,
      newConversation,
      selectConversation,
      deleteConversation,
      sendMessage,
    ],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent must be used within AgentProvider");
  return ctx;
}
