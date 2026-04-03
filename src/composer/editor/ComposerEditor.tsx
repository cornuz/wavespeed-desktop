/**
 * ComposerEditor — the main editor shell mounted when a project is open.
 *
 * Structure:
 *   ┌─────────────────── ComposerHeader ──────────────────────┐
 *   │  ← Project name  │  [preset buttons]  │  Export →     │
 *   └─────────────────────────────────────────────────────────┘
 *   ┌─────────────────── EditorLayout ────────────────────────┐
 *   │  (Assets / Player / Properties / Timeline panels)       │
 *   └─────────────────────────────────────────────────────────┘
 */
import { LayoutPanelTop, PanelLeftOpen, PanelRightOpen, LayoutPanelLeft, X, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import type { ComposerProject, LayoutPreset } from "@/composer/types/project";
import { useComposerProjectStore } from "@/composer/stores/project.store";
import { useEditorLayout } from "./layout/useEditorLayout";
import { EditorLayout } from "./layout/EditorLayout";

// ─── Preset icon map ──────────────────────────────────────────────────────────

const PRESET_ICONS: Record<LayoutPreset, React.ElementType> = {
  timeline:   LayoutPanelTop,
  assets:     PanelLeftOpen,
  properties: PanelRightOpen,
  vertical:   LayoutPanelLeft,
};

const PRESET_LABELS: Record<LayoutPreset, string> = {
  timeline:   "Timeline",
  assets:     "Assets",
  properties: "Properties",
  vertical:   "Vertical",
};

const PRESETS: LayoutPreset[] = ["timeline", "assets", "properties", "vertical"];

// ─── Header ───────────────────────────────────────────────────────────────────

interface ComposerHeaderProps {
  project: ComposerProject;
  activePreset: LayoutPreset;
  onPresetChange: (p: LayoutPreset) => void;
  onClose: () => void;
}

function ComposerHeader({ project, activePreset, onPresetChange, onClose }: ComposerHeaderProps) {
  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex items-center h-12 px-3 border-b border-border bg-background shrink-0 gap-2">
        {/* Project name */}
        <span className="text-sm font-medium text-foreground truncate max-w-[220px]">
          {project.name}
        </span>

        <Separator orientation="vertical" className="h-5 mx-1" />

        {/* Preset buttons */}
        <div className="flex items-center gap-1">
          {PRESETS.map((preset) => {
            const Icon = PRESET_ICONS[preset];
            const isActive = activePreset === preset;
            return (
              <Tooltip key={preset}>
                <TooltipTrigger asChild>
                  <Button
                    variant={isActive ? "secondary" : "ghost"}
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => onPresetChange(preset)}
                    aria-pressed={isActive}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="sr-only">{PRESET_LABELS[preset]}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {PRESET_LABELS[preset]}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Export */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" disabled>
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Export MP4 — coming soon</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-5 mx-1" />

        {/* Close */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <X className="h-4 w-4" />
              <span className="sr-only">Close project</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Close project</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

// ─── Main editor ──────────────────────────────────────────────────────────────

interface ComposerEditorProps {
  project: ComposerProject;
}

export function ComposerEditor({ project }: ComposerEditorProps) {
  const close = useComposerProjectStore((s) => s.closeProject);
  const layout = useEditorLayout(project);

  return (
    <div className="flex flex-col h-full w-full min-h-0 overflow-hidden" data-composer-editor>
      <ComposerHeader
        project={project}
        activePreset={layout.activePreset}
        onPresetChange={layout.setPreset}
        onClose={close}
      />
      <div className="flex-1 min-h-0 overflow-hidden">
        <EditorLayout layout={layout} />
      </div>
    </div>
  );
}
