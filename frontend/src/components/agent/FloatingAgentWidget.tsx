import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAgent } from "../../agent/AgentContext";
import { usePageContext } from "../../agent/pageContext";
import agentLogo from "../../assets/ai-agent-logo.png";
import { CloseIcon, ExpandIcon, MinusIcon } from "../ui/icons";
import { AgentMark } from "./AgentMark";
import { ConversationView } from "./ConversationView";
import { QuickActionChips } from "./QuickActionChips";
import { Composer } from "./Composer";
import { ErrorMessage } from "../ui/ErrorMessage";

export function FloatingAgentWidget() {
  const navigate = useNavigate();
  const pageContext = usePageContext();
  const {
    activeConversation,
    isSending,
    streamingStatus,
    streamingText,
    agentError,
    isFloatingOpen,
    closeFloating,
    toggleFloating,
    sendMessage,
  } = useAgent();

  // Closing (not just hiding) the panel here means it doesn't silently
  // reappear on the next page if the user reached /ai-agent via the
  // sidebar link rather than "Open Full Agent" (which already closes it).
  useEffect(() => {
    if (pageContext.path.startsWith("/ai-agent")) {
      closeFloating();
    }
  }, [pageContext.path, closeFloating]);

  if (pageContext.path.startsWith("/ai-agent")) return null;

  const messages = activeConversation?.messages ?? [];
  const hasMessages = messages.length > 0 || streamingStatus !== null;

  function handleSend(text: string) {
    void sendMessage(text, pageContext);
  }

  function handleOpenFull() {
    closeFloating();
    navigate("/ai-agent");
  }

  return (
    <>
      {isFloatingOpen && (
        <div
          role="dialog"
          aria-label="AI Assistant"
          style={{
            position: "fixed",
            bottom: 92,
            right: 24,
            width: 380,
            maxWidth: "calc(100vw - 32px)",
            height: 560,
            maxHeight: "calc(100vh - 140px)",
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: 16,
            boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            zIndex: 1000,
            animation: "agent-panel-in 0.18s ease-out",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 14px",
              borderBottom: "1px solid var(--color-border)",
              background: "var(--color-surface)",
              flexShrink: 0,
            }}
          >
            <AgentMark size={30} ring />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--font-heading)", color: "var(--color-text)" }}>
                Nexora Assistant
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 1 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--color-accent)",
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 20,
                    padding: "1px 7px",
                  }}
                >
                  {pageContext.label}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleOpenFull}
              aria-label="Open full agent"
              title="Open full agent"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: 6, border: "none", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}
            >
              <ExpandIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={closeFloating}
              aria-label="Close assistant"
              title="Close"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: 6, border: "none", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
            {!hasMessages ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <AgentMark size={24} />
                  <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "3px 12px 12px 12px", padding: "10px 12px", fontSize: 12.5, color: "var(--color-text)", lineHeight: 1.5 }}>
                    Hi, I'm your Nexora assistant. I can help you make sense of what's happening on the{" "}
                    <strong>{pageContext.label}</strong> page — ask me anything.
                  </div>
                </div>
                <QuickActionChips actions={pageContext.quickActions} onSelect={handleSend} disabled={isSending} />
              </div>
            ) : (
              <ConversationView messages={messages} streamingStatus={streamingStatus} streamingText={streamingText} compact />
            )}
          </div>

          {/* Composer */}
          <div style={{ padding: 12, borderTop: "1px solid var(--color-border)", background: "var(--color-surface)", flexShrink: 0 }}>
            {agentError && (
              <div style={{ marginBottom: 10 }}>
                <ErrorMessage message={agentError} />
              </div>
            )}
            <Composer onSend={handleSend} disabled={isSending} placeholder="Ask about this page..." />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={toggleFloating}
        aria-label={isFloatingOpen ? "Minimize assistant" : "Open assistant"}
        title="Nexora Assistant"
        className="agent-float-button"
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          width: 60,
          height: 60,
          borderRadius: 16,
          padding: 0,
          border: "none",
          boxShadow: "0 8px 22px rgba(0,0,0,0.32)",
          cursor: "pointer",
          zIndex: 1001,
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: 16,
            overflow: "hidden",
            border: isFloatingOpen ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
          }}
        >
          <img src={agentLogo} alt="Nexora AI Agent" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", pointerEvents: "none" }} />
        </div>
        {isFloatingOpen && (
          <span
            style={{
              position: "absolute",
              bottom: -2,
              right: -2,
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "var(--color-accent)",
              border: "2px solid var(--color-bg)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <MinusIcon style={{ width: 10, height: 10, color: "var(--color-on-accent)" }} />
          </span>
        )}
      </button>
    </>
  );
}
