import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowUpDown,
  Loader2,
  RefreshCw,
  SlidersHorizontal,
  Upload,
  VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { composerAssetIpc, composerLutIpc, composerProjectIpc } from "@/composer/ipc/ipc-client";
import { normalizeClipAdjustments } from "@/composer/shared/clipAdjustments";
import { normalizeProjectBackgroundColor } from "@/composer/shared/projectBackground";
import { useComposerProjectStore } from "@/composer/stores/project.store";
import type {
  Clip,
  ClipAdjustmentsPatch,
  ClipBlendMode,
  ComposerAsset,
  ComposerLutAsset,
} from "@/composer/types/project";
import { cn } from "@/lib/utils";
import { useComposerRuntime } from "../context/ComposerRuntimeContext";
import {
  formatTimelineTime,
  getClipEnd,
  getTrimEnd,
  MIN_CLIP_DURATION,
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
const PROPERTIES_TWO_COLUMN_BREAKPOINT = 560;
const UI_TIME_SNAP_SECONDS = 0.1;
const TIME_PRECISION = 6;
const MUTED_VOLUME_EPSILON = 0.0001;
const BLEND_MODE_OPTIONS: Array<{ value: ClipBlendMode; label: string }> = [
  { value: "normal", label: "Normal" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "overlay", label: "Overlay" },
  { value: "darken", label: "Darken" },
  { value: "lighten", label: "Lighten" },
  { value: "color-dodge", label: "Color dodge" },
  { value: "color-burn", label: "Color burn" },
  { value: "soft-light", label: "Soft light" },
  { value: "hard-light", label: "Hard light" },
  { value: "difference", label: "Difference" },
  { value: "exclusion", label: "Exclusion" },
  { value: "hue", label: "Hue" },
  { value: "saturation", label: "Saturation" },
  { value: "color", label: "Color" },
  { value: "luminosity", label: "Luminosity" },
];

function formatInputNumber(value: number, decimals = 3): string {
  return Number(value.toFixed(decimals)).toString();
}

function normalizeTime(value: number): number {
  return Number(Math.max(0, value).toFixed(TIME_PRECISION));
}

function resolveTrackStartInSeconds(
  desiredStart: number,
  duration: number,
  otherClips: Clip[],
): number {
  let nextStart = Math.max(0, desiredStart);

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const overlappingClip = otherClips.find(
      (clip) => nextStart < getClipEnd(clip) && nextStart + duration > clip.startTime,
    );
    if (!overlappingClip) {
      break;
    }

    const previousClip = [...otherClips]
      .reverse()
      .find((clip) => getClipEnd(clip) <= desiredStart + UI_TIME_SNAP_SECONDS);

    if (previousClip && Math.abs(nextStart - getClipEnd(previousClip)) <= UI_TIME_SNAP_SECONDS) {
      nextStart = getClipEnd(previousClip);
      continue;
    }

    nextStart =
      desiredStart >= overlappingClip.startTime
        ? getClipEnd(overlappingClip)
        : Math.max(0, overlappingClip.startTime - duration);
  }

  return normalizeTime(nextStart);
}

function getClipSourceName(clip: Clip): string {
  return clip.sourcePath?.split(/[\\/]/).pop() ?? "Source asset";
}

function isImageClip(clip: Clip): boolean {
  return clip.sourcePath?.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i) != null;
}

function isSvgClip(clip: Clip): boolean {
  return clip.sourcePath?.match(/\.svg$/i) != null;
}

function supportsVolumeControl(clip: Clip): boolean {
  return clip.sourcePath?.match(/\.(mp4|webm|mov|avi|mkv|m4v|mp3|wav|ogg|flac|aac|m4a|wma)$/i) != null;
}

function isClipMutedByProperties(clip: Clip): boolean {
  return clip.volume <= MUTED_VOLUME_EPSILON;
}

function findAssetForClip(
  clip: { sourceAssetId: string | null; sourcePath: string | null } | null,
  assets: ComposerAsset[],
): ComposerAsset | null {
  if (!clip) {
    return null;
  }

  if (clip.sourceAssetId) {
    const byId = assets.find((asset) => asset.id === clip.sourceAssetId);
    if (byId) {
      return byId;
    }
  }

  if (!clip.sourcePath) {
    return null;
  }

  return (
    assets.find(
      (asset) =>
        asset.filePath === clip.sourcePath ||
        asset.workingPath === clip.sourcePath,
    ) ?? null
  );
}

function PropertyResetButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={onClick}
            disabled={disabled}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>Reset</TooltipContent>
    </Tooltip>
  );
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
  onReset,
  resetDisabled = false,
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
  onReset?: () => void;
  resetDisabled?: boolean;
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
      <div className="flex items-center gap-1">
        <div className="relative min-w-0 flex-1">
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
        {onReset ? <PropertyResetButton onClick={onReset} disabled={resetDisabled} /> : null}
      </div>
    </label>
  );
}

function PropertySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="mb-3 text-sm font-medium text-foreground">{title}</div>
      {children}
    </div>
  );
}

