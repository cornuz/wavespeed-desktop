/**
 * Main Storyboard page — Detroit: Become Human style AI video storyboard.
 *
 * Layout:
 * ┌─────────────────────────────────────────────────────────┐
 * │  TopBar: project name | mode toggle | export | settings │
 * ├──────────┬──────────────────────────┬───────────────────┤
 * │ LeftPanel│   FlowCanvas (center)    │  RightPanel /     │
 * │ 角色/场景 │   Shot nodes + edges     │  AgentActivity    │
 * │          │                          │                   │
 * ├──────────┴──────────────────────────┴───────────────────┤
 * │  ChatBar: timeline + messages + input                   │
 * └─────────────────────────────────────────────────────────┘
 *
 * The right side shows AgentActivityPanel when agents are working
 * or when no shot is selected. Shows RightPanel (shot editor)
 * when a shot is selected and agents are idle.
 */
import { useEffect } from "react";
import { useStoryboardStore } from "./stores/storyboard.store";
import { useAgentActivityStore } from "./stores/agent-activity.store";
import { TopBar } from "./components/TopBar";
import { LeftPanel } from "./components/LeftPanel";
import { FlowCanvas } from "./components/FlowCanvas";
import { RightPanel } from "./components/RightPanel";
import { ChatBar } from "./components/ChatBar";
import { AgentActivityPanel } from "./components/AgentActivityPanel";

/**
 * Default API key — user can override via LLM Settings in TopBar.
 */
const DEFAULT_DEEPSEEK_KEY = "c74b61862bb0e025adafa9c84ebf5df246d52981b5c8477e80c4373e544c06d4";

export function StoryboardPage() {
  const setLlmConfig = useStoryboardStore((s) => s.setLlmConfig);
  const project = useStoryboardStore((s) => s.project);
  const selectedShotId = useStoryboardStore((s) => s.selectedShotId);
  const isAgentWorking = useStoryboardStore((s) => s.isAgentWorking);
  const agentPhases = useAgentActivityStore((s) => s.phases);

  // Set default API key on mount
  useEffect(() => {
    setLlmConfig({ apiKey: DEFAULT_DEEPSEEK_KEY });
  }, [setLlmConfig]);

  // Show agent panel when agents are working or have activity history
  const showAgentPanel = isAgentWorking || agentPhases.length > 0;
  // Show shot editor only when a shot is selected and agents are idle
  const showShotEditor = selectedShotId && !isAgentWorking;

  return (
    <div className="flex flex-col h-full bg-background text-foreground overflow-hidden">
      <TopBar />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left panel — characters & scenes */}
        {project && <LeftPanel />}

        {/* Center — flow canvas */}
        <FlowCanvas />

        {/* Right panel — agent activity or shot editor */}
        {(showAgentPanel || showShotEditor) && (
          <div className="w-80 border-l bg-background/50 flex flex-col shrink-0 overflow-hidden">
            {showShotEditor && !isAgentWorking ? (
              <RightPanel />
            ) : (
              <AgentActivityPanel />
            )}
          </div>
        )}
      </div>

      <ChatBar />
    </div>
  );
}
