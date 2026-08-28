import { useEffect, useRef, useState } from "react";
import type { ComponentType, SVGProps } from "react";
import { useAgent } from "../agent/AgentContext";
import { resolvePageContext } from "../agent/pageContext";
import {
  ChevronDownIcon,
  ControlTowerIcon,
  EditIcon,
  InventoryIcon,
  PlusIcon,
  SuppliersIcon,
  TransactionsIcon,
  TrashIcon,
  WarehouseIcon,
} from "../components/ui/icons";
import { AgentMark } from "../components/agent/AgentMark";
import { ConversationView } from "../components/agent/ConversationView";
import { Composer } from "../components/agent/Composer";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { ErrorMessage } from "../components/ui/ErrorMessage";

const WORKSPACE_CONTEXT = resolvePageContext("/ai-agent");

interface SuggestedPrompt {
  id: string;
  label: string;
  prompt: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: "accent" | "success" | "warning" | "danger";
}

const SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  { id: "sum-priorities", label: "Summarize today's priorities", prompt: "Summarize today's priorities across the ERP.", Icon: ControlTowerIcon, tone: "accent" },
  { id: "attn", label: "What needs attention?", prompt: "What needs attention across the ERP right now?", Icon: ControlTowerIcon, tone: "danger" },
  { id: "inv-analyze", label: "Analyze inventory levels", prompt: "Analyze current inventory levels.", Icon: InventoryIcon, tone: "success" },
  { id: "sup-perf", label: "Explain supplier performance", prompt: "Explain how supplier performance is trending.", Icon: SuppliersIcon, tone: "warning" },
  { id: "wh-capacity", label: "Find warehouse capacity issues", prompt: "Find capacity issues across warehouses.", Icon: WarehouseIcon, tone: "accent" },
  { id: "ord-trends", label: "Summarize order trends", prompt: "Summarize recent customer order trends.", Icon: TransactionsIcon, tone: "success" },
];

