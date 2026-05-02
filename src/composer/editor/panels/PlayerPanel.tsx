import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  CircleGauge,
  LoaderCircle,
  Maximize2,
  MonitorSmartphone,
  Pause,
  Play,
  Music2,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  composerAssetIpc,
  composerProjectIpc,
} from "@/composer/ipc/ipc-client";
import { useComposerProjectStore } from "@/composer/stores/project.store";
import type {
  ComposerAsset,
  ComposerPlaybackQuality,
} from "@/composer/types/project";
import { useComposerRuntime } from "../context/ComposerRuntimeContext";
import { formatTimelineTime } from "../utils/timeline";
import {
  clamp,
  getCenter,
  getProjectScaledRect,
  getTransformedRect,
  snapRectToFrame,
  type Rect,
  type Size,
  type SnapGuides,
} from "../utils/playerTransform";
import { cn } from "@/lib/utils";

function getClipLocalTime(
  playhead: number,
  clipStart: number,
  trimStart: number,
): number {
  return Math.max(0, playhead - clipStart + trimStart);
}

function syncMediaElementTime(
  element: HTMLMediaElement,
  targetTime: number,
  threshold: number,
) {
  if (
    !Number.isFinite(element.currentTime) ||
    Math.abs(element.currentTime - targetTime) > threshold
  ) {
    element.currentTime = targetTime;
  }
}

function handoffMediaElementPlayback(
  element: HTMLMediaElement,
  targetTime: number,
  threshold: number,
): () => void {
  const resumePlayback = () => {
    if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
      return;
    }

    syncMediaElementTime(element, targetTime, threshold);
    void element.play().catch(() => undefined);
  };

  const handleLoadedMetadata = () => {
    resumePlayback();
  };

  element.addEventListener("loadedmetadata", handleLoadedMetadata);
  resumePlayback();

  return () => {
    element.removeEventListener("loadedmetadata", handleLoadedMetadata);
  };
}

type ResizeHandle = "nw" | "ne" | "se" | "sw";

type PlaybackQuality = ComposerPlaybackQuality;
type Point = { x: number; y: number };

function getHandleDirection(handle: ResizeHandle): Point {
  switch (handle) {
    case "nw":
      return { x: -1, y: -1 };
    case "ne":
      return { x: 1, y: -1 };
    case "se":
      return { x: 1, y: 1 };
    case "sw":
      return { x: -1, y: 1 };
  }
}

function rotatePoint(point: Point, radians: number): Point {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

function getRotatedOppositeCornerAnchor(
  rect: Rect,
  handle: ResizeHandle,
  rotationDegrees: number,
): Point {
  const direction = getHandleDirection(handle);
  const center = getCenter(rect);
  const oppositeCornerOffset = rotatePoint(
    {
      x: (-direction.x * rect.width) / 2,
      y: (-direction.y * rect.height) / 2,
    },
    (rotationDegrees * Math.PI) / 180,
  );

  return {
    x: center.x + oppositeCornerOffset.x,
    y: center.y + oppositeCornerOffset.y,
  };
}

function normalizeHalfTurnAngle(angle: number): number {
  const normalized = angle % 180;
  return normalized < 0 ? normalized + 180 : normalized;
}

function getHandleResizeCursor(
  handle: ResizeHandle,
  rotationDegrees: number,
): string {
  const baseAngle = handle === "ne" || handle === "sw" ? 45 : 135;
  const angle = normalizeHalfTurnAngle(baseAngle + rotationDegrees);

  if (angle < 22.5 || angle >= 157.5) {
    return "ew-resize";
  }
  if (angle < 67.5) {
    return "nesw-resize";
  }
  if (angle < 112.5) {
    return "ns-resize";
  }
  return "nwse-resize";
}

const PLAYBACK_QUALITIES: Array<{
  value: PlaybackQuality;
  label: string;
  menuLabel: string;
  description: string;
}> = [
  {
    value: "full",
    label: "Full",
    menuLabel: "Full quality",
    description: "Always use the canonical source",
  },
  {
    value: "high",
    label: "High",
    menuLabel: "High quality",
    description: "Use the High sequence preview when it is ready",
  },
  {
    value: "med",
    label: "Med",
    menuLabel: "Medium quality",
    description: "Use the Medium sequence preview when it is ready",
  },
  {
    value: "low",
    label: "Low",
    menuLabel: "Low quality",
    description: "Use the Low sequence preview when it is ready",
  },
];

type EditInteraction =
  | {
      type: "move";
      originX: number;
      originY: number;
      startRect: Rect;
    }
  | {
      type: "resize";
      handle: ResizeHandle;
      originX: number;
      originY: number;
      startRect: Rect;
      anchorPoint: Point;
    };

function isImagePath(path: string | null | undefined): boolean {
  return path?.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i) != null;
}