function PropertySliderControl({
  title,
  subtitle,
  actions,
  value,
  onCommit,
  min,
  max,
  inputStep = 1,
  sliderStep,
  liveCommitOnSlide = false,
  decimals = 2,
  suffix,
  onReset,
  resetDisabled = false,
  disabled = false,
  centeredFill = false,
}: {
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
  value: number;
  onCommit: (value: number) => void;
  min: number;
  max: number;
  inputStep?: number;
  sliderStep?: number;
  liveCommitOnSlide?: boolean;
  decimals?: number;
  suffix?: string;
  onReset?: () => void;
  resetDisabled?: boolean;
  disabled?: boolean;
  centeredFill?: boolean;
}) {
  const clampValue = useCallback(
    (candidate: number) => Math.min(max, Math.max(min, candidate)),
    [max, min],
  );

  const [draft, setDraft] = useState(() => formatInputNumber(value, decimals));
  const [sliderValue, setSliderValue] = useState(() => clampValue(value));
  const [isSliding, setIsSliding] = useState(false);
  const [sliderInstanceKey, setSliderInstanceKey] = useState(0);
  const pendingLiveValueRef = useRef<number | null>(null);
  const liveCommitFrameRef = useRef<number | null>(null);

  useEffect(() => {
    setDraft(formatInputNumber(value, decimals));
  }, [decimals, value]);

  useEffect(() => {
    if (!isSliding) {
      const nextValue = clampValue(value);
      setSliderValue(nextValue);
      setSliderInstanceKey((current) => current + 1);
    }
  }, [clampValue, isSliding, value]);

  const flushLiveCommit = useCallback(() => {
    liveCommitFrameRef.current = null;
    const pendingValue = pendingLiveValueRef.current;
    if (pendingValue == null) {
      return;
    }
    pendingLiveValueRef.current = null;
    onCommit(pendingValue);
  }, [onCommit]);

  const queueLiveCommit = useCallback(
    (nextValue: number) => {
      pendingLiveValueRef.current = nextValue;
      if (liveCommitFrameRef.current != null || typeof window === "undefined") {
        return;
      }
      liveCommitFrameRef.current = window.requestAnimationFrame(flushLiveCommit);
    },
    [flushLiveCommit],
  );

  useEffect(() => {
    return () => {
      if (liveCommitFrameRef.current != null && typeof window !== "undefined") {
        window.cancelAnimationFrame(liveCommitFrameRef.current);
      }
    };
  }, []);

  const commitDraft = useCallback(() => {
    if (disabled) {
      setDraft(formatInputNumber(value, decimals));
      setSliderValue(clampValue(value));
      return;
    }

    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(formatInputNumber(value, decimals));
      setSliderValue(clampValue(value));
      return;
    }

    const nextValue = clampValue(parsed);
    setDraft(formatInputNumber(nextValue, decimals));
    setSliderValue(nextValue);
    onCommit(nextValue);
  }, [clampValue, decimals, disabled, draft, onCommit, value]);

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-foreground">{title}</div>
          {subtitle ? <div className="text-[11px] text-muted-foreground">{subtitle}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <div className="relative w-24">
            <Input
              type="number"
              value={draft}
              min={min}
              max={max}
              step={inputStep}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  setDraft(formatInputNumber(value, decimals));
                  event.currentTarget.blur();
                }
              }}
              className="h-8 rounded border border-border bg-background px-2 py-1 pr-7 text-right text-xs text-foreground"
            />
            {suffix ? (
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
                {suffix}
              </span>
            ) : null}
          </div>
          {onReset ? (
            <PropertyResetButton onClick={onReset} disabled={disabled || resetDisabled} />
          ) : null}
        </div>
      </div>
      <Slider
        key={sliderInstanceKey}
        defaultValue={[sliderValue]}
        min={min}
        max={max}
        centeredFill={centeredFill}
        gradientFill
        disabled={disabled}
        {...(typeof sliderStep === "number" ? { step: sliderStep } : {})}
        onValueChange={(values) => {
          const nextValue = values[0];
          if (typeof nextValue === "number") {
            const clampedValue = clampValue(nextValue);
            setIsSliding(true);
            if (liveCommitOnSlide) {
              queueLiveCommit(clampedValue);
            }
          }
        }}
        onValueCommit={(values) => {
          const nextValue = values[0];
          if (typeof nextValue === "number") {
            const clampedValue = clampValue(nextValue);
            setIsSliding(false);
            setSliderValue(clampedValue);
            setDraft(formatInputNumber(clampedValue, decimals));
            pendingLiveValueRef.current = null;
            if (liveCommitFrameRef.current != null && typeof window !== "undefined") {
              window.cancelAnimationFrame(liveCommitFrameRef.current);
              liveCommitFrameRef.current = null;
            }
            onCommit(clampedValue);
          }
        }}
      />
    </div>
  );
}

