import { useCallback, useEffect, useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { composerProjectIpc } from "@/composer/ipc/ipc-client";
import { useComposerProjectStore } from "@/composer/stores/project.store";
import type { Clip } from "@/composer/types/project";
import { useComposerRuntime } from "../context/ComposerRuntimeContext";
import {
  formatTimelineTime,
  getClipEnd,
  getTrimEnd,
  MIN_CLIP_DURATION,
  resolveTrackStart,
} from "../utils/timeline";

const DIMENSION_PRESETS = [
  { id: "youtube-16x9", label: "YouTube/LinkedIn (16:9) 1920x1080", width: 1920, height: 1080 },
  { id: "tiktok-9x16", label: "TikTok/Reels (9:16) 1080x1920", width: 1080, height: 1920 },
  { id: "instagram-1x1", label: "Instagram Square (1:1) 1080x1080", width: 1080, height: 1080 },
  { id: "twitter-16x9", label: "Twitter (16:9) 1280x720", width: 1280, height: 720 },
  { id: "uhd-4k", label: "4K UHD (16:9) 3840x2160", width: 3840, height: 2160 },
  { id: "cinema-scope", label: "Cinema scope (2.39:1) 4096x1716", width: 4096, height: 1716 },
  { id: "cinema-classic", label: "Cinema classic (1.85:1) 1998x1080", width: 1998, height: 1080 },
] as const;

const FRAME_RATE_OPTIONS = [24, 25, 29.97, 30, 50, 59.97, 60] as const;

function formatInputNumber(value: number, decimals = 3): string {
  return Number(value.toFixed(decimals)).toString();
}

function getClipSourceName(clip: Clip): string {
  return clip.sourcePath?.split(/[\\/]/).pop() ?? "Source asset";
}

function isImageClip(clip: Clip): boolean {
  return clip.sourcePath?.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i) != null;
}

function PropertyNumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step = 0.01,
  decimals = 3,
  suffix,
  disabled = false,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(() => formatInputNumber(value, decimals));

  useEffect(() => {
    setDraft(formatInputNumber(value, decimals));
  }, [decimals, value]);

  const commit = useCallback(() => {
    if (disabled) {
      setDraft(formatInputNumber(value, decimals));
      return;
    }

    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(formatInputNumber(value, decimals));
      return;
    }

    const nextValue = Math.min(
      max ?? Number.POSITIVE_INFINITY,
      Math.max(min ?? Number.NEGATIVE_INFINITY, parsed),
    );
    setDraft(formatInputNumber(nextValue, decimals));
    onCommit(nextValue);
  }, [decimals, disabled, draft, max, min, onCommit, value]);

  return (
    <label className="flex flex-col gap-1">
      <span className="text-foreground">{label}</span>
      <div className="relative">
        <Input
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraft(formatInputNumber(value, decimals));
              event.currentTarget.blur();
            }
          }}
          className="h-8 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
            {suffix}
          </span>
        ) : null}
      </div>
    </label>
  );
}

