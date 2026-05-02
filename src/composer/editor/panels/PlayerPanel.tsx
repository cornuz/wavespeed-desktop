import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
import { normalizeClipAdjustments } from "@/composer/shared/clipAdjustments";
import { useComposerProjectStore } from "@/composer/stores/project.store";
import type {
  Clip,
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
  speed = 1,
): number {
  return Math.max(0, (playhead - clipStart) * speed + trimStart);
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

function getActiveVisualClipsAtTime(
  clips: Clip[],
  tracks: { id: string; type: "video" | "audio"; order: number; visible: boolean }[],
  playhead: number,
): Clip[] {
  const sortedVisibleVideoTrackIds = tracks
    .filter((track) => track.type === "video" && track.visible)
    .sort((left, right) => right.order - left.order)
    .map((track) => track.id);

  return sortedVisibleVideoTrackIds.flatMap((trackId) =>
    clips.filter(
      (clip) =>
        clip.trackId === trackId &&
        playhead >= clip.startTime &&
        playhead < clip.startTime + clip.duration,
    ),
  );
}

function getVisualAdjustmentFilter(clip: {
  adjustments: Clip["adjustments"];
} | null): string | undefined {
  if (!clip) {
    return undefined;
  }

  const adjustments = normalizeClipAdjustments(clip.adjustments);
  const filters = [
    `brightness(${Math.max(0, 1 + adjustments.lightnessCorrection.exposure / 100)})`,
    `contrast(${Math.max(0, 1 + adjustments.lightnessCorrection.contrast / 100)})`,
    `saturate(${Math.max(0, 1 + adjustments.colorCorrection.saturation / 100)})`,
    Math.abs(adjustments.colorCorrection.hue) > 0.1
      ? `hue-rotate(${adjustments.colorCorrection.hue * 1.8}deg)`
      : null,
  ].filter(Boolean);

  return filters.length > 0 ? filters.join(" ") : undefined;
}

function getVisualBlendMode(clip: { adjustments: Clip["adjustments"] } | null) {
  if (!clip) {
    return undefined;
  }

  const blendMode = normalizeClipAdjustments(clip.adjustments).blendMode;
  return blendMode === "normal" ? undefined : blendMode;
}

function getTemperatureOverlayStyle(
  clip: { adjustments: Clip["adjustments"] } | null,
): CSSProperties | undefined {
  if (!clip) {
    return undefined;
  }

  const { temperature } = normalizeClipAdjustments(clip.adjustments).colorCorrection;
  if (Math.abs(temperature) < 0.1) {
    return undefined;
  }

  return {
    backgroundColor:
      temperature >= 0 ? "rgba(255, 150, 70, 1)" : "rgba(70, 165, 255, 1)",
    mixBlendMode: "soft-light",
    opacity: Math.min(Math.abs(temperature) / 100, 1) * 0.28,
  };
}

function getTintOverlayStyle(
  clip: { adjustments: Clip["adjustments"] } | null,
): CSSProperties | undefined {
  if (!clip) {
    return undefined;
  }

  const { tint } = normalizeClipAdjustments(clip.adjustments).colorCorrection;
  if (Math.abs(tint) < 0.1) {
    return undefined;
  }

  return {
    backgroundColor: tint >= 0 ? "rgba(255, 90, 205, 1)" : "rgba(120, 255, 160, 1)",
    mixBlendMode: "soft-light",
    opacity: Math.min(Math.abs(tint) / 100, 1) * 0.18,
  };
}

function getVignetteOverlayStyle(
  clip: { adjustments: Clip["adjustments"] } | null,
): CSSProperties | undefined {
  if (!clip) {
    return undefined;
  }

  const { vignette } = normalizeClipAdjustments(clip.adjustments).effects;
  if (vignette <= 0) {
    return undefined;
  }

  return {
    background:
      "radial-gradient(circle at center, rgba(0,0,0,0) 48%, rgba(0,0,0,0.72) 100%)",
    opacity: Math.min(vignette / 100, 1) * 0.8,
  };
}

function getNoiseOverlayStyle(
  clip: { adjustments: Clip["adjustments"] } | null,
): CSSProperties | undefined {
  if (!clip) {
    return undefined;
  }

  const { noise } = normalizeClipAdjustments(clip.adjustments).effects;
  if (noise <= 0) {
    return undefined;
  }

  return {
    backgroundImage: [
      "linear-gradient(0deg, rgba(255,255,255,0.95) 50%, rgba(0,0,0,0.95) 50%)",
      "linear-gradient(90deg, rgba(255,255,255,0.85) 50%, rgba(0,0,0,0.85) 50%)",
    ].join(","),
    backgroundSize: "3px 3px, 4px 4px",
    mixBlendMode: "overlay",
    opacity: Math.min(noise / 100, 1) * 0.08,
  };
}

export function PlayerPanel() {
  const patchCurrentProject = useComposerProjectStore(
    (state) => state.patchCurrentProject,
  );
  const {
    clips,
    project,
    tracks,
    playhead,
    pendingSequencePlaybackStartTime,
    isPlaying,
    isPlaybackWaiting,
    previewAsset,
    selectedVisualClip,
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
  const videoLayerRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const playerZoomControlRef = useRef<HTMLDivElement | null>(null);

  const [frameSize, setFrameSize] = useState<Size | null>(null);
  const [mediaSizes, setMediaSizes] = useState<Record<string, Size>>({});
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
  const activeVisualClips = useMemo(
    () =>
      !previewAsset && !isSequencePlaybackActive
        ? getActiveVisualClipsAtTime(clips, tracks, playhead)
        : [],
    [clips, isSequencePlaybackActive, playhead, previewAsset, tracks],
  );
  const activeVisualLayers = useMemo(
    () =>
      activeVisualClips.map((clip) => {
        const asset = findAssetForClip(clip, libraryAssets);
        const canonicalPath = getCanonicalSourcePath(clip, asset);
        const canonicalUrl = getAssetUrl(canonicalPath);
        const clipLocalTime = getClipLocalTime(
          playhead,
          clip.startTime,
          clip.trimStart,
          clip.speed,
        );
        const fadeInFactor =
          clip.fadeInDuration > 0
            ? clamp(clipLocalTime / clip.fadeInDuration, 0, 1)
            : 1;
        const fadeOutFactor =
          clip.fadeOutDuration > 0
            ? clamp((clip.duration - clipLocalTime) / clip.fadeOutDuration, 0, 1)
            : 1;

        return {
          clip,
          asset,
          canonicalPath,
          canonicalUrl,
          clipLocalTime,
          effectiveOpacity: clamp(
            clip.opacity * Math.min(fadeInFactor, fadeOutFactor),
            0,
            1,
          ),
          mediaSize: mediaSizes[clip.id] ?? null,
        };
      }),
    [activeVisualClips, getAssetUrl, libraryAssets, mediaSizes, playhead],
  );
  const transformVisualLayer = useMemo(
    () =>
      selectedVisualClip
        ? activeVisualLayers.find((layer) => layer.clip.id === selectedVisualClip.id) ??
          null
        : null,
    [activeVisualLayers, selectedVisualClip],
  );
  const activeVisualRenderLayers = useMemo(
    () =>
      frameSize
        ? activeVisualLayers
            .map((layer) => {
              if (!layer.mediaSize || !layer.canonicalUrl) {
                return null;
              }

              const baseRect = getProjectScaledRect(layer.mediaSize, frameSize, {
                width: project.width,
                height: project.height,
              });
              const rect = getTransformedRect(
                baseRect,
                frameSize,
                layer.clip.transformOffsetX,
                layer.clip.transformOffsetY,
                layer.clip.transformScale,
              );

              return {
                ...layer,
                rect,
                rotationStyle: {
                  transform: `rotate(${layer.clip.rotationZ}deg)`,
                  transformOrigin: "center center",
                },
                adjustmentFilter: getVisualAdjustmentFilter(layer.clip),
                blendMode: getVisualBlendMode(layer.clip),
                temperatureOverlayStyle: getTemperatureOverlayStyle(layer.clip),
                tintOverlayStyle: getTintOverlayStyle(layer.clip),
                vignetteOverlayStyle: getVignetteOverlayStyle(layer.clip),
                noiseOverlayStyle: getNoiseOverlayStyle(layer.clip),
              };
            })
            .filter((layer) => layer !== null)
        : [],
    [activeVisualLayers, frameSize, project.height, project.width],
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
  const playbackClockMode = useMemo(() => {
    if (!isSequencePlaybackActive || previewAsset) {
      return "timeline";
    }

    return "media";
  }, [isSequencePlaybackActive, previewAsset]);

  const baseRect = useMemo(
    () =>
      frameSize && transformVisualLayer?.mediaSize
        ? getProjectScaledRect(transformVisualLayer.mediaSize, frameSize, {
            width: project.width,
            height: project.height,
          })
        : null,
    [frameSize, project.height, project.width, transformVisualLayer?.mediaSize],
  );
  const persistedRect = useMemo(
    () =>
      baseRect && frameSize && transformVisualLayer
        ? getTransformedRect(
            baseRect,
            frameSize,
            transformVisualLayer.clip.transformOffsetX,
            transformVisualLayer.clip.transformOffsetY,
            transformVisualLayer.clip.transformScale,
          )
        : null,
    [baseRect, frameSize, transformVisualLayer],
  );
  const displayedRect = draftRect ?? persistedRect;
  const isTransformMode = Boolean(
    transformVisualLayer &&
    !previewAsset &&
    !isPlaying &&
    displayedRect,
  );
  const visualRotationStyle = transformVisualLayer
    ? {
        transform: `rotate(${transformVisualLayer.clip.rotationZ}deg)`,
        transformOrigin: "center center",
      }
    : undefined;
  const selectedVisualClipForTransform = transformVisualLayer?.clip ?? null;

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
  }, [livePreviewAsset?.id, transformVisualLayer?.clip.id]);

  useEffect(() => {
    if (previewAsset) {
      return;
    }

    let cancelled = false;
    activeVisualLayers.forEach((layer) => {
      if (!layer.canonicalUrl || !layer.clip.sourcePath || mediaSizes[layer.clip.id]) {
        return;
      }

      if (isImagePath(layer.clip.sourcePath)) {
        const image = new Image();
        image.onload = () => {
          if (cancelled) {
            return;
          }
          setMediaSizes((current) => ({
            ...current,
            [layer.clip.id]: {
              width: image.naturalWidth,
              height: image.naturalHeight,
            },
          }));
        };
        image.src = layer.canonicalUrl;
        return;
      }

      const element = document.createElement("video");
      element.preload = "metadata";
      element.onloadedmetadata = () => {
        if (cancelled) {
          return;
        }
        setMediaSizes((current) => ({
          ...current,
          [layer.clip.id]: {
            width: element.videoWidth,
            height: element.videoHeight,
          },
        }));
      };
      element.src = layer.canonicalUrl;
    });

    return () => {
      cancelled = true;
    };
  }, [activeVisualLayers, mediaSizes, previewAsset]);

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
    if (previewAsset || isSequencePlaybackActive) {
      return;
    }

    const syncThreshold = 0.5 / project.fps;
    activeVisualLayers.forEach((layer) => {
      if (isImagePath(layer.clip.sourcePath)) {
        return;
      }

      const video = videoLayerRefs.current[layer.clip.id];
      if (!video) {
        return;
      }

      video.pause();
      if (Math.abs(video.playbackRate - layer.clip.speed) > 0.001) {
        video.playbackRate = layer.clip.speed;
      }
      syncMediaElementTime(video, layer.clipLocalTime, syncThreshold);
    });
  }, [activeVisualLayers, isSequencePlaybackActive, previewAsset, project.fps]);

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
    const rotationRadians =
      ((selectedVisualClipForTransform?.rotationZ ?? 0) * Math.PI) / 180;
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

      if (!selectedVisualClipForTransform || !baseRect || !frameSize || !finalRect) {
        return;
      }

      const baseCenter = getCenter(baseRect);
      const finalCenter = getCenter(finalRect);
      void updateClipTransform(selectedVisualClipForTransform.id, {
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
    selectedVisualClipForTransform,
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
            style={{
              ...activeFrameStyle,
              isolation: "isolate",
            }}
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
              ) : activeVisualRenderLayers.length > 0 ? (
                <>
                  {activeVisualRenderLayers.map((layer) => (
                    <div
                      key={layer.clip.id}
                      className="absolute"
                      style={{
                        left: layer.rect.x,
                        top: layer.rect.y,
                        width: layer.rect.width,
                        height: layer.rect.height,
                        ...layer.rotationStyle,
                      }}
                    >
                      <div
                        className="relative h-full w-full"
                        style={{
                          opacity: layer.effectiveOpacity,
                          mixBlendMode: layer.blendMode,
                        }}
                      >
                        <div
                          className="relative h-full w-full"
                          style={{
                            filter: layer.adjustmentFilter,
                          }}
                        >
                          {isImagePath(layer.clip.sourcePath) ? (
                            <img
                              src={layer.canonicalUrl}
                              alt={layer.clip.sourcePath}
                              className="h-full w-full object-fill"
                              draggable={false}
                            />
                          ) : (
                            <video
                              ref={(element) => {
                                videoLayerRefs.current[layer.clip.id] = element;
                              }}
                              src={layer.canonicalUrl}
                              className="h-full w-full object-fill"
                              playsInline
                              muted
                              preload="auto"
                            />
                          )}
                          {layer.temperatureOverlayStyle ? (
                            <div
                              className="pointer-events-none absolute inset-0"
                              style={layer.temperatureOverlayStyle}
                            />
                          ) : null}
                          {layer.tintOverlayStyle ? (
                            <div
                              className="pointer-events-none absolute inset-0"
                              style={layer.tintOverlayStyle}
                            />
                          ) : null}
                          {layer.vignetteOverlayStyle ? (
                            <div
                              className="pointer-events-none absolute inset-0"
                              style={layer.vignetteOverlayStyle}
                            />
                          ) : null}
                          {layer.noiseOverlayStyle ? (
                            <div
                              className="pointer-events-none absolute inset-0"
                              style={layer.noiseOverlayStyle}
                            />
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </>
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
                          selectedVisualClipForTransform?.rotationZ ?? 0,
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
                            selectedVisualClipForTransform?.rotationZ ?? 0,
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
