import { useLocation } from "react-router-dom";
import type { AgentPageContext, AgentQuickAction } from "../types/agent";

interface PageContextEntry {
  match: (path: string) => boolean;
  label: string;
  quickActions: AgentQuickAction[];
}

const ENTRIES: PageContextEntry[] = [
  {
    match: (p) => p === "/",
    label: "Control Tower",
    quickActions: [
      { id: "ct-critical", label: "Explain critical alerts", prompt: "Explain the critical alerts on this page." },
      { id: "ct-priority", label: "What should I handle first?", prompt: "What should I handle first right now?" },
      { id: "ct-today", label: "Analyze today's issues", prompt: "Analyze today's issues across the control tower." },
    ],
  },
  {
    match: (p) => p.startsWith("/warehouses"),
    label: "Warehouses",
    quickActions: [
      { id: "wh-analyze", label: "Analyze warehouse", prompt: "Analyze this warehouse's current state." },
      { id: "wh-compare", label: "Compare warehouses", prompt: "Compare warehouses by performance." },
      { id: "wh-capacity", label: "Find capacity issues", prompt: "Find capacity issues across warehouses." },
    ],
  },
  {
    match: (p) => p.startsWith("/inventory") || p.startsWith("/products"),
    label: "Inventory",
    quickActions: [
      { id: "inv-analyze", label: "Analyze inventory", prompt: "Analyze the current inventory." },
      { id: "inv-low-stock", label: "Find low-stock products", prompt: "Find low-stock products that need attention." },
      { id: "inv-attention", label: "What needs attention?", prompt: "What in inventory needs attention right now?" },
    ],
  },
  {
    match: (p) => p.startsWith("/suppliers"),
    label: "Suppliers",
    quickActions: [
      { id: "sup-analyze", label: "Analyze suppliers", prompt: "Analyze current supplier performance." },
      { id: "sup-issues", label: "Find supplier issues", prompt: "Find any supplier issues I should know about." },
      { id: "sup-explain", label: "Explain supplier performance", prompt: "Explain how supplier performance is trending." },
    ],
  },
  {
    match: (p) => p.startsWith("/orders"),
    label: "Orders",
    quickActions: [
      { id: "ord-analyze", label: "Analyze orders", prompt: "Analyze current customer orders." },
      { id: "ord-attention", label: "What needs attention?", prompt: "Which orders need attention right now?" },
      { id: "ord-trends", label: "Explain order trends", prompt: "Explain recent order trends." },
    ],
  },
  {
    match: (p) => p.startsWith("/document-review"),
    label: "Document Review",
    quickActions: [
      { id: "doc-summarize", label: "Summarize pending reviews", prompt: "Summarize the documents pending review." },
      { id: "doc-flag", label: "Find flagged documents", prompt: "Find documents that were flagged." },
      { id: "doc-explain", label: "Explain review status", prompt: "Explain the current document review status." },
    ],
  },
  {
    match: (p) => p.startsWith("/analytics"),
    label: "Analytics",
    quickActions: [
      { id: "an-explain", label: "Explain this data", prompt: "Explain the data shown on this page." },
      { id: "an-changed", label: "What changed?", prompt: "What changed recently in this data?" },
      { id: "an-trends", label: "Find important trends", prompt: "Find the important trends here." },
    ],
  },
  {
    match: (p) => p.startsWith("/calendar"),
    label: "Calendar",
    quickActions: [
      { id: "cal-upcoming", label: "Summarize upcoming deliveries", prompt: "Summarize upcoming deliveries." },
      { id: "cal-conflicts", label: "Find scheduling conflicts", prompt: "Find any scheduling conflicts." },
      { id: "cal-explain", label: "Explain this week", prompt: "Explain what's happening this week." },
    ],
  },
  {
    match: (p) => p.startsWith("/settings"),
    label: "Settings",
    quickActions: [
      { id: "set-help", label: "What can I configure here?", prompt: "What can I configure on this page?" },
    ],
  },
];

const DEFAULT_ENTRY: PageContextEntry = {
  match: () => true,
  label: "Nexora ERP",
  quickActions: [
    { id: "gen-overview", label: "Give me an overview", prompt: "Give me an overview of what's happening right now." },
    { id: "gen-attention", label: "What needs attention?", prompt: "What needs attention across the ERP?" },
  ],
};

export function resolvePageContext(pathname: string): AgentPageContext {
  const entry = ENTRIES.find((e) => e.match(pathname)) ?? DEFAULT_ENTRY;
  return { path: pathname, label: entry.label, quickActions: entry.quickActions };
}

export function usePageContext(): AgentPageContext {
  const location = useLocation();
  return resolvePageContext(location.pathname);
}