export function PropertiesPanel() {
  const patchCurrentProject = useComposerProjectStore((state) => state.patchCurrentProject);
  const {
    project,
    timelineDuration,
    clips,
    selectedClip,
    selectedVisualClip,
    tracks,
    moveClip,
    trimClip,
    updateClip,
  } = useComposerRuntime();
  const dimensionPreset =
    DIMENSION_PRESETS.find(
      (preset) => preset.width === project.width && preset.height === project.height,
    )?.id ?? "custom";
  const [selectedDimensionMode, setSelectedDimensionMode] = useState(dimensionPreset);
  const trackName = selectedClip
    ? tracks.find((track) => track.id === selectedClip.trackId)?.name ?? selectedClip.trackId
    : null;
  const selectedClipSourceName = selectedClip ? getClipSourceName(selectedClip) : null;
  const trimOut = selectedClip ? getTrimEnd(selectedClip) : 0;
  const isVisualClip = Boolean(
    selectedClip && selectedVisualClip && selectedVisualClip.id === selectedClip.id,
  );
  const sourceTrimEditable = selectedClip ? !isImageClip(selectedClip) : false;
  const siblingClips = useMemo(
    () =>
      selectedClip
        ? clips
            .filter((clip) => clip.trackId === selectedClip.trackId && clip.id !== selectedClip.id)
            .sort((left, right) => left.startTime - right.startTime)
        : [],
    [clips, selectedClip],
  );
  const previousClip = useMemo(
    () =>
      selectedClip
        ? [...siblingClips]
            .reverse()
            .find((clip) => getClipEnd(clip) <= selectedClip.startTime)
        : undefined,
    [selectedClip, siblingClips],
  );
  const nextClip = useMemo(
    () =>
      selectedClip
        ? siblingClips.find((clip) => clip.startTime >= getClipEnd(selectedClip))
        : undefined,
    [selectedClip, siblingClips],
  );

  const handleStartCommit = useCallback(
    (value: number) => {
      if (!selectedClip) {
        return;
      }

      void moveClip(
        selectedClip.id,
        resolveTrackStart(value, selectedClip.duration, siblingClips, project.fps),
      );
    },
    [moveClip, project.fps, selectedClip, siblingClips],
  );

  const handleDurationCommit = useCallback(
    (value: number) => {
      if (!selectedClip) {
        return;
      }

      const desiredDuration = Math.max(MIN_CLIP_DURATION, value);
      if (!sourceTrimEditable) {
        const maxDurationByTrack = nextClip
          ? Math.max(MIN_CLIP_DURATION, nextClip.startTime - selectedClip.startTime)
          : desiredDuration;
        void trimClip(selectedClip.id, {
          startTime: selectedClip.startTime,
          duration: Math.min(desiredDuration, maxDurationByTrack),
          trimStart: 0,
          trimEnd: 0,
        });
        return;
      }

      const totalAvailableDuration = selectedClip.duration + trimOut;
      const maxDurationByTrack = nextClip
        ? Math.max(MIN_CLIP_DURATION, nextClip.startTime - selectedClip.startTime)
        : totalAvailableDuration;
      const nextDuration = Math.max(
        MIN_CLIP_DURATION,
        Math.min(desiredDuration, totalAvailableDuration, maxDurationByTrack),
      );

      void trimClip(selectedClip.id, {
        startTime: selectedClip.startTime,
        duration: nextDuration,
        trimStart: selectedClip.trimStart,
        trimEnd: totalAvailableDuration - nextDuration,
      });
    },
    [nextClip, selectedClip, sourceTrimEditable, trimClip, trimOut],
  );

  const handleTrimInCommit = useCallback(
    (value: number) => {
      if (!selectedClip || !sourceTrimEditable) {
        return;
      }

      const minStartTime = Math.max(
        previousClip ? getClipEnd(previousClip) : 0,
        selectedClip.startTime - selectedClip.trimStart,
      );
      const delta = Math.min(
        selectedClip.duration - MIN_CLIP_DURATION,
        Math.max(minStartTime - selectedClip.startTime, value - selectedClip.trimStart),
      );

      void trimClip(selectedClip.id, {
        startTime: selectedClip.startTime + delta,
        duration: selectedClip.duration - delta,
        trimStart: selectedClip.trimStart + delta,
        trimEnd: selectedClip.trimEnd,
      });
    },
    [previousClip, selectedClip, sourceTrimEditable, trimClip],
  );

  const handleTrimOutCommit = useCallback(
    (value: number) => {
      if (!selectedClip || !sourceTrimEditable) {
        return;
      }

      const totalAvailableDuration = selectedClip.duration + trimOut;
      const desiredDuration = totalAvailableDuration - Math.max(0, value);
      const maxDurationByTrack = nextClip
        ? Math.max(MIN_CLIP_DURATION, nextClip.startTime - selectedClip.startTime)
        : totalAvailableDuration;
      const nextDuration = Math.max(
        MIN_CLIP_DURATION,
        Math.min(desiredDuration, totalAvailableDuration, maxDurationByTrack),
      );

      void trimClip(selectedClip.id, {
        startTime: selectedClip.startTime,
        duration: nextDuration,
        trimStart: selectedClip.trimStart,
        trimEnd: totalAvailableDuration - nextDuration,
      });
    },
    [nextClip, selectedClip, sourceTrimEditable, trimClip, trimOut],
  );

  useEffect(() => {
    setSelectedDimensionMode(dimensionPreset);
  }, [dimensionPreset]);

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">Properties</span>
      </div>
      {selectedClip ? (
        <div className="flex flex-col gap-3 p-3 text-xs">
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-medium text-foreground">Selected clip</div>
            <div className="space-y-3">
              <div className="space-y-1 text-muted-foreground">
                <div>
                  <span className="text-foreground">Track:</span> {trackName}
                </div>
                <div>
                  <span className="text-foreground">Asset:</span> {selectedClipSourceName}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <PropertyNumberField
                  label="Start"
                  value={selectedClip.startTime}
                  min={0}
                  step={0.01}
                  onCommit={handleStartCommit}
                />
                <PropertyNumberField
                  label="Duration"
                  value={selectedClip.duration}
                  min={MIN_CLIP_DURATION}
                  step={0.01}
                  onCommit={handleDurationCommit}
                />
                <PropertyNumberField
                  label="Trim in"
                  value={selectedClip.trimStart}
                  min={0}
                  step={0.01}
                  disabled={!sourceTrimEditable}
                  onCommit={handleTrimInCommit}
                />
                <PropertyNumberField
                  label="Trim out"
                  value={trimOut}
                  min={0}
                  step={0.01}
                  disabled={!sourceTrimEditable}
                  onCommit={handleTrimOutCommit}
                />
                <PropertyNumberField
                  label="Fade in"
                  value={selectedClip.fadeInDuration}
                  min={0}
                  step={0.01}
                  onCommit={(value) =>
                    void updateClip(selectedClip.id, { fadeInDuration: Math.max(0, value) })
                  }
                />
                <PropertyNumberField
                  label="Fade out"
                  value={selectedClip.fadeOutDuration}
                  min={0}
                  step={0.01}
                  onCommit={(value) =>
                    void updateClip(selectedClip.id, { fadeOutDuration: Math.max(0, value) })
                  }
                />
              </div>

              <div className="rounded border border-border/60 bg-background/70 p-2 text-[11px] text-muted-foreground">
                Current range: {formatTimelineTime(selectedClip.startTime)} →{" "}
                {formatTimelineTime(getClipEnd(selectedClip))} on the timeline
              </div>
              {!sourceTrimEditable ? (
                <div className="text-[11px] text-muted-foreground">
                  Still images do not expose source trim in/out in the current clip model.
                </div>
              ) : null}
            </div>
          </div>

          {isVisualClip ? (
            <div className="rounded-md border border-border bg-muted/20 p-3">
              <div className="mb-3 text-sm font-medium text-foreground">Visual</div>
              <div className="grid grid-cols-2 gap-2">
                <PropertyNumberField
                  label="Position X"
                  value={(selectedClip.transformOffsetX + 0.5) * project.width}
                  step={1}
                  decimals={2}
                  onCommit={(value) =>
                    void updateClip(selectedClip.id, {
                      transformOffsetX: value / project.width - 0.5,
                    })
                  }
                />
                <PropertyNumberField
                  label="Position Y"
                  value={(selectedClip.transformOffsetY + 0.5) * project.height}
                  step={1}
                  decimals={2}
                  onCommit={(value) =>
                    void updateClip(selectedClip.id, {
                      transformOffsetY: value / project.height - 0.5,
                    })
                  }
                />
                <PropertyNumberField
                  label="Rotation Z"
                  value={selectedClip.rotationZ}
                  step={0.1}
                  decimals={2}
                  onCommit={(value) => void updateClip(selectedClip.id, { rotationZ: value })}
                />
                <PropertyNumberField
                  label="Scale"
                  value={selectedClip.transformScale * 100}
                  min={10}
                  max={1000}
                  step={1}
                  decimals={2}
                  suffix="%"
                  onCommit={(value) =>
                    void updateClip(selectedClip.id, {
                      transformScale: Math.max(0.1, value / 100),
                    })
                  }
                />
                <PropertyNumberField
                  label="Opacity"
                  value={selectedClip.opacity * 100}
                  min={0}
                  max={100}
                  step={1}
                  decimals={2}
                  suffix="%"
                  onCommit={(value) =>
                    void updateClip(selectedClip.id, {
                      opacity: Math.min(1, Math.max(0, value / 100)),
                    })
                  }
                />
              </div>
            </div>
          ) : null}

          <div className="text-muted-foreground">
            Enter values and press Enter or click away to commit. Undo still works with Ctrl/Cmd+Z.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-3 text-xs">
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-2 text-sm font-medium text-foreground">Project</div>
            <div className="space-y-3 text-muted-foreground">
              <label className="flex flex-col gap-1">
                <span className="text-foreground">Dimension</span>
                <select
                  className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                  value={selectedDimensionMode}
                  onChange={(event) => {
                    const nextMode = event.target.value;
                    setSelectedDimensionMode(nextMode);
                    const nextPreset = DIMENSION_PRESETS.find((preset) => preset.id === nextMode);
                    if (!nextPreset) {
                      return;
                    }
                    void composerProjectIpc
                      .save({ id: project.id, width: nextPreset.width, height: nextPreset.height })
                      .then(() =>
                        patchCurrentProject({
                          width: nextPreset.width,
                          height: nextPreset.height,
                        }),
                      )
                      .catch(() => undefined);
                  }}
                >
                  {DIMENSION_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                  <option value="custom">Custom</option>
                </select>
              </label>

              {selectedDimensionMode === "custom" ? (
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-foreground">w</span>
                  <input
                    type="number"
                    min={1}
                    value={project.width}
                    onChange={(event) => {
                      const width = Number(event.target.value);
                      void composerProjectIpc
                        .save({ id: project.id, width })
                        .then(() => patchCurrentProject({ width }))
                        .catch(() => undefined);
                    }}
                    className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                  />
                  <span className="shrink-0 text-sm text-muted-foreground">*</span>
                  <span className="shrink-0 text-foreground">h</span>
                  <input
                    type="number"
                    min={1}
                    value={project.height}
                    onChange={(event) => {
                      const height = Number(event.target.value);
                      void composerProjectIpc
                        .save({ id: project.id, height })
                        .then(() => patchCurrentProject({ height }))
                        .catch(() => undefined);
                    }}
                    className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">px</span>
                </div>
              ) : null}

              <label className="flex flex-col gap-1">
                <span className="text-foreground">Duration</span>
                <input
                  type="number"
                  min={1}
                  step={0.5}
                  value={project.duration}
                  onChange={(event) => {
                    const duration = Number(event.target.value);
                    void composerProjectIpc
                      .save({ id: project.id, duration })
                      .then(() => patchCurrentProject({ duration }))
                      .catch(() => undefined);
                  }}
                  className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-foreground">Frame rate</span>
                <select
                  className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                  value={project.fps}
                  onChange={(event) => {
                    const fps = Number(event.target.value);
                    void composerProjectIpc
                      .save({ id: project.id, fps })
                      .then(() => patchCurrentProject({ fps }))
                      .catch(() => undefined);
                  }}
                >
                  {FRAME_RATE_OPTIONS.map((fps) => (
                    <option key={fps} value={fps}>
                      {fps.toFixed(2)} fps
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="rounded-md border border-border bg-muted/20 p-3">
            <div className="mb-2 text-sm font-medium text-foreground">Export frame</div>
            <div className="space-y-1 text-muted-foreground">
              <div>
                <span className="text-foreground">Visible frame:</span> {project.width}*{project.height}px
              </div>
              <div>
                <span className="text-foreground">Project duration:</span> {project.duration.toFixed(2)}s
              </div>
              <div>
                <span className="text-foreground">Timeline content:</span> {timelineDuration.toFixed(2)}s
              </div>
            </div>
          </div>

          <div className="text-muted-foreground">
            Select a clip to edit timing, fades, and visual transform values.
          </div>
        </div>
      )}
    </div>
  );
}
