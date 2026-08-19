/**
 * Placeholder only.
 *
 * MERGE-AI: replace this whole page with the real AlertCard/
 * ControlTowerDashboard components from ai-agent-ui/src/components/, fed by
 * ai-agent/narration/control_tower.py's real narrated-alert output (see
 * ai-agent/tools/schemas/control_tower_schema.py for the NarratedAlert
 * shape those components expect). Not duplicated here on purpose - see
 * README.md.
 */
export function ControlTowerPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-3 text-4xl">🛰️</div>
      <h1 className="text-xl font-semibold text-zinc-100">Control Tower</h1>
      <p className="mt-2 max-w-sm text-sm text-zinc-500">
        Coming soon. Will show alerts narrated by the AI layer - see the MERGE-AI comment in
        this file.
      </p>
    </div>
  );
}