export function PropertiesPanel() {
  const panelRef = useRef<HTMLDivElement | null>(null);
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
  const [activeClipTab, setActiveClipTab] = useState<"timeline" | "transform" | "adjust" | "effects">(
    "timeline",
  );
  const [libraryAssets, setLibraryAssets] = useState<ComposerAsset[]>([]);
  const [lutAssets, setLutAssets] = useState<ComposerLutAsset[]>([]);
  const [lutLoading, setLutLoading] = useState(false);
  const [panelWidth, setPanelWidth] = useState(PROPERTIES_TWO_COLUMN_BREAKPOINT);
  const projectBackgroundColor = normalizeProjectBackgroundColor(project.backgroundColor);
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
  const maxDurationByTrack = useMemo(
    () =>
      selectedClip && nextClip
        ? Math.max(MIN_CLIP_DURATION, nextClip.startTime - selectedClip.startTime)
        : Number.POSITIVE_INFINITY,
    [nextClip, selectedClip],
  );
  const selectedClipSourceVisibleDuration = useMemo(
    () =>
      selectedClip ? selectedClip.duration * Math.max(selectedClip.speed, 0.1) : 0,
    [selectedClip],
  );
  const selectedAdjustments = useMemo(
    () => (selectedClip ? normalizeClipAdjustments(selectedClip.adjustments) : null),
    [selectedClip],
  );
  const selectedClipAsset = useMemo(
    () => findAssetForClip(selectedClip, libraryAssets),
    [libraryAssets, selectedClip],
  );
  const [draftEffects, setDraftEffects] = useState({
    noise: 0,
    vignette: 0,
    maskEnabled: false,
  });
  const supportsLutAdjustments = selectedClip ? !isSvgClip(selectedClip) : false;
  const supportsClipVolume = selectedClip
    ? supportsVolumeControl(selectedClip) ||
      selectedClipAsset?.type === "audio" ||
      selectedClipAsset?.hasAudio === true
    : false;
  const useTwoColumns = panelWidth > PROPERTIES_TWO_COLUMN_BREAKPOINT;
  const twoColumnGridClass = useMemo(
    () => cn("grid gap-y-2", useTwoColumns ? "grid-cols-2 gap-x-6" : "grid-cols-1"),
    [useTwoColumns],
  );
  const timelineHeaderGridClass = useMemo(
    () => cn("grid gap-y-2", useTwoColumns ? "grid-cols-3 gap-x-6" : "grid-cols-1"),
    [useTwoColumns],
  );
  const defaultDuration = useMemo(() => {
    if (!selectedClip) {
      return MIN_CLIP_DURATION;
    }

    if (!sourceTrimEditable) {
      return selectedClip.duration;
    }

    return normalizeTime(
      Math.max(
        MIN_CLIP_DURATION,
        Math.min(selectedClipSourceVisibleDuration, maxDurationByTrack),
      ),
    );
  }, [maxDurationByTrack, selectedClip, selectedClipSourceVisibleDuration, sourceTrimEditable]);
  const defaultSpeed = useMemo(() => {
    if (!sourceTrimEditable) {
      return selectedClip?.speed ?? 1;
    }

    return Number(
      Math.min(
        8,
        Math.max(0.1, selectedClipSourceVisibleDuration / Math.max(defaultDuration, MIN_CLIP_DURATION)),
      ).toFixed(4),
    );
  }, [defaultDuration, selectedClip?.speed, selectedClipSourceVisibleDuration, sourceTrimEditable]);
  const halfDurationLimit = useMemo(
    () =>
      selectedClip
        ? Number(Math.max(0.01, selectedClip.duration * 0.5).toFixed(2))
        : 0.01,
    [selectedClip],
  );

  const loadLuts = useCallback(async () => {
    if (!project.id) {
      setLutAssets([]);
      return;
    }

    setLutLoading(true);
    try {
      setLutAssets(await composerLutIpc.list({ projectId: project.id }));
    } finally {
      setLutLoading(false);
    }
  }, [project.id]);

  const loadLibraryAssets = useCallback(async () => {
    if (!project.id) {
      setLibraryAssets([]);
      return;
    }

    try {
      setLibraryAssets(await composerAssetIpc.list({ projectId: project.id }));
    } catch {
      setLibraryAssets((current) => current);
    }
  }, [project.id]);

  useEffect(() => {
    void loadLuts();
  }, [loadLuts]);

  useEffect(() => {
    void loadLibraryAssets();
  }, [loadLibraryAssets]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    const updateWidth = () => setPanelWidth(panel.clientWidth);
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const updateAdjustments = useCallback(
    (patch: ClipAdjustmentsPatch) => {
      if (!selectedClip) {
        return;
      }
      void updateClip(selectedClip.id, { adjustments: patch });
    },
    [selectedClip, updateClip],
  );

  const handleLutImport = useCallback(async () => {
    if (!project.id) {
      return;
    }

    setLutLoading(true);
    try {
      setLutAssets(await composerLutIpc.import({ projectId: project.id }));
    } finally {
      setLutLoading(false);
    }
  }, [project.id]);

  const handleStartCommit = useCallback(
    (value: number) => {
      if (!selectedClip) {
        return;
      }

      void moveClip(
        selectedClip.id,
        resolveTrackStartInSeconds(value, selectedClip.duration, siblingClips),
      );
    },
    [moveClip, selectedClip, siblingClips],
  );

  const handleDurationCommit = useCallback(
    (value: number) => {
      if (!selectedClip) {
        return;
      }

      const desiredDuration = Math.max(MIN_CLIP_DURATION, value);
      if (!sourceTrimEditable) {
        void trimClip(selectedClip.id, {
          startTime: selectedClip.startTime,
          duration: Math.min(desiredDuration, maxDurationByTrack),
          trimStart: 0,
          trimEnd: 0,
        });
        return;
      }

      const minDurationBySpeed = selectedClipSourceVisibleDuration / 8;
      const maxDurationBySpeed = selectedClipSourceVisibleDuration / 0.1;
      const nextDuration = Math.max(
        MIN_CLIP_DURATION,
        Math.min(desiredDuration, maxDurationByTrack, maxDurationBySpeed),
      );
      const clampedDuration = Math.max(nextDuration, minDurationBySpeed || MIN_CLIP_DURATION);
      const nextSpeed = Math.min(
        8,
        Math.max(0.1, selectedClipSourceVisibleDuration / Math.max(clampedDuration, MIN_CLIP_DURATION)),
      );

      void updateClip(selectedClip.id, {
        duration: normalizeTime(clampedDuration),
        speed: Number(nextSpeed.toFixed(4)),
      });
    },
    [
      maxDurationByTrack,
      selectedClip,
      selectedClipSourceVisibleDuration,
      sourceTrimEditable,
      trimClip,
      updateClip,
    ],
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

  const handleSpeedCommit = useCallback(
    (value: number) => {
      if (!selectedClip || !sourceTrimEditable) {
        return;
      }

      const desiredSpeed = Math.min(8, Math.max(0.1, value));
      const desiredDuration = selectedClipSourceVisibleDuration / desiredSpeed;
      const nextDuration = Math.max(
        MIN_CLIP_DURATION,
        Math.min(desiredDuration, maxDurationByTrack),
      );
      const resolvedSpeed = Math.min(
        8,
        Math.max(0.1, selectedClipSourceVisibleDuration / Math.max(nextDuration, MIN_CLIP_DURATION)),
      );

      void updateClip(selectedClip.id, {
        duration: normalizeTime(nextDuration),
        speed: Number(resolvedSpeed.toFixed(4)),
      });
    },
    [
      maxDurationByTrack,
      selectedClip,
      selectedClipSourceVisibleDuration,
      sourceTrimEditable,
      updateClip,
    ],
  );

  useEffect(() => {
    setSelectedDimensionMode(dimensionPreset);
  }, [dimensionPreset]);

  useEffect(() => {
    setActiveClipTab("timeline");
  }, [selectedClip?.id]);

  useEffect(() => {
    setDraftEffects({
      noise: selectedAdjustments?.effects.noise ?? 0,
      vignette: selectedAdjustments?.effects.vignette ?? 0,
      maskEnabled: false,
    });
  }, [
    selectedAdjustments?.effects.noise,
    selectedAdjustments?.effects.vignette,
    selectedClip?.id,
  ]);

  return (
    <div ref={panelRef} className="flex h-full w-full flex-col border-l border-border bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">Properties</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
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
                <div className="rounded border border-border/60 bg-background/70 p-2 text-[11px] text-muted-foreground">
                  Current range: {formatTimelineTime(selectedClip.startTime)} →{" "}
                  {formatTimelineTime(getClipEnd(selectedClip))} on the timeline
                </div>
              </div>
            </div>
            <Tabs
              value={activeClipTab}
              onValueChange={(value) =>
                setActiveClipTab(value as "timeline" | "transform" | "adjust" | "effects")
              }
              className="flex flex-col gap-3"
            >
              <TabsList className="grid h-auto w-full grid-cols-4 bg-muted/30">
                <TabsTrigger value="timeline" className="px-2 py-1.5 text-xs">
                  Timeline
                </TabsTrigger>
                <TabsTrigger value="transform" className="px-2 py-1.5 text-xs">
                  Transform
                </TabsTrigger>
                <TabsTrigger value="adjust" className="px-2 py-1.5 text-xs">
                  Adjust
                </TabsTrigger>
                <TabsTrigger value="effects" className="px-2 py-1.5 text-xs">
                  Effects
                </TabsTrigger>
              </TabsList>

              <TabsContent value="timeline" className="mt-0">
                <PropertySection title="Timeline">
                  <div className="space-y-3">
                    <div className={timelineHeaderGridClass}>
                      <PropertyNumberField
                        label="Start"
                        value={selectedClip.startTime}
                        min={0}
                        step={0.01}
                        onCommit={handleStartCommit}
                      />
                      <PropertyNumberField
                        label="Speed"
                        value={selectedClip.speed}
                        min={0.1}
                        max={8}
                        step={0.05}
                        decimals={2}
                        suffix="x"
                        disabled={!sourceTrimEditable}
                        onReset={() => handleSpeedCommit(1)}
                        resetDisabled={
                          !sourceTrimEditable || Math.abs(selectedClip.speed - defaultSpeed) < 0.0001
                        }
                        onCommit={handleSpeedCommit}
                      />
                      <PropertyNumberField
                        label="Duration"
                        value={selectedClip.duration}
                        min={MIN_CLIP_DURATION}
                        step={0.01}
                        onReset={() => handleDurationCommit(defaultDuration)}
                        resetDisabled={Math.abs(selectedClip.duration - defaultDuration) < 0.0001}
                        onCommit={handleDurationCommit}
                      />
                    </div>
                    <div className={twoColumnGridClass}>
                      <PropertySliderControl
                        title="Trim in"
                        value={selectedClip.trimStart}
                        min={0}
                        max={halfDurationLimit}
                        inputStep={0.01}
                        decimals={2}
                        disabled={!sourceTrimEditable}
                        onReset={() => handleTrimInCommit(0)}
                        resetDisabled={!sourceTrimEditable || Math.abs(selectedClip.trimStart) < 0.0001}
                        onCommit={handleTrimInCommit}
                      />
                      <PropertySliderControl
                        title="Trim out"
                        value={trimOut}
                        min={0}
                        max={halfDurationLimit}
                        inputStep={0.01}
                        decimals={2}
                        disabled={!sourceTrimEditable}
                        onReset={() => handleTrimOutCommit(0)}
                        resetDisabled={!sourceTrimEditable || Math.abs(trimOut) < 0.0001}
                        onCommit={handleTrimOutCommit}
                      />
                    </div>
                    <div className={twoColumnGridClass}>
                      <PropertySliderControl
                        title="Fade in"
                        value={selectedClip.fadeInDuration}
                        min={0}
                        max={halfDurationLimit}
                        inputStep={0.01}
                        decimals={2}
                        onReset={() => void updateClip(selectedClip.id, { fadeInDuration: 0 })}
                        resetDisabled={Math.abs(selectedClip.fadeInDuration) < 0.0001}
                        onCommit={(value) =>
                          void updateClip(selectedClip.id, {
                            fadeInDuration: Math.max(0, value),
                          })
                        }
                      />
                      <PropertySliderControl
                        title="Fade out"
                        value={selectedClip.fadeOutDuration}
                        min={0}
                        max={halfDurationLimit}
                        inputStep={0.01}
                        decimals={2}
                        onReset={() => void updateClip(selectedClip.id, { fadeOutDuration: 0 })}
                        resetDisabled={Math.abs(selectedClip.fadeOutDuration) < 0.0001}
                        onCommit={(value) =>
                          void updateClip(selectedClip.id, {
                            fadeOutDuration: Math.max(0, value),
                          })
                        }
                      />
                    </div>
                    {supportsClipVolume ? (
                      <PropertySliderControl
                        title="Volume"
                        actions={
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 px-2 text-xs"
                            onClick={() =>
                              void updateClip(selectedClip.id, {
                                volume: 0,
                              })
                            }
                            disabled={isClipMutedByProperties(selectedClip)}
                          >
                            <VolumeX className="mr-1 h-3.5 w-3.5" />
                            Mute
                          </Button>
                        }
                        value={selectedClip.volume * 100}
                        min={0}
                        max={100}
                        inputStep={1}
                        decimals={0}
                        suffix="%"
                        onReset={() =>
                          void updateClip(selectedClip.id, {
                            volume: 1,
                          })
                        }
                        resetDisabled={Math.abs(selectedClip.volume - 1) < 0.0001}
                        onCommit={(value) =>
                          void updateClip(selectedClip.id, {
                            volume: Math.min(1, Math.max(0, value / 100)),
                          })
                        }
                      />
                    ) : null}
                  </div>
                  {!sourceTrimEditable ? (
                    <div className="mt-3 text-[11px] text-muted-foreground">
                      Still images do not expose source trim in/out or speed in the current clip model.
                    </div>
                  ) : null}
                </PropertySection>
              </TabsContent>

              <TabsContent value="transform" className="mt-0">
                {isVisualClip ? (
                  <PropertySection title="Transform">
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <div className="text-[11px] font-medium text-muted-foreground">Position</div>
                        <div className={twoColumnGridClass}>
                          <PropertyNumberField
                            label="X"
                            value={selectedClip.transformOffsetX}
                            step={1}
                            decimals={2}
                            onCommit={(value) =>
                              void updateClip(selectedClip.id, {
                                transformOffsetX: value,
                              })
                            }
                          />
                          <PropertyNumberField
                            label="Y"
                            value={selectedClip.transformOffsetY}
                            step={1}
                            decimals={2}
                            onCommit={(value) =>
                              void updateClip(selectedClip.id, {
                                transformOffsetY: value,
                              })
                            }
                          />
                        </div>
                      </div>

                      <PropertySliderControl
                        title="Scale"
                        subtitle="Uniform"
                        value={selectedClip.transformScale * 100}
                        min={10}
                        max={400}
                        inputStep={1}
                        liveCommitOnSlide
                        decimals={2}
                        suffix="%"
                        onReset={() =>
                          void updateClip(selectedClip.id, {
                            transformScale: 1,
                          })
                        }
                        resetDisabled={Math.abs(selectedClip.transformScale - 1) < 0.0001}
                        onCommit={(value) =>
                          void updateClip(selectedClip.id, {
                            transformScale: Math.max(0.1, value / 100),
                          })
                        }
                      />

                      <PropertySliderControl
                        title="Rotation"
                        value={selectedClip.rotationZ}
                        min={-360}
                        max={360}
                        centeredFill
                        inputStep={0.1}
                        liveCommitOnSlide
                        decimals={2}
                        suffix="°"
                        onReset={() => void updateClip(selectedClip.id, { rotationZ: 0 })}
                        resetDisabled={Math.abs(selectedClip.rotationZ) < 0.0001}
                        onCommit={(value) =>
                          void updateClip(selectedClip.id, { rotationZ: value })
                        }
                      />

                      <div className="space-y-2">
                        <div className="text-foreground">Flip</div>
                        <div className={twoColumnGridClass}>
                          <Button
                            type="button"
                            variant={selectedClip.flipHorizontal ? "secondary" : "outline"}
                            size="sm"
                            className="h-8 gap-1 px-2"
                            onClick={() =>
                              void updateClip(selectedClip.id, {
                                flipHorizontal: !selectedClip.flipHorizontal,
                              })
                            }
                          >
                            <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" />
                            Horizontal
                          </Button>
                          <Button
                            type="button"
                            variant={selectedClip.flipVertical ? "secondary" : "outline"}
                            size="sm"
                            className="h-8 gap-1 px-2"
                            onClick={() =>
                              void updateClip(selectedClip.id, {
                                flipVertical: !selectedClip.flipVertical,
                              })
                            }
                          >
                            <ArrowUpDown className="h-3.5 w-3.5 shrink-0" />
                            Vertical
                          </Button>
                        </div>
                      </div>
                    </div>
                  </PropertySection>
                ) : (
                  <PropertySection title="Transform">
                    <div className="text-muted-foreground">
                      Transform properties are only available for visual clips.
                    </div>
                  </PropertySection>
                )}
              </TabsContent>

              <TabsContent value="adjust" className="mt-0">
                {isVisualClip ? (
                  <PropertySection title="Adjust">
                    <div className="space-y-3">
                      <PropertySliderControl
                        title="Opacity"
                        value={selectedClip.opacity * 100}
                        min={0}
                        max={100}
                        inputStep={1}
                        liveCommitOnSlide
                        decimals={0}
                        suffix="%"
                        onReset={() =>
                          void updateClip(selectedClip.id, {
                            opacity: 1,
                          })
                        }
                        resetDisabled={Math.abs(selectedClip.opacity - 1) < 0.0001}
                        onCommit={(value) =>
                          void updateClip(selectedClip.id, {
                            opacity: Math.min(1, Math.max(0, value / 100)),
                          })
                        }
                      />

                      <label className="flex w-full flex-col gap-1">
                        <span className="text-foreground">Blend mode</span>
                        <select
                          className="h-8 w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                          value={selectedAdjustments?.blendMode ?? "normal"}
                          onChange={(event) =>
                            updateAdjustments({
                              blendMode: event.target.value as ClipBlendMode,
                            })
                          }
                        >
                          {BLEND_MODE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      {supportsLutAdjustments ? (
                        <div className="space-y-2">
                          <div className="text-[11px] font-medium text-muted-foreground">LUT</div>
                          <div className="flex items-center gap-2">
                            <select
                              className="h-8 min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                              value={selectedAdjustments?.lutAssetId ?? ""}
                              onChange={(event) =>
                                updateAdjustments({
                                  lutAssetId: event.target.value || null,
                                })
                              }
                            >
                              <option value="">None</option>
                              {lutAssets.map((lut) => (
                                <option key={lut.id} value={lut.id}>
                                  {lut.fileName}
                                </option>
                              ))}
                            </select>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 px-2"
                              onClick={() => void loadLuts()}
                              disabled={lutLoading}
                            >
                              {lutLoading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 gap-1 px-2"
                              onClick={() => void handleLutImport()}
                              disabled={lutLoading}
                            >
                              <Upload className="h-3.5 w-3.5" />
                              Import
                            </Button>
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            LUT files are stored per project in <code>assets\luts</code>.
                          </div>
                        </div>
                      ) : null}

                      <div className="space-y-2">
                        <div className="text-[11px] font-medium text-muted-foreground">
                          Color correction
                        </div>
                        <div className={twoColumnGridClass}>
                          <PropertySliderControl
                            title="Hue"
                            value={selectedAdjustments?.colorCorrection.hue ?? 0}
                            min={-180}
                            max={180}
                            centeredFill
                            inputStep={1}
                            liveCommitOnSlide
                            decimals={0}
                            onReset={() =>
                              updateAdjustments({
                                colorCorrection: { hue: 0 },
                              })
                            }
                            resetDisabled={Math.abs(selectedAdjustments?.colorCorrection.hue ?? 0) < 0.0001}
                            onCommit={(value) =>
                              updateAdjustments({
                                colorCorrection: { hue: value },
                              })
                            }
                          />
                          <PropertySliderControl
                            title="Saturation"
                            value={selectedAdjustments?.colorCorrection.saturation ?? 0}
                            min={-100}
                            max={100}
                            centeredFill
                            inputStep={1}
                            liveCommitOnSlide
                            decimals={0}
                            onReset={() =>
                              updateAdjustments({
                                colorCorrection: { saturation: 0 },
                              })
                            }
                            resetDisabled={Math.abs(selectedAdjustments?.colorCorrection.saturation ?? 0) < 0.0001}
                            onCommit={(value) =>
                              updateAdjustments({
                                colorCorrection: { saturation: value },
                              })
                            }
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[11px] font-medium text-muted-foreground">
                          Lightness correction
                        </div>
                        <div className={twoColumnGridClass}>
                          <PropertySliderControl
                            title="Exposure"
                            value={selectedAdjustments?.lightnessCorrection.exposure ?? 0}
                            min={-100}
                            max={100}
                            centeredFill
                            inputStep={1}
                            liveCommitOnSlide
                            decimals={0}
                            onReset={() =>
                              updateAdjustments({
                                lightnessCorrection: { exposure: 0 },
                              })
                            }
                            resetDisabled={Math.abs(selectedAdjustments?.lightnessCorrection.exposure ?? 0) < 0.0001}
                            onCommit={(value) =>
                              updateAdjustments({
                                lightnessCorrection: { exposure: value },
                              })
                            }
                          />
                          <PropertySliderControl
                            title="Contrast"
                            value={selectedAdjustments?.lightnessCorrection.contrast ?? 0}
                            min={-100}
                            max={100}
                            centeredFill
                            inputStep={1}
                            liveCommitOnSlide
                            decimals={0}
                            onReset={() =>
                              updateAdjustments({
                                lightnessCorrection: { contrast: 0 },
                              })
                            }
                            resetDisabled={Math.abs(selectedAdjustments?.lightnessCorrection.contrast ?? 0) < 0.0001}
                            onCommit={(value) =>
                              updateAdjustments({
                                lightnessCorrection: { contrast: value },
                              })
                            }
                          />
                          <PropertySliderControl
                            title="Gain"
                            value={selectedAdjustments?.lightnessCorrection.gain ?? 0}
                            min={-100}
                            max={100}
                            centeredFill
                            inputStep={1}
                            liveCommitOnSlide
                            decimals={0}
                            onReset={() =>
                              updateAdjustments({
                                lightnessCorrection: { gain: 0 },
                              })
                            }
                            resetDisabled={Math.abs(selectedAdjustments?.lightnessCorrection.gain ?? 0) < 0.0001}
                            onCommit={(value) =>
                              updateAdjustments({
                                lightnessCorrection: { gain: value },
                              })
                            }
                          />
                          <PropertySliderControl
                            title="Gamma"
                            value={selectedAdjustments?.lightnessCorrection.gamma ?? 0}
                            min={-100}
                            max={100}
                            centeredFill
                            inputStep={1}
                            liveCommitOnSlide
                            decimals={0}
                            onReset={() =>
                              updateAdjustments({
                                lightnessCorrection: { gamma: 0 },
                              })
                            }
                            resetDisabled={Math.abs(selectedAdjustments?.lightnessCorrection.gamma ?? 0) < 0.0001}
                            onCommit={(value) =>
                              updateAdjustments({
                                lightnessCorrection: { gamma: value },
                              })
                            }
                          />
                          <PropertySliderControl
                            title="Offset"
                            value={selectedAdjustments?.lightnessCorrection.offset ?? 0}
                            min={-100}
                            max={100}
                            centeredFill
                            inputStep={1}
                            liveCommitOnSlide
                            decimals={0}
                            onReset={() =>
                              updateAdjustments({
                                lightnessCorrection: { offset: 0 },
                              })
                            }
                            resetDisabled={Math.abs(selectedAdjustments?.lightnessCorrection.offset ?? 0) < 0.0001}
                            onCommit={(value) =>
                              updateAdjustments({
                                lightnessCorrection: { offset: value },
                              })
                            }
                          />
                        </div>
                      </div>

                    </div>
                  </PropertySection>
                ) : (
                  <PropertySection title="Adjust">
                    <div className="text-muted-foreground">
                      Adjustment properties are only available for visual clips.
                    </div>
                  </PropertySection>
                )}
              </TabsContent>

              <TabsContent value="effects" className="mt-0">
                {isVisualClip ? (
                  <PropertySection title="Effects">
                    <div className="space-y-3">
                      <PropertySliderControl
                        title="Blur"
                        value={selectedAdjustments?.effects.blur ?? 0}
                        min={0}
                        max={50}
                        inputStep={0.1}
                        liveCommitOnSlide
                        decimals={1}
                        suffix="px"
                        onReset={() =>
                          updateAdjustments({
                            effects: { blur: 0 },
                          })
                        }
                        resetDisabled={Math.abs(selectedAdjustments?.effects.blur ?? 0) < 0.0001}
                        onCommit={(value) =>
                          updateAdjustments({
                            effects: { blur: Math.min(50, Math.max(0, value)) },
                          })
                        }
                      />

                      <div className={twoColumnGridClass}>
                        <PropertySliderControl
                          title="Sharpen"
                          subtitle="Live preview spike"
                          value={selectedAdjustments?.effects.sharpen ?? 0}
                          min={0}
                          max={200}
                          inputStep={1}
                          liveCommitOnSlide
                          decimals={0}
                          onReset={() =>
                            updateAdjustments({
                              effects: { sharpen: 0 },
                            })
                          }
                          resetDisabled={Math.abs(selectedAdjustments?.effects.sharpen ?? 0) < 0.0001}
                          onCommit={(value) =>
                            updateAdjustments({
                              effects: { sharpen: Math.min(200, Math.max(0, value)) },
                            })
                          }
                        />
                        <PropertySliderControl
                          title={
                            <span className="inline-flex items-center gap-1">
                              <span>Noise</span>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex cursor-help text-amber-500">
                                    <AlertTriangle className="h-3.5 w-3.5" />
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-56 text-xs">
                                  Noise is only visible on pause, full preview, and final render.
                                </TooltipContent>
                              </Tooltip>
                            </span>
                          }
                          value={selectedAdjustments?.effects.noise ?? 0}
                          min={0}
                          max={100}
                          inputStep={1}
                          liveCommitOnSlide
                          decimals={0}
                          onReset={() =>
                            updateAdjustments({
                              effects: { noise: 0 },
                            })
                          }
                          resetDisabled={Math.abs(selectedAdjustments?.effects.noise ?? 0) < 0.0001}
                          onCommit={(value) =>
                            updateAdjustments({
                              effects: { noise: Math.min(100, Math.max(0, value)) },
                            })
                          }
                        />
                        <PropertySliderControl
                          title="Vignette"
                          subtitle="UI only for now"
                          value={draftEffects.vignette}
                          min={0}
                          max={100}
                          inputStep={1}
                          decimals={0}
                          onReset={() =>
                            setDraftEffects((current) => ({
                              ...current,
                              vignette: selectedAdjustments?.effects.vignette ?? 0,
                            }))
                          }
                          resetDisabled={Math.abs(draftEffects.vignette) < 0.0001}
                          onCommit={(value) =>
                            setDraftEffects((current) => ({
                              ...current,
                              vignette: Math.min(100, Math.max(0, value)),
                            }))
                          }
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="text-[11px] font-medium text-muted-foreground">Mask</div>
                        <div className="rounded border border-dashed border-border/70 bg-background/60 p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="space-y-1">
                              <div className="text-foreground">Mask</div>
                              <div className="text-[11px] text-muted-foreground">
                                UI scaffold only for now. Backend wiring will come next.
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant={draftEffects.maskEnabled ? "secondary" : "outline"}
                              size="sm"
                              className="h-8 px-3"
                              onClick={() =>
                                setDraftEffects((current) => ({
                                  ...current,
                                  maskEnabled: !current.maskEnabled,
                                }))
                              }
                            >
                              {draftEffects.maskEnabled ? "Mask enabled" : "Enable mask"}
                            </Button>
                          </div>
                        </div>
                      </div>

                      <div className="text-[11px] text-muted-foreground">
                        Sharpen and Noise are now wired for live preview and sequence
                        preview. Vignette and Mask remain UI-only for now and are not yet
                        persisted to the project.
                      </div>
                    </div>
                  </PropertySection>
                ) : (
                  <PropertySection title="Effects">
                    <div className="text-muted-foreground">
                      Effect properties are only available for visual clips.
                    </div>
                  </PropertySection>
                )}
              </TabsContent>
            </Tabs>

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
                  step={0.1}
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

              <div className="flex flex-col gap-1">
                <span className="text-foreground">Background</span>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={projectBackgroundColor}
                    aria-label="Project background color"
                    onChange={(event) => {
                      const backgroundColor = normalizeProjectBackgroundColor(event.target.value);
                      void composerProjectIpc
                        .save({ id: project.id, backgroundColor })
                        .then(() => patchCurrentProject({ backgroundColor }))
                        .catch(() => undefined);
                    }}
                    className="h-8 w-10 cursor-pointer rounded border border-border bg-background p-1"
                  />
                  <Input
                    value={projectBackgroundColor.toUpperCase()}
                    readOnly
                    className="h-8 font-mono text-xs"
                  />
                </div>
              </div>
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
    </div>
  );
}
