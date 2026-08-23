import { useState, type KeyboardEvent } from "react";
import { SendIcon } from "../ui/icons";

interface ComposerProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  large?: boolean;
}

export function Composer({ onSend, disabled, placeholder = "Ask about your ERP data...", large }: ComposerProps) {
  const [value, setValue] = useState("");

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <div
      className="agent-composer"
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 8,
        border: "1px solid var(--color-border)",
        borderRadius: large ? 14 : 10,
        background: "var(--color-surface)",
        padding: large ? "10px 10px 10px 16px" : "8px 8px 8px 12px",
      }}
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={large ? 2 : 1}
        disabled={disabled}
        style={{
          flex: 1,
          border: "none",
          outline: "none",
          resize: "none",
          background: "transparent",
          color: "var(--color-text)",
          fontFamily: "var(--font-body)",
          fontSize: large ? 14 : 13,
          lineHeight: 1.5,
          maxHeight: large ? 140 : 90,
        }}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!canSend}
        aria-label="Send message"
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: large ? 38 : 32,
          height: large ? 38 : 32,
          borderRadius: "50%",
          border: "none",
          background: canSend ? "var(--color-accent)" : "var(--color-surface-2)",
          color: canSend ? "#FFFFFF" : "var(--color-text-muted)",
          cursor: canSend ? "pointer" : "default",
        }}
      >
        <SendIcon className={large ? "h-4 w-4" : "h-3.5 w-3.5"} />
      </button>
    </div>
  );
}
