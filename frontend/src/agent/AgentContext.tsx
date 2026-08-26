import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { agentCoreService } from "./agentCoreService";
import { useAuth } from "../auth/AuthContext";
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
  agentError: string | null;
  isFloatingOpen: boolean;
  openFloating: () => void;
  closeFloating: () => void;
  toggleFloating: () => void;
  newConversation: () => void;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  sendMessage: (text: string, pageContext: AgentPageContext) => Promise<void>;
  composerDraft: string;
  setComposerDraft: (text: string) => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function AgentProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<AgentConversation[]>(readConversations);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(readActiveId);
  // Keyed by conversation id so a response still streaming in one conversation
  // never bleeds into whichever conversation the user is currently looking at
  // (e.g. after opening a new chat while the previous one is still "thinking").
  const [pendingByConversation, setPendingByConversation] = useState<
    Record<string, { status: AgentStreamStatus | null; text: string }>
  >({});
  const [errorByConversation, setErrorByConversation] = useState<Record<string, string>>({});
  const [isFloatingOpen, setIsFloatingOpen] = useState(false);
  // Lives here (not inside Composer's own state) specifically so it
  // survives navigating away from /ai-agent and back - the page unmounts
  // and remounts Composer on route change, which would otherwise wipe an
  // unsent draft.
  const [composerDraft, setComposerDraft] = useState("");

  const setActive = useCallback((id: string | null) => {
    setActiveConversationId(id);
    writeActiveId(id);
  }, []);

  const streamGeneration = useRef(0);
  const generationByConversation = useRef<Map<string, number>>(new Map());
  // Guards against sending a second message into a conversation that's
  // already mid-response. Kept as a ref (not state) so it doesn't force
  // sendMessage to be recreated on every streamed token.
  const pendingIds = useRef<Set<string>>(new Set());

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

  const renameConversation = useCallback((id: string, title: string) => {
    const nextTitle = makeTitle(title);
    if (!nextTitle) return;
    setConversations((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, title: nextTitle } : c));
      writeConversations(next);
      return next;
    });
  }, []);

  const openFloating = useCallback(() => setIsFloatingOpen(true), []);
  const closeFloating = useCallback(() => setIsFloatingOpen(false), []);
  const toggleFloating = useCallback(() => setIsFloatingOpen((v) => !v), []);

  const sendMessage = useCallback(
    async (text: string, pageContext: AgentPageContext) => {
      const trimmed = text.trim();
      if (!trimmed || !user) return;

      const existing = activeConversationId ? conversations.find((c) => c.id === activeConversationId) ?? null : null;
      const targetId = existing ? existing.id : crypto.randomUUID();

      // Already streaming a response into this exact conversation - ignore
      // the duplicate send. A different (e.g. brand-new) conversation is
      // free to send concurrently; its own targetId won't collide with this.
      if (pendingIds.current.has(targetId)) return;
      pendingIds.current.add(targetId);

      const generation = ++streamGeneration.current;
      generationByConversation.current.set(targetId, generation);
      const now = new Date().toISOString();

      const userMessage: AgentMessage = {
        id: crypto.randomUUID(),
        role: "user",
        createdAt: now,
        text: trimmed,
        pageContextLabel: pageContext.label,
      };

      const snap: AgentConversation = existing
        ? { ...existing, updatedAt: now, messages: [...existing.messages, userMessage] }
        : { id: targetId, title: makeTitle(trimmed), createdAt: now, updatedAt: now, messages: [userMessage] };

      const nextConversations = existing
        ? [snap, ...conversations.filter((c) => c.id !== existing.id)]
        : [snap, ...conversations];

      setConversations(nextConversations);
      writeConversations(nextConversations);
      setActive(snap.id);

      setPendingByConversation((prev) => ({ ...prev, [targetId]: { status: "Thinking...", text: "" } }));
      setErrorByConversation((prev) => {
        if (!(targetId in prev)) return prev;
        const next = { ...prev };
        delete next[targetId];
        return next;
      });

      const isStale = () => generationByConversation.current.get(targetId) !== generation;
      const clearPending = () =>
        setPendingByConversation((prev) => {
          if (!(targetId in prev)) return prev;
          const next = { ...prev };
          delete next[targetId];
          return next;
        });

      try {
        for await (const event of agentCoreService.sendMessage({
          conversation: snap,
          userMessage: trimmed,
          pageContext,
          userId: user.id,
        })) {
          if (isStale()) return;

          if (event.type === "status") {
            setPendingByConversation((prev) => ({ ...prev, [targetId]: { status: event.status, text: prev[targetId]?.text ?? "" } }));
          } else if (event.type === "reset") {
            // The service layer abandoned a partial answer to start a
            // fresh tool-calling round — see agent/agentCoreService.ts's
            // own comment on why. Discard the accumulated text so the
            // typewriter doesn't append the old draft in front of the
            // real final answer.
            setPendingByConversation((prev) => ({ ...prev, [targetId]: { status: prev[targetId]?.status ?? null, text: "" } }));
          } else if (event.type === "token") {
            setPendingByConversation((prev) => ({
              ...prev,
              [targetId]: { status: prev[targetId]?.status ?? null, text: (prev[targetId]?.text ?? "") + event.token },
            }));
          } else if (event.type === "done") {
            setConversations((prev) => {
              const next = prev.map((c) =>
                c.id === targetId ? { ...c, updatedAt: new Date().toISOString(), messages: [...c.messages, event.message] } : c,
              );
              writeConversations(next);
              return next;
            });
            clearPending();
          } else if (event.type === "error") {
            clearPending();
            setErrorByConversation((prev) => ({ ...prev, [targetId]: event.error }));
          }
        }
      } catch (err) {
        if (!isStale()) {
          clearPending();
          setErrorByConversation((prev) => ({
            ...prev,
            [targetId]: err instanceof Error ? err.message : "The assistant hit an unexpected error.",
          }));
        }
      } finally {
        pendingIds.current.delete(targetId);
      }
    },
    [activeConversationId, conversations, setActive, user],
  );

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

  const activePending = activeConversationId ? pendingByConversation[activeConversationId] : undefined;
  const isSending = activePending !== undefined;
  const streamingStatus = activePending?.status ?? null;
  const streamingText = activePending?.text ?? "";
  const agentError = activeConversationId ? errorByConversation[activeConversationId] ?? null : null;

  const value = useMemo<AgentContextValue>(
    () => ({
      conversations,
      activeConversationId,
      activeConversation,
      isSending,
      streamingStatus,
      streamingText,
      agentError,
      isFloatingOpen,
      openFloating,
      closeFloating,
      toggleFloating,
      newConversation,
      selectConversation,
      deleteConversation,
      renameConversation,
      sendMessage,
      composerDraft,
      setComposerDraft,
    }),
    [
      conversations,
      activeConversationId,
      activeConversation,
      isSending,
      streamingStatus,
      streamingText,
      agentError,
      isFloatingOpen,
      openFloating,
      closeFloating,
      toggleFloating,
      newConversation,
      selectConversation,
      deleteConversation,
      renameConversation,
      sendMessage,
      composerDraft,
    ],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent must be used within AgentProvider");
  return ctx;
}
