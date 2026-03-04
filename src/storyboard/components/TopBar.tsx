/**
 * Top bar — project name, mode toggle, model settings, export, reset.
 */
import { useStoryboardStore } from "../stores/storyboard.store";
import { Button } from "@/components/ui/button";
import { Download, RotateCcw, Clapperboard } from "lucide-react";
import { ModelSettings } from "./ModelSettings";
import { LlmSettings } from "./LlmSettings";

export function TopBar() {
  const project = useStoryboardStore((s) => s.project);
  const toggleMode = useStoryboardStore((s) => s.toggleMode);
  const reset = useStoryboardStore((s) => s.reset);
  const setProjectStatus = useStoryboardStore((s) => s.setProjectStatus);
  const shots = useStoryboardStore((s) => s.shots);
  const selectedModels = useStoryboardStore((s) => s.selectedModels);
  const setModel = useStoryboardStore((s) => s.setModel);

  const pendingCount = shots.filter(
    (s) => s.generation_status === "pending" || s.generation_status === "dirty",
  ).length;

  return (
    <div className="h-10 border-b bg-background/80 backdrop-blur flex items-center justify-between px-3 shrink-0">
      <div className="flex items-center gap-3">
        <Clapperboard className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">
          {project?.name || "AI 故事板"}
        </span>
        {project && (
          <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-muted">
            {project.status}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* Model settings — collapsible */}
        <ModelSettings
          selectedModels={selectedModels}
          onModelChange={setModel}
        />

        {/* LLM settings — collapsible */}
        <LlmSettings />

        {project && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[10px] px-2"
              onClick={toggleMode}
            >
              {project.mode === "lite" ? "轻模式" : "专业模式"}
            </Button>

            {pendingCount > 0 && (
              <Button
                size="sm"
                className="h-7 text-[10px] px-2"
                onClick={() => setProjectStatus("generating")}
              >
                生成 ({pendingCount})
              </Button>
            )}

            <Button variant="outline" size="sm" className="h-7 text-[10px] px-2">
              <Download className="h-3 w-3 mr-1" /> 导出
            </Button>
          </>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[10px] px-2 text-muted-foreground"
          onClick={reset}
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