const TONE_COLOR: Record<SuggestedPrompt["tone"], string> = {
  accent: "var(--color-accent)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function AiAgentPage() {
  const {
    conversations,
    activeConversation,
    activeConversationId,
    isSending,
    streamingStatus,
    streamingText,
    agentError,
    newConversation,
    selectConversation,
    deleteConversation,
    renameConversation,
    sendMessage,
    composerDraft,
    setComposerDraft,
  } = useAgent();

  const scrollRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showScrollButton, setShowScrollButton] = useState(false);

  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  function startRenaming(id: string, currentTitle: string) {
    setRenamingId(id);
    setRenameValue(currentTitle);
  }

  function commitRename() {
    if (renamingId) renameConversation(renamingId, renameValue);
    setRenamingId(null);
  }

  function cancelRenaming() {
    setRenamingId(null);
  }

  const messages = activeConversation?.messages ?? [];
  const hasMessages = messages.length > 0 || streamingStatus !== null;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, streamingText, streamingStatus]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function handleScroll() {
      if (!el) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollButton(distanceFromBottom > 120);
    }
    el.addEventListener("scroll", handleScroll);
    handleScroll();
    return () => el.removeEventListener("scroll", handleScroll);
  }, [hasMessages]);

  function scrollToBottom() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }

  function handleSend(text: string) {
    void sendMessage(text, WORKSPACE_CONTEXT);
  }

  return (
    <div style={{ display: "flex", height: "100%", gap: 16 }}>
      {/* Conversation history sidebar */}
      <div
        style={{
          width: 264,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 14px 12px" }}>
          <AgentMark size={30} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--font-heading)", color: "var(--color-text)" }}>Nexora AI</div>
            <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>Agent workspace</div>
          </div>
        </div>

        <div style={{ padding: "0 12px 12px" }}>
          <button
            type="button"
            onClick={newConversation}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              fontSize: 12.5,
              fontWeight: 600,
              padding: "9px 12px",
              borderRadius: 9,
              background: "var(--color-accent)",
              color: "var(--color-on-accent)",
              border: "none",
              cursor: "pointer",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2)",
            }}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            New Chat
          </button>
        </div>

        <div style={{ padding: "0 14px 6px", fontSize: 10.5, fontWeight: 700, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Recent
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
          {conversations.length === 0 ? (
            <p style={{ fontSize: 11.5, color: "var(--color-text-muted)", padding: "4px 6px" }}>No conversations yet. Start one below.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {conversations.map((conv) => {
                const isActive = conv.id === activeConversationId;
                const isRenaming = renamingId === conv.id;
                return (
                  <div
                    key={conv.id}
                    onClick={() => !isRenaming && selectConversation(conv.id)}
                    className={isRenaming ? undefined : "agent-conversation-row"}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "8px 10px",
                      borderRadius: 8,
                      cursor: isRenaming ? "default" : "pointer",
                      background: isActive ? "var(--color-surface-2)" : "transparent",
                      borderLeft: isActive ? "2px solid var(--color-accent)" : "2px solid transparent",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {isRenaming ? (
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRename();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelRenaming();
                            }
                          }}
                          style={{
                            width: "100%",
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: "var(--color-text)",
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-accent)",
                            borderRadius: 5,
                            padding: "2px 5px",
                            outline: "none",
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: isActive ? 600 : 500,
                            color: "var(--color-text)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {conv.title}
                        </div>
                      )}
                      <div style={{ fontSize: 10.5, color: "var(--color-text-muted)", marginTop: 1 }}>{timeAgo(conv.updatedAt)}</div>
                    </div>
                    {!isRenaming && (
                      <div className="agent-conversation-actions" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRenaming(conv.id, conv.title);
                          }}
                          aria-label="Rename conversation"
                          title="Rename"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            borderRadius: 6,
                            border: "none",
                            background: "transparent",
                            color: "var(--color-text-muted)",
                            cursor: "pointer",
                          }}
                        >
                          <EditIcon className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmingDeleteId(conv.id);
                          }}
                          aria-label="Delete conversation"
                          title="Delete"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            borderRadius: 6,
                            border: "none",
                            background: "transparent",
                            color: "var(--color-text-muted)",
                            cursor: "pointer",
                          }}
                        >
                          <TrashIcon className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Main workspace */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "14px 20px", borderBottom: "1px solid var(--color-border)" }}>
          <AgentMark size={36} ring />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--font-heading)", color: "var(--color-text)" }}>Nexora Assistant</div>
            <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>ERP intelligence workspace</div>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div ref={scrollRef} style={{ height: "100%", overflowY: "auto", padding: 20 }}>
          {!hasMessages ? (
            <div style={{ position: "relative", maxWidth: 660, margin: "24px auto 0" }}>
              {/* Decorative ambient glow, theme- and accent-aware via opacity only */}
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  top: -40,
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: 340,
                  height: 340,
                  borderRadius: "50%",
                  background: "var(--color-accent)",
                  opacity: 0.12,
                  filter: "blur(60px)",
                  animation: "agent-glow-drift 7s ease-in-out infinite",
                  pointerEvents: "none",
                }}
              />

              <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 18, textAlign: "center" }}>
                <AgentMark size={132} />

                <div>
                  <div style={{ fontSize: 19, fontWeight: 700, fontFamily: "var(--font-heading)", color: "var(--color-text)" }}>
                    How can I help with your ERP today?
                  </div>
                  <p style={{ fontSize: 12.5, color: "var(--color-text-muted)", marginTop: 6, lineHeight: 1.5, maxWidth: 420 }}>
                    Ask about inventory, warehouses, suppliers, orders, or anything else across Nexora.
                  </p>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, width: "100%", textAlign: "left" }}>
                  {SUGGESTED_PROMPTS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleSend(s.prompt)}
                      className="agent-suggestion-card"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        textAlign: "left",
                        fontSize: 12.5,
                        fontWeight: 500,
                        padding: "12px 14px",
                        borderRadius: 12,
                        background: "var(--color-surface-2)",
                        border: "1px solid var(--color-border)",
                        color: "var(--color-text)",
                        cursor: "pointer",
                      }}
                    >
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          background: "var(--color-surface)",
                          border: `1px solid ${TONE_COLOR[s.tone]}`,
                          flexShrink: 0,
                        }}
                      >
                        <s.Icon style={{ width: 14, height: 14, color: TONE_COLOR[s.tone] }} />
                      </span>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <ConversationView messages={messages} streamingStatus={streamingStatus} streamingText={streamingText} />
          )}
        </div>

        {showScrollButton && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Scroll to latest message"
            title="Scroll to latest message"
            style={{
              position: "absolute",
              bottom: 14,
              left: "50%",
              transform: "translateX(-50%)",
              width: 34,
              height: 34,
              borderRadius: "50%",
              border: "1px solid var(--color-border)",
              background: "var(--color-surface)",
              color: "var(--color-text-secondary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            }}
          >
            <ChevronDownIcon className="h-4 w-4" />
          </button>
        )}
        </div>

        <div style={{ padding: 16, borderTop: "1px solid var(--color-border)" }}>
          {agentError && (
            <div style={{ marginBottom: 10 }}>
              <ErrorMessage message={agentError} />
            </div>
          )}
          <Composer value={composerDraft} onChange={setComposerDraft} onSend={handleSend} disabled={isSending} placeholder="Ask the Nexora assistant anything..." large />
        </div>
      </div>

      {confirmingDeleteId && (
        <ConfirmDialog
          title="Delete Conversation"
          message="Delete this conversation? This cannot be undone."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmingDeleteId(null)}
          onConfirm={async () => {
            deleteConversation(confirmingDeleteId);
            setConfirmingDeleteId(null);
          }}
        />
      )}
    </div>
  );
}
