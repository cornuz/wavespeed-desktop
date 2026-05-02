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
import { useEffect, useState } from "react";
import { LayoutPanelTop, PanelLeftOpen, PanelRightOpen, LayoutPanelLeft, X, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import type { ComposerProject, LayoutPreset } from "@/composer/types/project";
import { useComposerProjectStore } from "@/composer/stores/project.store";
import { ComposerRuntimeProvider } from "./context/ComposerRuntimeContext";
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
  onRename: (name: string) => Promise<void>;
  onClose: () => void;
}

function ComposerHeader({ project, activePreset, onPresetChange, onRename, onClose }: ComposerHeaderProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [draftName, setDraftName] = useState(project.name);

  useEffect(() => {
    setDraftName(project.name);
    setIsEditingName(false);
  }, [project.id, project.name]);

  const commitName = async () => {
    const nextName = draftName.trim();
    setIsEditingName(false);
    if (!nextName || nextName === project.name) {
      setDraftName(project.name);
      return;
    }
    await onRename(nextName);
  };

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex items-center h-12 px-3 border-b border-border bg-background shrink-0 gap-2">
        {/* Project name */}
        {isEditingName ? (
          <input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitName();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraftName(project.name);
                setIsEditingName(false);
              }
            }}
            className="h-8 max-w-[220px] rounded border border-border bg-background px-2 text-sm font-medium text-foreground outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            autoFocus
          />
        ) : (
          <button
            type="button"
            className="max-w-[220px] truncate text-left text-sm font-medium text-foreground"
            onDoubleClick={() => setIsEditingName(true)}
          >
            {project.name}
          </button>
        )}

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
  const rename = useComposerProjectStore((s) => s.renameProject);
  const layout = useEditorLayout(project);

  return (
    <ComposerRuntimeProvider project={project}>
      <div className="flex flex-col h-full w-full min-h-0 overflow-hidden select-none cursor-default" data-composer-editor>
        <ComposerHeader
          project={project}
          activePreset={layout.activePreset}
          onPresetChange={layout.setPreset}
          onRename={(name) => rename(project.id, name)}
          onClose={close}
        />
        <div className="flex-1 min-h-0 overflow-hidden">
          <EditorLayout layout={layout} />
        </div>
      </div>
    </ComposerRuntimeProvider>
  );
}
