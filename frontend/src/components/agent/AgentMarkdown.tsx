import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";

// Real model responses (ai-agent's Supervisor/Insights/Document agents) are
// plain Markdown text — tables, bold, headers, lists. The mock service this
// replaced never produced any, so message rendering was plain pre-wrap text
// until now. Styled to match ResponseRenderer.tsx's structured-block look
// rather than pulling in a generic markdown stylesheet.
const components: Components = {
  p: ({ children }) => (
    <p style={{ fontSize: "inherit", color: "var(--color-text)", lineHeight: 1.55, margin: "0 0 8px" }}>{children}</p>
  ),
  strong: ({ children }) => <strong style={{ fontWeight: 700, color: "var(--color-text)" }}>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  a: ({ href, children }) =>
    href?.startsWith("/") ? (
      <Link to={href} style={{ color: "var(--color-accent)", fontWeight: 600, textDecoration: "none" }}>
        {children}
      </Link>
    ) : (
      <a href={href} target="_blank" rel="noreferrer" style={{ color: "var(--color-accent)", fontWeight: 600, textDecoration: "none" }}>
        {children}
      </a>
    ),
  h1: ({ children }) => (
    <div style={{ fontSize: 14.5, fontWeight: 700, fontFamily: "var(--font-heading)", color: "var(--color-text)", margin: "10px 0 6px" }}>{children}</div>
  ),
  h2: ({ children }) => (
    <div style={{ fontSize: 13.5, fontWeight: 700, fontFamily: "var(--font-heading)", color: "var(--color-text)", margin: "10px 0 6px" }}>{children}</div>
  ),
  h3: ({ children }) => (
    <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: "var(--font-heading)", color: "var(--color-text)", margin: "8px 0 4px" }}>{children}</div>
  ),
  h4: ({ children }) => (
    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--color-text-secondary)", margin: "8px 0 4px" }}>{children}</div>
  ),
  ul: ({ children }) => (
    <ul style={{ margin: "4px 0 8px", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: "4px 0 8px", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>{children}</ol>
  ),
  li: ({ children }) => <li style={{ fontSize: "inherit", color: "var(--color-text)", lineHeight: 1.5 }}>{children}</li>,
  code: ({ children }) => (
    <code
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.92em",
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        borderRadius: 4,
        padding: "1px 5px",
      }}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        padding: 10,
        margin: "6px 0",
        overflowX: "auto",
      }}
    >
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div style={{ overflowX: "auto", margin: "8px 0", border: "1px solid var(--color-border)", borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => (
    <th
      style={{
        textAlign: "left",
        padding: "8px 12px",
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--color-text-muted)",
        background: "var(--color-surface-2)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td style={{ padding: "8px 12px", color: "var(--color-text)", borderTop: "1px solid var(--color-border)" }}>{children}</td>
  ),
  hr: () => <hr style={{ border: "none", borderTop: "1px solid var(--color-border)", margin: "10px 0" }} />,
};

export function AgentMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}