function getCanonicalSourcePath(
  clip: { sourcePath: string | null } | null,
  asset: ComposerAsset | null,
): string | null {
  return asset?.workingPath ?? clip?.sourcePath ?? asset?.filePath ?? null;
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

function getProjectRatioLabel(width: number, height: number): string {
  const ratio = width / height;
  const preset = [
    { ratio: 16 / 9, label: "16:9" },
    { ratio: 9 / 16, label: "9:16" },
    { ratio: 1, label: "1:1" },
    { ratio: 4 / 3, label: "4:3" },
    { ratio: 3 / 2, label: "3:2" },
    { ratio: 2.39, label: "2.39:1" },
    { ratio: 1.85, label: "1.85:1" },
  ].find((entry) => Math.abs(entry.ratio - ratio) < 0.02);

  return preset?.label ?? `${ratio.toFixed(2)}:1`;
}

export function PlayerPanel() {
  const patchCurrentProject = useComposerProjectStore(
    (state) => state.patchCurrentProject,
  );
  const {
    project,
    tracks,
    playhead,
    pendingSequencePlaybackStartTime,
    isPlaying,
    isPlaybackWaiting,
    previewAsset,
    selectedVisualClip,
    activeVisualClip,
    syncPlaybackToMediaClock,
    setPlaybackClockSource,
    togglePlayback,
    stopPlayback,
    getAssetUrl,
    previewLibraryAsset,
    updateClipTransform,
  } = useComposerRuntime();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerZoomControlRef = useRef<HTMLDivElement | null>(null);

  const [frameSize, setFrameSize] = useState<Size | null>(null);
  const [mediaSize, setMediaSize] = useState<Size | null>(null);
  const [interaction, setInteraction] = useState<EditInteraction | null>(null);
  const [draftRect, setDraftRect] = useState<Rect | null>(null);
  const [guides, setGuides] = useState<SnapGuides>({
    vertical: [],
    horizontal: [],
  });
  const [showPlayerZoom, setShowPlayerZoom] = useState(false);
  const [playerZoom, setPlayerZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [libraryAssets, setLibraryAssets] = useState<ComposerAsset[]>([]);
  const playbackQuality = project.playbackQuality ?? "med";

  const handlePlaybackQualityChange = useCallback(
    async (value: string) => {
      const nextPlaybackQuality = value as PlaybackQuality;
      if (nextPlaybackQuality === playbackQuality) {
        return;
      }

      const previousPlaybackQuality = playbackQuality;
      patchCurrentProject({ playbackQuality: nextPlaybackQuality });

      try {
        await composerProjectIpc.save({
          id: project.id,
          playbackQuality: nextPlaybackQuality,
        });
      } catch {
        patchCurrentProject({ playbackQuality: previousPlaybackQuality });
      }
    },
    [patchCurrentProject, playbackQuality, project.id],
  );

  const loadLibraryAssets = useCallback(async () => {
    try {
      const nextAssets = await composerAssetIpc.list({ projectId: project.id });
      setLibraryAssets(nextAssets);
    } catch {
      setLibraryAssets((current) => current);
    }
  }, [project.id]);

  useEffect(() => {
    void loadLibraryAssets();
  }, [loadLibraryAssets]);

  useEffect(() => {
    if (!project.id) {
      return;
    }

    const shouldPollAssets =
      isPlaying || libraryAssets.some((asset) => asset.status === "processing");
    if (!shouldPollAssets) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadLibraryAssets();
    }, 2000);
    return () => window.clearInterval(intervalId);
  }, [isPlaying, libraryAssets, loadLibraryAssets, project.id]);

  const livePreviewAsset = useMemo(
    () =>
      previewAsset
        ? (libraryAssets.find((asset) => asset.id === previewAsset.id) ??
          previewAsset)
        : null,
    [libraryAssets, previewAsset],
  );
  const sequencePreview = project.sequencePreview;
  const sequencePreviewUrl = useMemo(
    () => getAssetUrl(sequencePreview.filePath),
    [getAssetUrl, sequencePreview.filePath],
  );
  const isSequencePreviewReady =
    sequencePreview.status === "ready" &&
    Boolean(sequencePreview.filePath) &&
    Boolean(sequencePreviewUrl);
  const isSequencePlaybackActive =
    !previewAsset && isPlaying && isSequencePreviewReady;
  const visualClip = useMemo(
    () =>
      !previewAsset && !isSequencePlaybackActive
        ? isPlaying
          ? activeVisualClip
          : (selectedVisualClip ?? activeVisualClip)
        : null,
    [
      activeVisualClip,
      isPlaying,
      isSequencePlaybackActive,
      previewAsset,
      selectedVisualClip,
    ],
  );
  const visualAsset = useMemo(
    () => findAssetForClip(visualClip, libraryAssets),
    [libraryAssets, visualClip],
  );
  const canonicalVisualPath = useMemo(
    () => getCanonicalSourcePath(visualClip, visualAsset),
    [visualAsset, visualClip],
  );
  const canonicalVisualUrl = useMemo(
    () => getAssetUrl(canonicalVisualPath),
    [canonicalVisualPath, getAssetUrl],
  );
  const previewAssetUrl = useMemo(
    () =>
      getAssetUrl(
        livePreviewAsset?.workingPath ?? livePreviewAsset?.filePath ?? null,
      ),
    [getAssetUrl, livePreviewAsset?.filePath, livePreviewAsset?.workingPath],
  );
  const tracksById = useMemo(
    () => new Map(tracks.map((track) => [track.id, track])),
    [tracks],
  );
  const projectFrameStyle = useMemo(
    () => ({
      aspectRatio: `${project.width} / ${project.height}`,
      width: project.width >= project.height ? "100%" : "auto",
      height: project.width >= project.height ? "auto" : "100%",
      maxWidth: "100%",
      maxHeight: "100%",
    }),
    [project.height, project.width],
  );
  const projectRatioLabel = useMemo(
    () => getProjectRatioLabel(project.width, project.height),
    [project.height, project.width],
  );
  const isPreviewVisualAsset =
    livePreviewAsset?.type === "image" || livePreviewAsset?.type === "video";
  const effectivePlayerZoom = previewAsset ? 1 : playerZoom;
  const activeFrameStyle =
    previewAsset && isPreviewVisualAsset
      ? {
          width: "100%",
          height: "100%",
          maxWidth: "100%",
          maxHeight: "100%",
        }
      : projectFrameStyle;
  const selectedPlaybackQuality = useMemo(
    () =>
      PLAYBACK_QUALITIES.find((quality) => quality.value === playbackQuality) ??
      PLAYBACK_QUALITIES[2],
    [playbackQuality],
  );
  const visualTrackMuted = visualClip
    ? (tracksById.get(visualClip.trackId)?.muted ?? false)
    : false;
  const playbackSourceBadge = useMemo(() => {
    if (previewAsset) {
      return null;
    }

    if (isSequencePlaybackActive) {
      return `${selectedPlaybackQuality.label} sequence preview`;
    }

    return null;
  }, [
    isPlaybackWaiting,
    isSequencePlaybackActive,
    previewAsset,
    selectedPlaybackQuality.label,
  ]);
  const sequencePreviewHint = useMemo(() => {
    if (previewAsset || !isPlaybackWaiting) {
      return null;
    }

    switch (sequencePreview.status) {
      case "processing":
        return `${selectedPlaybackQuality.menuLabel} is still rendering. Playback will start automatically.`;
      case "stale":
        return `${selectedPlaybackQuality.menuLabel} is stale. Playback will wait for a fresh preview.`;
      case "missing":
        return `${selectedPlaybackQuality.menuLabel} is not available yet. Playback will wait for the generated preview.`;
      case "error":
        return (
          sequencePreview.errorMessage ??
          `${selectedPlaybackQuality.menuLabel} failed to generate. Playback will stay paused until a new preview is ready.`
        );
      default:
        return "Preparing sequence preview…";
    }
  }, [
    isPlaybackWaiting,
    previewAsset,
    selectedPlaybackQuality.menuLabel,
    sequencePreview.errorMessage,
    sequencePreview.status,
  ]);
  const waitingOverlayLabel = useMemo(() => {
    if (!isPlaybackWaiting) {
      return null;
    }

    switch (sequencePreview.status) {
      case "processing":
        return "Rendering sequence preview";
      case "stale":
        return "Refreshing sequence preview";
      case "missing":
        return "Waiting for sequence preview";
      case "error":
        return "Sequence preview unavailable";
      default:
        return "Preparing sequence preview";
    }
  }, [isPlaybackWaiting, sequencePreview.status]);
  const shouldMuteVideoElement = visualTrackMuted;
  const clipPreviewLocalTime = visualClip
    ? getClipLocalTime(playhead, visualClip.startTime, visualClip.trimStart)
    : 0;
  const fadeInFactor =
    visualClip && visualClip.fadeInDuration > 0
      ? clamp(clipPreviewLocalTime / visualClip.fadeInDuration, 0, 1)
      : 1;
  const fadeOutFactor =
    visualClip && visualClip.fadeOutDuration > 0
      ? clamp((visualClip.duration - clipPreviewLocalTime) / visualClip.fadeOutDuration, 0, 1)
      : 1;
  const effectiveVisualOpacity = visualClip
    ? clamp(visualClip.opacity * Math.min(fadeInFactor, fadeOutFactor), 0, 1)
    : 1;
  const mediaMetadataUrl = canonicalVisualUrl;
  const playbackClockMode = useMemo(() => {
    if (!isSequencePlaybackActive || previewAsset) {
      return "timeline";
    }

    return "media";
  }, [isSequencePlaybackActive, previewAsset]);

  const baseRect = useMemo(
    () =>
      frameSize && mediaSize
        ? getProjectScaledRect(mediaSize, frameSize, {
            width: project.width,
            height: project.height,
          })
        : null,
    [frameSize, mediaSize, project.height, project.width],
  );
  const persistedRect = useMemo(
    () =>
      baseRect && frameSize && visualClip
        ? getTransformedRect(
            baseRect,
            frameSize,
            visualClip.transformOffsetX,
            visualClip.transformOffsetY,
            visualClip.transformScale,
          )
        : null,
    [baseRect, frameSize, visualClip],
  );
  const displayedRect = draftRect ?? persistedRect;
  const isTransformMode = Boolean(
    selectedVisualClip &&
    visualClip &&
    selectedVisualClip.id === visualClip.id &&
    !previewAsset &&
    !isPlaying &&
    displayedRect,
  );
  const visualRotationStyle = visualClip
    ? {
        transform: `rotate(${visualClip.rotationZ}deg)`,
        transformOrigin: "center center",
      }
    : undefined;

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (previewAsset) {
      setShowPlayerZoom(false);
    }
  }, [previewAsset]);

  useEffect(() => {
    if (!showPlayerZoom) {
      return;
    }

    const handleMouseDown = (event: MouseEvent) => {
      if (!playerZoomControlRef.current?.contains(event.target as Node)) {
        setShowPlayerZoom(false);
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [showPlayerZoom]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }

    const updateSize = () =>
      setFrameSize({ width: frame.clientWidth, height: frame.clientHeight });

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setDraftRect(null);
    setGuides({ vertical: [], horizontal: [] });
    setMediaSize(null);
  }, [livePreviewAsset?.id, visualClip?.id]);

  useEffect(() => {
    if (!visualClip?.sourcePath || !mediaMetadataUrl || previewAsset) {
      return;
    }

    if (isImagePath(visualClip.sourcePath)) {
      const image = new Image();
      image.onload = () =>
        setMediaSize({
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
      image.src = mediaMetadataUrl;
      return;
    }

    const element = document.createElement("video");
    element.preload = "metadata";
    element.onloadedmetadata = () =>
      setMediaSize({
        width: element.videoWidth,
        height: element.videoHeight,
      });
    element.src = mediaMetadataUrl;
  }, [mediaMetadataUrl, previewAsset, visualClip?.id, visualClip?.sourcePath]);

  useEffect(() => {
    setPlaybackClockSource(playbackClockMode);
  }, [playbackClockMode, setPlaybackClockSource]);

  const readMediaClockTime = useCallback((): number | null => {
    if (
      playbackClockMode !== "media" ||
      previewAsset ||
      !isSequencePlaybackActive
    ) {
      return null;
    }

    const video = videoRef.current;
    if (
      video &&
      sequencePreviewUrl &&
      video.readyState >= HTMLMediaElement.HAVE_METADATA
    ) {
      return video.currentTime;
    }

    return null;
  }, [
    isSequencePlaybackActive,
    playbackClockMode,
    previewAsset,
    sequencePreviewUrl,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !visualClip || !canonicalVisualUrl || previewAsset) {
      return;
    }

    if (isPlaying || isSequencePlaybackActive) {
      return;
    }

    const targetTime = getClipLocalTime(
      playhead,
      visualClip.startTime,
      visualClip.trimStart,
    );
    const syncThreshold = 0.5 / project.fps;
    syncMediaElementTime(video, targetTime, syncThreshold);
  }, [
    isPlaying,
    isSequencePlaybackActive,
    playhead,
    previewAsset,
    project.fps,
    visualClip,
    canonicalVisualUrl,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    const targetTime = pendingSequencePlaybackStartTime ?? playhead;

    if (!isPlaying || previewAsset) {
      video?.pause();
      return;
    }

    if (!video || !isSequencePlaybackActive || !sequencePreviewUrl) {
      return;
    }

    return handoffMediaElementPlayback(video, targetTime, 0.5 / project.fps);
  }, [
    isPlaying,
    isSequencePlaybackActive,
    pendingSequencePlaybackStartTime,
    previewAsset,
    project.fps,
    sequencePreviewUrl,
  ]);

  useEffect(() => {
    if (!isPlaying || previewAsset || playbackClockMode !== "media") {
      return;
    }

    let rafId = 0;
    const tick = () => {
      const clockTime = readMediaClockTime();
      if (clockTime != null) {
        syncPlaybackToMediaClock(clockTime);
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [
    isPlaying,
    playbackClockMode,
    previewAsset,
    readMediaClockTime,
    syncPlaybackToMediaClock,
  ]);

  useEffect(() => {
    if (isPlaying && playhead >= project.duration) {
      stopPlayback(project.duration);
    }
  }, [isPlaying, playhead, project.duration, stopPlayback]);

  useEffect(() => {
    if (!interaction || !displayedRect || !frameSize) {
      return;
    }

    const aspectRatio = displayedRect.width / displayedRect.height;
    const rotationRadians = ((visualClip?.rotationZ ?? 0) * Math.PI) / 180;
    const handleMouseMove = (event: MouseEvent) => {
      const dx = (event.clientX - interaction.originX) / effectivePlayerZoom;
      const dy = (event.clientY - interaction.originY) / effectivePlayerZoom;

      if (interaction.type === "move") {
        const snapped = snapRectToFrame(
          {
            ...interaction.startRect,
            x: interaction.startRect.x + dx,
            y: interaction.startRect.y + dy,
          },
          frameSize,
          10,
        );
        setDraftRect(snapped.rect);
        setGuides(snapped.guides);
        return;
      }

      const startRect = interaction.startRect;
      const handleDirection = getHandleDirection(interaction.handle);
      const diagonal = rotatePoint(
        {
          x: handleDirection.x,
          y: handleDirection.y / aspectRatio,
        },
        rotationRadians,
      );
      const startHandlePoint = {
        x: interaction.anchorPoint.x + diagonal.x * startRect.width,
        y: interaction.anchorPoint.y + diagonal.y * startRect.width,
      };
      const draggedHandlePoint = {
        x: startHandlePoint.x + dx,
        y: startHandlePoint.y + dy,
      };
      const width = Math.max(
        40,
        ((draggedHandlePoint.x - interaction.anchorPoint.x) * diagonal.x +
          (draggedHandlePoint.y - interaction.anchorPoint.y) * diagonal.y) /
          (diagonal.x * diagonal.x + diagonal.y * diagonal.y),
      );
      const height = width / aspectRatio;
      const center = {
        x: interaction.anchorPoint.x + (diagonal.x * width) / 2,
        y: interaction.anchorPoint.y + (diagonal.y * width) / 2,
      };

      setDraftRect({
        x: center.x - width / 2,
        y: center.y - height / 2,
        width,
        height,
      });
      setGuides({ vertical: [], horizontal: [] });
    };

    const handleMouseUp = () => {
      const finalRect = draftRect ?? displayedRect;
      setInteraction(null);
      setGuides({ vertical: [], horizontal: [] });
      setDraftRect(null);

      if (!visualClip || !baseRect || !frameSize || !finalRect) {
        return;
      }

      const baseCenter = getCenter(baseRect);
      const finalCenter = getCenter(finalRect);
      void updateClipTransform(visualClip.id, {
        transformOffsetX: (finalCenter.x - baseCenter.x) / frameSize.width,
        transformOffsetY: (finalCenter.y - baseCenter.y) / frameSize.height,
        transformScale: clamp(finalRect.width / baseRect.width, 0.1, 10),
      });
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [
    baseRect,
    displayedRect,
    draftRect,
    frameSize,
    interaction,
    effectivePlayerZoom,
    updateClipTransform,
    visualClip,
  ]);

  const handleToggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    if (panelRef.current) {
      await panelRef.current.requestFullscreen();
    }
  };

  return (
    <div ref={panelRef} className="flex h-full w-full flex-col bg-black">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Play className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium text-muted-foreground">
          Player
        </span>
        {previewAsset ? (
          <div className="rounded-sm bg-primary/10 px-2 py-1 text-[11px] text-primary">
            Library preview
          </div>
        ) : null}
        {previewAsset ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => previewLibraryAsset(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Return to timeline preview</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted-foreground/20 p-3">
        <div
          className="flex h-full w-full items-center justify-center overflow-visible transition-transform duration-150"
          style={{
            transform: `scale(${effectivePlayerZoom})`,
            transformOrigin: "center center",
          }}
        >
          <div
            ref={frameRef}
            className="relative flex items-center justify-center overflow-visible bg-black"
            style={activeFrameStyle}
          >
            <div
              className={cn(
                "absolute inset-0",
                isTransformMode ? "overflow-visible" : "overflow-hidden",
                previewAsset && isPreviewVisualAsset && "flex items-center justify-center",
              )}
            >
              {guides.vertical.map((guide, index) => (
                <div
                  key={`vertical-${guide}-${index}`}
                  className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-cyan-300"
                  style={{ left: guide }}
                />
              ))}
              {guides.horizontal.map((guide, index) => (
                <div
                  key={`horizontal-${guide}-${index}`}
                  className="pointer-events-none absolute left-0 right-0 z-20 h-px bg-cyan-300"
                  style={{ top: guide }}
                />
              ))}

              {livePreviewAsset?.type === "image" && previewAssetUrl ? (
                <img
                  src={previewAssetUrl}
                  alt={livePreviewAsset.fileName}
                  className="max-h-full max-w-full object-contain"
                />
              ) : livePreviewAsset?.type === "video" && previewAssetUrl ? (
                <video
                  key={previewAssetUrl}
                  src={previewAssetUrl}
                  className="max-h-full max-w-full object-contain"
                  playsInline
                  controls
                  preload="auto"
                />
              ) : livePreviewAsset?.type === "audio" && previewAssetUrl ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-muted-foreground/80">
                  <Music2 className="h-12 w-12 opacity-70" />
                  <div className="text-sm">{livePreviewAsset.fileName}</div>
                  <audio key={previewAssetUrl} src={previewAssetUrl} controls />
                </div>
              ) : isSequencePlaybackActive && sequencePreviewUrl ? (
                <video
                  ref={videoRef}
                  key={sequencePreviewUrl}
                  src={sequencePreviewUrl}
                  className="h-full w-full object-contain"
                  playsInline
                  preload="auto"
                />
              ) : visualClip?.sourcePath &&
                canonicalVisualUrl &&
                displayedRect &&
                frameSize ? (
                <div
                  className="absolute"
                  style={{
                    left: displayedRect.x,
                    top: displayedRect.y,
                    width: displayedRect.width,
                    height: displayedRect.height,
                    ...visualRotationStyle,
                  }}
                >
                  <div
                    className="h-full w-full"
                    style={{
                      opacity: effectiveVisualOpacity,
                    }}
                  >
                    {isImagePath(visualClip.sourcePath) ? (
                      <img
                        src={canonicalVisualUrl}
                        alt={visualClip.sourcePath}
                        className="h-full w-full object-fill"
                        draggable={false}
                      />
                    ) : (
                      <video
                        ref={videoRef}
                        src={canonicalVisualUrl}
                        className="h-full w-full object-fill"
                        playsInline
                        muted={shouldMuteVideoElement}
                        preload="auto"
                      />
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            {isPlaybackWaiting ? (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 px-6">
                <div className="flex max-w-sm flex-col items-center gap-2 rounded-md border border-white/10 bg-black/75 px-4 py-3 text-center text-white">
                  <LoaderCircle className="h-5 w-5 animate-spin" />
                  <div className="text-sm font-medium">
                    {waitingOverlayLabel ?? "Waiting for sequence preview"}
                  </div>
                  {sequencePreviewHint ? (
                    <div className="text-xs text-white/70">{sequencePreviewHint}</div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {isTransformMode && displayedRect ? (
              <>
                <div className="pointer-events-none absolute inset-0 z-10 border border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.8)]" />
                <div
                  className="absolute z-20 border border-white/80"
                  style={{
                    left: displayedRect.x,
                    top: displayedRect.y,
                    width: displayedRect.width,
                    height: displayedRect.height,
                    ...visualRotationStyle,
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!displayedRect) return;
                    setInteraction({
                      type: "move",
                      originX: event.clientX,
                      originY: event.clientY,
                      startRect: displayedRect,
                    });
                    setDraftRect(displayedRect);
                  }}
                >
                  {(["nw", "ne", "se", "sw"] as const).map((handle) => (
                    <button
                      key={handle}
                      type="button"
                      className="absolute h-3 w-3 rounded-full border border-white bg-background"
                      style={{
                        left: handle.includes("e") ? "100%" : "0%",
                        top: handle.includes("s") ? "100%" : "0%",
                        cursor: getHandleResizeCursor(
                          handle,
                          visualClip?.rotationZ ?? 0,
                        ),
                        transform: `translate(-50%, -50%) scale(${1 / effectivePlayerZoom})`,
                        transformOrigin: "center center",
                      }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!displayedRect) return;
                        setInteraction({
                          type: "resize",
                          handle,
                          originX: event.clientX,
                          originY: event.clientY,
                          startRect: displayedRect,
                          anchorPoint: getRotatedOppositeCornerAnchor(
                            displayedRect,
                            handle,
                            visualClip?.rotationZ ?? 0,
                          ),
                        });
                        setDraftRect(displayedRect);
                      }}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>

      </div>

      <div className="shrink-0 border-t border-border bg-background/95 px-3 py-2">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {formatTimelineTime(Math.min(playhead, project.duration))} /{" "}
              {formatTimelineTime(project.duration)}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 opacity-60"
                    disabled
                  >
                    <CircleGauge className="h-4 w-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Audio Level Meter</TooltipContent>
            </Tooltip>
          </div>

          <Button
            variant="secondary"
            size="icon"
            className="h-8 w-8 justify-self-center"
            onClick={togglePlayback}
            title={
              isPlaybackWaiting
                ? "Cancel waiting"
                : isPlaying
                  ? "Pause"
                  : "Play"
            }
          >
            {isPlaybackWaiting ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : isPlaying ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>

          <div className="flex items-center justify-self-end gap-1.5 text-[11px] text-muted-foreground">
            {playbackSourceBadge ? (
              <div className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground">
                {playbackSourceBadge}
              </div>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 opacity-60"
                    disabled
                  >
                    <MonitorSmartphone className="h-4 w-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Social media preview</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px]"
                >
                  {selectedPlaybackQuality.label}
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuRadioGroup
                  value={playbackQuality}
                  onValueChange={(value) =>
                    void handlePlaybackQualityChange(value)
                  }
                >
                  {PLAYBACK_QUALITIES.map((quality) => (
                    <DropdownMenuRadioItem
                      key={quality.value}
                      value={quality.value}
                      className="items-start py-2"
                    >
                      <div className="flex flex-col gap-0.5">
                        <span>{quality.menuLabel}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {quality.description}
                        </span>
                      </div>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {!previewAsset ? (
              <div ref={playerZoomControlRef} className="relative">
                {showPlayerZoom ? (
                  <div className="absolute bottom-full right-0 mb-2 flex items-center gap-2 rounded-md border border-border bg-background px-2 py-2 shadow-lg">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() =>
                            setPlayerZoom((value) => Math.max(0.5, value - 0.1))
                          }
                        >
                          <ZoomOut className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Zoom out player</TooltipContent>
                    </Tooltip>
                    <div className="w-24 px-1">
                      <Slider
                        value={[playerZoom]}
                        min={0.5}
                        max={3}
                        step={0.05}
                        onValueChange={(values) => {
                          const nextZoom = values[0];
                          if (typeof nextZoom === "number") {
                            setPlayerZoom(nextZoom);
                          }
                        }}
                        aria-label="Player zoom"
                      />
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() =>
                            setPlayerZoom((value) => Math.min(3, value + 0.1))
                          }
                        >
                          <ZoomIn className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Zoom in player</TooltipContent>
                    </Tooltip>
                  </div>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setShowPlayerZoom((value) => !value)}
                    >
                      <Search className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Toggle player zoom controls</TooltipContent>
                </Tooltip>
              </div>
            ) : null}
            <div className="rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground">
              {projectRatioLabel}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => void handleToggleFullscreen()}
                >
                  <Maximize2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
