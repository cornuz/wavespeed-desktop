import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { composerProjectIpc, composerExportIpc } from "@/composer/ipc/ipc-client";
import type { ComposerProject } from "@/composer/types/project";
import { toast } from "@/hooks/useToast";

const DIMENSION_PRESETS = [
  { id: "youtube-16x9", label: "YouTube/LinkedIn (16:9) 1920x1080", width: 1920, height: 1080 },
  { id: "tiktok-9x16", label: "TikTok/Reels (9:16) 1080x1920", width: 1080, height: 1920 },
  { id: "instagram-1x1", label: "Instagram Square (1:1) 1080x1080", width: 1080, height: 1080 },
  { id: "twitter-16x9", label: "Twitter (16:9) 1280x720", width: 1280, height: 720 },
  { id: "uhd-4k", label: "4K UHD (16:9) 3840x2160", width: 3840, height: 2160 },
  { id: "cinema-scope", label: "Cinema scope (2.39:1) 4096x1716", width: 4096, height: 1716 },
  { id: "cinema-classic", label: "Cinema classic (1.85:1) 1998x1080", width: 1998, height: 1080 },
];

const FRAME_RATE_OPTIONS = [24, 25, 29.97, 30, 50, 59.97, 60] as const;

// Quality presets removed from the export modal UI; encoding quality is handled elsewhere.

interface Props {
  project: ComposerProject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ExportDialog({ project, open, onOpenChange }: Props) {
  const [fileName, setFileName] = useState(project.name + "_export.mp4");
  const [presetId, setPresetId] = useState("project");
  const [fps, setFps] = useState<number>(project.fps);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (open) {
      setFileName((project.name || "project").replace(/[^a-z0-9-_.]/gi, "_") + "_export.mp4");
      // Choose the preset that matches the current project dimensions if any,
      // otherwise mark as custom.
      const matched = DIMENSION_PRESETS.find(
        (p) => p.width === project.width && p.height === project.height,
      );
      setPresetId(matched ? matched.id : "custom");
      setFps(project.fps);
      setProgress(null);
    }
  }, [open, project.id]);

  // Progress subscription is created only during an active export to avoid
  // starting background generation when the dialog is opened and the user
  // is still adjusting options.

  const selectedDimensions = useMemo(() => {
    if (presetId === "custom") return { width: project.width, height: project.height };
    const preset = DIMENSION_PRESETS.find((p) => p.id === presetId) ?? DIMENSION_PRESETS[0];
    return { width: preset.width, height: preset.height };
  }, [presetId, project.width, project.height]);

  // Export uses explicit dimensions only; quality controls encode/playback choices but
  // percent-scaling is intentionally removed from the export modal UI and logic.

  const onExport = async () => {
    setIsExporting(true);
    setProgress(0);
      // Subscribe to progress events for this project only while exporting.
      const unsub = composerExportIpc.onProgress((payload) => {
      try {
        const ev = payload as any;
        if (ev?.projectId !== project.id) return;
        if (typeof ev.overallPercent === "number") setProgress(ev.overallPercent);
      } catch {
        // ignore
      }
    });

    try {
      const name = (fileName || "").trim();
      const response = await composerProjectIpc.export({
        projectId: project.id,
        fileName: name || undefined,
        // Render uses explicit dimension selector only (no % scaling)
        width: selectedDimensions.width,
        height: selectedDimensions.height,
        fps,
      });
      toast({ title: "Export complete", description: response });
      onOpenChange(false);
    } catch (err) {
      console.error(err);
      toast({ title: "Export failed", description: err instanceof Error ? err.message : String(err) });
    } finally {
      try {
        unsub();
      } catch {}
      setIsExporting(false);
      setProgress(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Export MP4</DialogTitle>
          <DialogDescription>Choose file name, dimensions, and frame rate.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          <div>
            <div className="text-sm text-foreground mb-1">File name</div>
            <Input value={fileName} onChange={(e) => setFileName(e.target.value)} />
          </div>

          <div>
            <div className="text-sm text-foreground mb-1">Dimensions</div>
            <Select onValueChange={(v) => setPresetId(v)} value={presetId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select dimensions" />
              </SelectTrigger>
              <SelectContent>
                {DIMENSION_PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                ))}
                <SelectItem key="custom" value="custom">{`Custom ${project.width} x ${project.height}`}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-sm text-foreground mb-1">Dimensions : {selectedDimensions.width} x {selectedDimensions.height} px</div>
            </div>

            <div>
              <div className="text-sm text-foreground mb-1">Frame rate</div>
              <Select onValueChange={(v) => setFps(Number(v))} value={String(fps)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FRAME_RATE_OPTIONS.map((f) => (
                    <SelectItem key={String(f)} value={String(f)}>{f.toFixed(2)} fps</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {progress != null && (
            <div>
              <div className="w-full bg-muted/40 rounded h-2 overflow-hidden">
                <div className="bg-primary h-2" style={{ width: `${Math.min(Math.max(progress, 0), 100)}%` }} />
              </div>
              <div className="text-xs text-muted mt-1">{Math.min(Math.max(progress, 0), 100).toFixed(1)}%</div>
            </div>
          )}
        </div>

        <DialogFooter>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={async () => {
              if (isExporting) {
                try {
                  await composerProjectIpc.cancelExport(project.id);
                } catch {}
              } else {
                onOpenChange(false);
              }
            }} disabled={false}>{isExporting ? "Cancel Export" : "Cancel"}</Button>
            <Button onClick={onExport} disabled={isExporting}>{isExporting ? "Exporting..." : "Export"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
