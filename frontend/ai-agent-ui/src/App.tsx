import { useState } from "react";
import { ChatWidget } from "./components/ChatWidget";
import { ControlTowerDashboard } from "./components/ControlTowerDashboard";
import { SupplierCard } from "./components/SupplierCard";
import { ToolTraceView } from "./components/ToolTraceView";
import { mockAlerts, mockChatMessages, mockSuppliers, mockToolTrace } from "./mock-data";
import type { ChatMessage, NarratedAlert } from "./types";

/**
 * Standalone demo page - previews every component against the mock data in
 * mock-data.ts. No fetch calls, no backend: `npm run dev` renders this
 * exactly as-is. Not meant to ship as-is; it exists so a reviewer or the
 * frontend teammate can see every component live before wiring in real data.
 */
function App() {
  const [messages, setMessages] = useState<ChatMessage[]>(mockChatMessages);

  function handleSend(content: string) {
    setMessages((prev) => [
      ...prev,
      { role: "user", content },
      {
        role: "supervisor",
        content: "(demo only - wire onSend to a real Supervisor call to get a real reply)",
      },
    ]);
  }

  function handleProposeAction(alert: NarratedAlert) {
    // eslint-disable-next-line no-console
    console.log("Propose Action clicked for", alert.id, alert.proposed_action);
  }

  return (
    <div className="min-h-screen bg-slate-50 px-6 py-10 dark:bg-slate-950">
      <div className="mx-auto max-w-6xl space-y-12">
        <header>
          <h1 className="text-2xl font-semibold text-slate-800 dark:text-slate-100">
            AI Module — Component Preview
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            All data below is mocked, shaped to match the real Python schemas in
            ai-agent/tools/schemas/ and ai-agent/narration/.
          </p>
        </header>

        <section className="space-y-4">
          <h2 className="text-lg font-medium text-slate-700 dark:text-slate-200">
            ChatWidget
          </h2>
          <ChatWidget messages={messages} onSend={handleSend} />
        </section>

        <section className="space-y-4">
          <h2 className="text-lg font-medium text-slate-700 dark:text-slate-200">
            ControlTowerDashboard (AlertCard grid)
          </h2>
          <ControlTowerDashboard
            alerts={mockAlerts}
            onProposeAction={handleProposeAction}
          />
        </section>

        <section className="space-y-4">
          <h2 className="text-lg font-medium text-slate-700 dark:text-slate-200">
            SupplierCard
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {mockSuppliers.map((supplier) => (
              <SupplierCard key={supplier.supplier_id} supplier={supplier} />
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-lg font-medium text-slate-700 dark:text-slate-200">
            ToolTraceView
          </h2>
          <ToolTraceView trace={mockToolTrace} title="Restock recommendation query" />
        </section>
      </div>
    </div>
  );
}

export default App;
