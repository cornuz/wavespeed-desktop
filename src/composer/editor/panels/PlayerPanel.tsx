import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { Progress } from "@/components/ui/progress";
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
  composerClipIpc,
  composerAssetIpc,
  composerProjectIpc,
} from "@/composer/ipc/ipc-client";
import { buildLivePreviewFilterSpec } from "@/composer/shared/live-preview-filters";
import { normalizeClipAdjustments } from "@/composer/shared/clipAdjustments";
import { normalizeProjectBackgroundColor } from "@/composer/shared/projectBackground";
import {
  paintNoiseCanvas,
  getNoiseSeed,
  normalizeNoiseAmount,
} from "@/composer/shared/procedural-noise";
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
  getUniversalClipRect,
  rotatePointYUpCW,
  snapRectToFrame,
  universalRectToScreen,
  screenPointToUniversal,
  type Size,
  type SnapGuides,
  type UniversalRect,
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

function syncMediaElementTimeForwardOnly(
  element: HTMLMediaElement,
  targetTime: number,
  threshold: number,
): "ahead" | "synced" {
  if (!Number.isFinite(element.currentTime)) {
    element.currentTime = targetTime;
    return "synced";
  }

  if (element.currentTime - targetTime > threshold) {
    return "ahead";
  }

  if (targetTime - element.currentTime > threshold) {
    element.currentTime = targetTime;
  }

  return "synced";
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
    void element
      .play()
      .then(() => {
        element.muted = false;
      })
      .catch(() => undefined);
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
      return { x: -1, y: 1 }; // left, up
    case "ne":
      return { x: 1, y: 1 }; // right, up
    case "se":
      return { x: 1, y: -1 }; // right, down
    case "sw":
      return { x: -1, y: -1 }; // left, down
  }
}

function getRotatedOppositeCornerAnchorUniversal(
  uRect: UniversalRect,
  handle: ResizeHandle,
  rotationDegrees: number,
): Point {
  const direction = getHandleDirection(handle);
  const oppositeCornerOffset = rotatePointYUpCW(
    {
      x: (-direction.x * uRect.width) / 2,
      y: (-direction.y * uRect.height) / 2,
    },
    (rotationDegrees * Math.PI) / 180,
  );

  return {
    x: uRect.centerX + oppositeCornerOffset.x,
    y: uRect.centerY + oppositeCornerOffset.y,
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
const MIN_PLAYER_ZOOM = 0.25;
const MAX_PLAYER_ZOOM = 2;
const PLAYER_WHEEL_ZOOM_STEP = 0.1;

type EditInteraction =
  | {
      type: "move";
      originScreenX: number;
      originScreenY: number;
      startUniversalRect: UniversalRect;
    }
  | {
      type: "resize";
      handle: ResizeHandle;
      originScreenX: number;
      originScreenY: number;
      startUniversalRect: UniversalRect;
      anchorPoint: Point;
    };

function isImagePath(path: string | null | undefined): boolean {
  return path?.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i) != null;
}

function isSvgPath(path: string | null | undefined): boolean {
  return path?.match(/\.svg$/i) != null;
}

function getCanonicalSourcePath(
  clip: { sourcePath: string | null; lutProxyPath?: string | null } | null,
  asset: ComposerAsset | null,
): string | null {
  return clip?.lutProxyPath ?? asset?.workingPath ?? clip?.sourcePath ?? asset?.filePath ?? null;
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
  tracks: {
    id: string;
    type: "video" | "audio";
    order: number;
    visible: boolean;
  }[],
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

function getActiveAudioTrackClipsAtTime(
  clips: Clip[],
  tracks: {
    id: string;
    type: "video" | "audio";
    order: number;
    visible: boolean;
    muted?: boolean;
  }[],
  playhead: number,
): Clip[] {
  const sortedVisibleAudioTrackIds = tracks
    .filter((track) => track.type === "audio" && track.visible && !track.muted)
    .sort((left, right) => left.order - right.order)
    .map((track) => track.id);

  return sortedVisibleAudioTrackIds.flatMap((trackId) =>
    clips.filter(
      (clip) =>
        clip.trackId === trackId &&
        playhead >= clip.startTime &&
        playhead < clip.startTime + clip.duration,
    ),
  );
}

function getClipEffectiveAudioVolume(clip: Clip, clipLocalTime: number): number {
  const fadeInFactor =
    clip.fadeInDuration > 0
      ? clamp(clipLocalTime / clip.fadeInDuration, 0, 1)
      : 1;
  const fadeOutFactor =
    clip.fadeOutDuration > 0
      ? clamp((clip.duration - clipLocalTime) / clip.fadeOutDuration, 0, 1)
      : 1;

  return clamp(clip.volume * Math.min(fadeInFactor, fadeOutFactor), 0, 1);
}

function getVisualAdjustmentFilter(
  clip: {
    id: string;
    adjustments: Clip["adjustments"];
  } | null,
): ReturnType<typeof buildLivePreviewFilterSpec> {
  if (!clip) {
    return { filter: undefined, sharpenFilter: undefined };
  }

  return buildLivePreviewFilterSpec(
    clip.adjustments,
    `player-panel-sharpen-${clip.id}`,
  );
}

function getVisualBlendMode(clip: { adjustments: Clip["adjustments"] } | null) {
  if (!clip) {
    return undefined;
  }

  const blendMode = normalizeClipAdjustments(clip.adjustments).blendMode;
  return blendMode === "normal" ? undefined : blendMode;
}

function NoiseOverlayCanvas({
  amount,
  seed,
  frameIndex,
  width,
  height,
}: {
  amount: number;
  seed: number;
  frameIndex: number;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) {
      return;
    }

    paintNoiseCanvas(canvas, width, height, seed, frameIndex);
  }, [frameIndex, height, seed, width]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{
        mixBlendMode: "overlay",
        opacity: amount / 100,
      }}
    />
  );
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
    sequencePreviewProgress,
    previewAsset,
    selectedVisualClip,
    selectClip,
    syncPlaybackToMediaClock,
    setPlaybackClockSource,
    togglePlayback,
    stopPlayback,
    getAssetUrl,
    previewLibraryAsset,
    updateClipTransform,
    shouldAnimateClipVisualChanges,
  } = useComposerRuntime();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioPlaybackHostRef = useRef<HTMLDivElement | null>(null);
  const playerZoomControlRef = useRef<HTMLDivElement | null>(null);
  const previousTransformSelectionClipIdRef = useRef<string | null>(null);
  const previousViewScaleRef = useRef<number | null>(null);
  const previousIsPlayingRef = useRef(false);

  const [panelSize, setPanelSize] = useState<Size | null>(null);
  const [mediaSizes, setMediaSizes] = useState<Record<string, Size>>({});
  const [interaction, setInteraction] = useState<EditInteraction | null>(null);
  const [draftRect, setDraftRect] = useState<UniversalRect | null>(null);
  const [guides, setGuides] = useState<SnapGuides>({
    vertical: [],
    horizontal: [],
  });
  const [showPlayerZoom, setShowPlayerZoom] = useState(false);
  const [playerZoom, setPlayerZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [libraryAssets, setLibraryAssets] = useState<ComposerAsset[]>([]);
  const [resolvedInstanceLutProxyPaths, setResolvedInstanceLutProxyPaths] = useState<
    Record<
      string,
      {
        status: "loading" | "ready" | "error";
        path: string | null;
        requestKey: string;
      }
    >
  >({});
  const playbackQuality = project.playbackQuality ?? "med";
  const projectBackgroundColor = normalizeProjectBackgroundColor(project.backgroundColor);

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
    setResolvedInstanceLutProxyPaths({});
  }, [project.id]);

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
    playbackQuality !== "full" &&
    !previewAsset &&
    isPlaying &&
    isSequencePreviewReady;
  const previewFrameIndex = useMemo(
    () => Math.max(0, Math.round(playhead * project.fps)),
    [playhead, project.fps],
  );
  const activeVisualClips = useMemo(
    () =>
      !previewAsset && !isSequencePlaybackActive
        ? getActiveVisualClipsAtTime(clips, tracks, playhead)
        : [],
    [clips, isSequencePlaybackActive, playhead, previewAsset, tracks],
  );
  const activeAudioTrackClips = useMemo(
    () =>
      !previewAsset && !isSequencePlaybackActive
        ? getActiveAudioTrackClipsAtTime(clips, tracks, playhead)
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
            ? clamp(
                (clip.duration - clipLocalTime) / clip.fadeOutDuration,
                0,
                1,
              )
            : 1;

        return {
          clip,
          asset,
          canonicalPath,
          canonicalUrl,
          lutAssetId: normalizeClipAdjustments(clip.adjustments).lutAssetId,
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
  const activeAudioPlaybackLayers = useMemo(() => {
    const activeLayersByClipId = new Map<
      string,
      {
        clip: Clip;
        canonicalUrl: string;
        clipLocalTime: number;
        effectiveVolume: number;
      }
    >();

    const registerClip = (clip: Clip) => {
      const asset = findAssetForClip(clip, libraryAssets);
      const track = tracks.find((entry) => entry.id === clip.trackId) ?? null;
      const hasAudio =
        asset?.type === "audio" || asset?.hasAudio === true || track?.type === "audio";
      if (!hasAudio) {
        return;
      }

      const canonicalPath =
        asset?.workingPath ?? clip.sourcePath ?? asset?.filePath ?? null;
      const canonicalUrl = getAssetUrl(canonicalPath);
      if (!canonicalUrl) {
        return;
      }

      const clipLocalTime = getClipLocalTime(
        playhead,
        clip.startTime,
        clip.trimStart,
        clip.speed,
      );
      const effectiveVolume = getClipEffectiveAudioVolume(clip, clipLocalTime);
      if (effectiveVolume <= 0) {
        return;
      }

      activeLayersByClipId.set(clip.id, {
        clip,
        canonicalUrl,
        clipLocalTime,
        effectiveVolume,
      });
    };

    activeAudioTrackClips.forEach(registerClip);
    activeVisualClips.forEach(registerClip);

    return Array.from(activeLayersByClipId.values());
  }, [
    activeAudioTrackClips,
    activeVisualClips,
    getAssetUrl,
    libraryAssets,
    playhead,
    tracks,
  ]);
  const activeInstanceLutProxyRequests = useMemo(
    () =>
      activeVisualLayers
        .filter(
          (layer) =>
            typeof layer.clip.sourcePath === "string" &&
            layer.clip.sourcePath.length > 0 &&
            !isSvgPath(layer.clip.sourcePath) &&
            typeof layer.lutAssetId === "string" &&
            layer.lutAssetId.length > 0,
        )
        .map((layer) => ({
          clipId: layer.clip.id,
          requestKey: `${layer.clip.sourcePath ?? ""}|${layer.lutAssetId ?? ""}`,
        })),
    [activeVisualLayers],
  );
  useEffect(() => {
    if (!project.id) {
      return;
    }

    const pendingProxyRequests = activeInstanceLutProxyRequests.filter(
      ({ clipId, requestKey }) =>
        resolvedInstanceLutProxyPaths[clipId] == null ||
        resolvedInstanceLutProxyPaths[clipId]?.requestKey !== requestKey,
    );
    if (pendingProxyRequests.length === 0) {
      return;
    }

    let cancelled = false;

    setResolvedInstanceLutProxyPaths((current) => {
      const next = { ...current };
      pendingProxyRequests.forEach(({ clipId, requestKey }) => {
        next[clipId] = {
          status: "loading",
          path: null,
          requestKey,
        };
      });
      return next;
    });

    void Promise.all(
      pendingProxyRequests.map(async ({ clipId, requestKey }) => {
        try {
          const resolved = await composerClipIpc.resolveTimelineLutProxy({
            projectId: project.id,
            clipId,
          });

          return {
            clipId,
            status: resolved.status ?? "ready",
            path: resolved.path,
            requestKey,
          };
        } catch (error) {
          return {
            clipId,
            status: "error" as const,
            path: null,
            requestKey,
            errorMessage: error instanceof Error ? error.message : "Failed to resolve LUT proxy.",
          };
        }
      }),
    ).then((results) => {
      if (cancelled) {
        return;
      }

      setResolvedInstanceLutProxyPaths((current) => {
        const next = { ...current };
        results.forEach(({ clipId, status, path, requestKey, errorMessage }) => {
          if (status === "error" && errorMessage) {
            console.warn(
              `Failed to resolve LUT proxy for clip ${clipId} in PlayerPanel`,
              errorMessage,
            );
          }

          next[clipId] = {
            status,
            path,
            requestKey,
          };
        });
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [activeInstanceLutProxyRequests, project.id, resolvedInstanceLutProxyPaths]);
  const transformVisualLayer = useMemo(
    () =>
      selectedVisualClip
        ? (activeVisualLayers.find(
            (layer) => layer.clip.id === selectedVisualClip.id,
          ) ?? null)
        : null,
    [activeVisualLayers, selectedVisualClip],
  );
  const projectSize = useMemo(
    () => ({ width: project.width, height: project.height }),
    [project.width, project.height],
  );

  const fitScale = useMemo(() => {
    if (!panelSize) return 1;
    return Math.min(
      panelSize.width / project.width,
      panelSize.height / project.height,
    );
  }, [panelSize, project.width, project.height]);

  const baseScale = isFullscreen ? 1.0 : fitScale;
  const viewScale = baseScale * playerZoom;
  useEffect(() => {
    previousViewScaleRef.current = viewScale;
  }, [viewScale]);

  const screenCenter = useMemo(() => {
    return {
      x: (project.width * viewScale) / 2,
      y: (project.height * viewScale) / 2,
    };
  }, [project.width, project.height, viewScale]);

  const activeVisualRenderLayers = useMemo(
    () =>
      activeVisualLayers
        .map((layer) => {
          if (!layer.mediaSize || !layer.canonicalUrl) {
            return null;
          }

          const normalizedAdjustments = normalizeClipAdjustments(
            layer.clip.adjustments,
          );
          const normalizedNoiseAmount = normalizeNoiseAmount(
            normalizedAdjustments.effects.noise,
          );

          const uRect = getUniversalClipRect(
            layer.mediaSize,
            layer.clip.transformOffsetX,
            layer.clip.transformOffsetY,
            layer.clip.transformScale,
          );
          const screenRect = universalRectToScreen(
            uRect,
            screenCenter.x,
            screenCenter.y,
            viewScale,
          );

          return {
            ...layer,
            canonicalPath:
              layer.clip.lutProxyPath ??
              resolvedInstanceLutProxyPaths[layer.clip.id]?.path ??
              layer.canonicalPath,
            canonicalUrl:
              getAssetUrl(
                layer.clip.lutProxyPath ??
                  resolvedInstanceLutProxyPaths[layer.clip.id]?.path ??
                  layer.canonicalPath,
              ) ?? layer.canonicalUrl,
            uRect,
            screenRect,
            rotationStyle: {
              transform: `rotate(${layer.clip.rotationZ}deg) scaleX(${layer.clip.flipHorizontal ? -1 : 1}) scaleY(${layer.clip.flipVertical ? -1 : 1})`,
              transformOrigin: "center center",
            },
            adjustmentPreview: getVisualAdjustmentFilter(layer.clip),
            noisePreview:
              normalizedNoiseAmount > 0
                ? {
                    amount: normalizedNoiseAmount,
                    seed: getNoiseSeed(layer.clip.id),
                    frameIndex: previewFrameIndex,
                  }
                : null,
            blendMode: getVisualBlendMode(layer.clip),
          };
        })
        .filter((layer): layer is NonNullable<typeof layer> => layer !== null),
    [
      activeVisualLayers,
      getAssetUrl,
      project.fps,
      resolvedInstanceLutProxyPaths,
      screenCenter,
      viewScale,
      project.width,
      project.height,
      previewFrameIndex,
    ],
  );
  const selectedVisualRenderLayer = useMemo(
    () =>
      selectedVisualClip
        ? (activeVisualRenderLayers.find(
            (layer) => layer.clip.id === selectedVisualClip.id,
          ) ?? null)
        : null,
    [activeVisualRenderLayers, selectedVisualClip],
  );
  const activeSharpenFilterDefinitions = useMemo(() => {
    const definitions = new Map<string, NonNullable<(typeof activeVisualRenderLayers)[number]["adjustmentPreview"]["sharpenFilter"]>>();

    activeVisualRenderLayers.forEach((layer) => {
      if (layer.adjustmentPreview.sharpenFilter) {
        definitions.set(
          layer.adjustmentPreview.sharpenFilter.filterId,
          layer.adjustmentPreview.sharpenFilter,
        );
      }
    });

    return Array.from(definitions.values());
  }, [activeVisualRenderLayers]);
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
      width: project.width * viewScale,
      height: project.height * viewScale,
    }),
    [project.height, project.width, viewScale],
  );
  const selectedOverflowExtent = useMemo(
    () => ({
      width: Math.max(panelSize?.width ?? 0, project.width * viewScale),
      height: Math.max(panelSize?.height ?? 0, project.height * viewScale),
    }),
    [panelSize, project.height, project.width, viewScale],
  );
  const projectRatioLabel = useMemo(
    () => getProjectRatioLabel(project.width, project.height),
    [project.height, project.width],
  );
  const isPreviewVisualAsset =
    livePreviewAsset?.type === "image" || livePreviewAsset?.type === "video";
  // Zoom is now applied via viewScale in universal→screen conversion
  const activeFrameStyle =
    previewAsset && isPreviewVisualAsset
      ? {
          width: "100%",
          height: "100%",
        }
      : projectFrameStyle;
  const selectedPlaybackQuality = useMemo(
    () =>
      PLAYBACK_QUALITIES.find((quality) => quality.value === playbackQuality) ??
      PLAYBACK_QUALITIES[2],
    [playbackQuality],
  );
  const playbackSourceBadge = useMemo(() => {
    return null;
  }, []);
  const handlePlayerWheelZoom = useCallback(
    (event: globalThis.WheelEvent) => {
      if (previewAsset || event.deltaY === 0) {
        return;
      }

      if (event.cancelable) {
        event.preventDefault();
      }
      setPlayerZoom((value) =>
        clamp(
          Number(
            (
              value +
              (event.deltaY < 0
                ? PLAYER_WHEEL_ZOOM_STEP
                : -PLAYER_WHEEL_ZOOM_STEP)
            ).toFixed(2),
          ),
          MIN_PLAYER_ZOOM,
          MAX_PLAYER_ZOOM,
        ),
      );
    },
    [previewAsset],
  );
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.addEventListener("wheel", handlePlayerWheelZoom, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", handlePlayerWheelZoom);
    };
  }, [handlePlayerWheelZoom]);
  const unsupportedLiveVideoLutMessage = useMemo(() => {
    if (previewAsset || isSequencePlaybackActive) {
      return null;
    }

    return activeVisualLayers.some(
      (layer) =>
        Boolean(layer.lutAssetId) &&
        !isImagePath(layer.clip.sourcePath) &&
        !(
          typeof layer.clip.lutProxyPath === "string" && layer.clip.lutProxyPath.length > 0
        ) &&
        !(
          typeof resolvedInstanceLutProxyPaths[layer.clip.id]?.path === "string" &&
          resolvedInstanceLutProxyPaths[layer.clip.id]?.path.length > 0
        ),
    )
      ? "Video LUT proxy is still generating."
      : null;
  }, [
    activeVisualLayers,
    isSequencePlaybackActive,
    previewAsset,
    resolvedInstanceLutProxyPaths,
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
  const sequencePreviewProgressValue = useMemo(
    () => clamp(sequencePreviewProgress, 0, 100),
    [sequencePreviewProgress],
  );
  const sequencePreviewProgressLabel = useMemo(
    () => `Rendering preview... ${Math.round(sequencePreviewProgressValue)}%`,
    [sequencePreviewProgressValue],
  );
  const shouldShowSequencePreviewProgress =
    !previewAsset && sequencePreview.status === "processing";
  const playbackClockMode = useMemo(() => {
    if (!isSequencePlaybackActive || previewAsset) {
      return "timeline";
    }

    return "media";
  }, [isSequencePlaybackActive, previewAsset]);

  const baseRect = useMemo(
    () =>
      transformVisualLayer?.mediaSize
        ? getUniversalClipRect(transformVisualLayer.mediaSize, 0, 0, 1)
        : null,
    [transformVisualLayer?.mediaSize],
  );
  const persistedRect = useMemo(
    () =>
      transformVisualLayer?.mediaSize
        ? getUniversalClipRect(
            transformVisualLayer.mediaSize,
            transformVisualLayer.clip.transformOffsetX,
            transformVisualLayer.clip.transformOffsetY,
            transformVisualLayer.clip.transformScale,
          )
        : null,
    [transformVisualLayer],
  );
  const displayedRect = draftRect ?? persistedRect;
  const displayedScreenRect = useMemo(
    () =>
      displayedRect
        ? universalRectToScreen(
            displayedRect,
            screenCenter.x,
            screenCenter.y,
            viewScale,
          )
        : null,
    [displayedRect, screenCenter, viewScale],
  );
  const isTransformMode = Boolean(
    transformVisualLayer && !previewAsset && !isPlaying && displayedRect,
  );
  const visualRotationStyle = transformVisualLayer
    ? {
        transform: `rotate(${transformVisualLayer.clip.rotationZ}deg) scaleX(${transformVisualLayer.clip.flipHorizontal ? -1 : 1}) scaleY(${transformVisualLayer.clip.flipVertical ? -1 : 1})`,
        transformOrigin: "center center",
      }
    : undefined;
  const selectedVisualClipForTransform = transformVisualLayer?.clip ?? null;
  useEffect(() => {
    previousTransformSelectionClipIdRef.current =
      selectedVisualClipForTransform?.id ?? null;
  }, [selectedVisualClipForTransform?.id]);
  const syncVisualLayerVideoElement = useCallback(
    (
      element: HTMLVideoElement,
      layer: (typeof activeVisualRenderLayers)[number],
    ) => {
      const syncThreshold = 0.5 / project.fps;
      const shouldFrameStepFullPlayback =
        playbackQuality === "full" &&
        isPlaying &&
        !previewAsset &&
        !isSequencePlaybackActive;
      if (Math.abs(element.playbackRate - layer.clip.speed) > 0.001) {
        element.playbackRate = layer.clip.speed;
      }

      const shouldPlayLiveLayer =
        isPlaying && !previewAsset && !isSequencePlaybackActive;
      const shouldUseForwardOnlySync =
        playbackQuality === "full" &&
        shouldPlayLiveLayer &&
        !shouldFrameStepFullPlayback;

      const syncMode = shouldFrameStepFullPlayback
        ? (syncMediaElementTime(element, layer.clipLocalTime, 0), "synced" as const)
        : shouldUseForwardOnlySync
          ? syncMediaElementTimeForwardOnly(
              element,
              layer.clipLocalTime,
              syncThreshold,
            )
          : (syncMediaElementTime(element, layer.clipLocalTime, syncThreshold),
            "synced" as const);

      if (!shouldPlayLiveLayer) {
        element.pause();
        return;
      }

      if (shouldFrameStepFullPlayback) {
        element.pause();
        return;
      }

      if (syncMode === "ahead") {
        element.pause();
        return;
      }

      if (element.paused) {
        void element.play().catch(() => undefined);
      }
    },
    [
      isPlaying,
      isSequencePlaybackActive,
      playbackQuality,
      previewAsset,
      project.fps,
    ],
  );
  const syncAudioPlaybackElement = useCallback(
    (
      element: HTMLAudioElement,
      layer: (typeof activeAudioPlaybackLayers)[number],
    ) => {
      const syncThreshold = 0.5 / project.fps;
      if (Math.abs(element.playbackRate - layer.clip.speed) > 0.001) {
        element.playbackRate = layer.clip.speed;
      }

      if (Math.abs(element.volume - layer.effectiveVolume) > 0.001) {
        element.volume = layer.effectiveVolume;
      }
      element.muted = false;
      const shouldUseForwardOnlySync =
        playbackQuality === "full" && isPlaying && !previewAsset && !isSequencePlaybackActive;
      const syncMode = shouldUseForwardOnlySync
        ? syncMediaElementTimeForwardOnly(
            element,
            layer.clipLocalTime,
            syncThreshold,
          )
        : (syncMediaElementTime(element, layer.clipLocalTime, syncThreshold),
          "synced" as const);

      if (!isPlaying || previewAsset || isSequencePlaybackActive) {
        element.pause();
        return;
      }

      if (syncMode === "ahead") {
        element.pause();
        return;
      }

      if (element.paused) {
        void element.play().catch(() => undefined);
      }
    },
    [
      isPlaying,
      isSequencePlaybackActive,
      playbackQuality,
      previewAsset,
      project.fps,
    ],
  );
  const shouldAnimateTransformOverlay =
    !isPlaying &&
    !interaction &&
    previousViewScaleRef.current === viewScale &&
    selectedVisualClipForTransform != null &&
    previousTransformSelectionClipIdRef.current === selectedVisualClipForTransform.id &&
    shouldAnimateClipVisualChanges(selectedVisualClipForTransform.id);
  const shouldAnimateSelectedClipVisualChanges =
    !isPlaying &&
    previousViewScaleRef.current === viewScale &&
    selectedVisualClipForTransform != null &&
    previousTransformSelectionClipIdRef.current === selectedVisualClipForTransform.id &&
    shouldAnimateClipVisualChanges(selectedVisualClipForTransform.id);
  const renderVisualLayer = useCallback(
    (
      layer: (typeof activeVisualRenderLayers)[number],
      options?: {
        opacity?: number;
        offsetX?: number;
        offsetY?: number;
      },
    ) => {
      const shouldAnimateVisualChanges =
        shouldAnimateSelectedClipVisualChanges &&
        layer.clip.id === selectedVisualClipForTransform?.id;

      return (
        <div
          className="absolute"
          style={{
            left: layer.screenRect.x + (options?.offsetX ?? 0),
            top: layer.screenRect.y + (options?.offsetY ?? 0),
            width: layer.screenRect.width,
            height: layer.screenRect.height,
            opacity: options?.opacity ?? layer.effectiveOpacity,
            mixBlendMode: layer.blendMode,
            transition: shouldAnimateVisualChanges
              ? "left 360ms linear, top 360ms linear, width 360ms linear, height 360ms linear, opacity 360ms linear"
              : undefined,
          }}
        >
          <div
            className="relative h-full w-full"
            style={{
              isolation: "isolate",
              transition: shouldAnimateVisualChanges
                ? "transform 360ms linear"
                : undefined,
              ...layer.rotationStyle,
            }}
          >
            {isImagePath(layer.clip.sourcePath) ? (
              <img
                src={layer.canonicalUrl}
                alt={layer.clip.sourcePath}
                className="h-full w-full object-fill"
                draggable={false}
                style={{
                  filter: layer.adjustmentPreview.filter,
                  transition: shouldAnimateVisualChanges
                    ? "filter 360ms linear"
                    : undefined,
                }}
              />
            ) : (
              <video
                data-player-clip-id={layer.clip.id}
                src={layer.canonicalUrl}
                className="h-full w-full object-fill"
                playsInline
                muted
                preload="auto"
                style={{
                  filter: layer.adjustmentPreview.filter,
                  transition: shouldAnimateVisualChanges
                    ? "filter 360ms linear"
                    : undefined,
                }}
                onLoadedMetadata={(event) =>
                  syncVisualLayerVideoElement(event.currentTarget, layer)
                }
                onCanPlay={(event) =>
                  syncVisualLayerVideoElement(event.currentTarget, layer)
                }
              />
            )}
            {layer.noisePreview ? (
              <NoiseOverlayCanvas
                amount={layer.noisePreview.amount}
                seed={layer.noisePreview.seed}
                frameIndex={layer.noisePreview.frameIndex}
                width={Math.max(1, Math.round(layer.screenRect.width))}
                height={Math.max(1, Math.round(layer.screenRect.height))}
              />
            ) : null}
          </div>
        </div>
      );
    },
    [
      selectedVisualClipForTransform?.id,
      shouldAnimateSelectedClipVisualChanges,
      syncVisualLayerVideoElement,
    ],
  );

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
    // Reset zoom to 1.0 when entering or exiting fullscreen
    setPlayerZoom(1);
  }, [isFullscreen]);

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
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const updateSize = () =>
      setPanelSize({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      });

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
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
      if (
        !layer.canonicalUrl ||
        !layer.clip.sourcePath ||
        mediaSizes[layer.clip.id]
      ) {
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

      const videos = frameRef.current?.querySelectorAll<HTMLVideoElement>(
        `video[data-player-clip-id="${layer.clip.id}"]`,
      );
      if (!videos?.length) {
        return;
      }

      videos.forEach((video) => {
        syncVisualLayerVideoElement(video, layer);
      });
    });
  }, [
    activeVisualLayers,
    isSequencePlaybackActive,
    previewAsset,
    project.fps,
    syncVisualLayerVideoElement,
  ]);

  useEffect(() => {
    const wasPlaying = previousIsPlayingRef.current;
    previousIsPlayingRef.current = isPlaying;

    if (previewAsset || isSequencePlaybackActive) {
      return;
    }

    const frame = frameRef.current;
    const audioHost = audioPlaybackHostRef.current;
    if (!frame && !audioHost) {
      return;
    }

    if (wasPlaying && !isPlaying) {
      frame
        ?.querySelectorAll<HTMLVideoElement>("video[data-player-clip-id]")
        .forEach((element) => {
          element.pause();
        });
      audioHost
        ?.querySelectorAll<HTMLAudioElement>("audio[data-player-audio-clip-id]")
        .forEach((element) => {
          element.pause();
        });
      return;
    }

    if (!wasPlaying && isPlaying) {
      const syncThreshold = 0.5 / project.fps;

      activeVisualLayers.forEach((layer) => {
        if (isImagePath(layer.clip.sourcePath)) {
          return;
        }

        frame
          ?.querySelectorAll<HTMLVideoElement>(
            `video[data-player-clip-id="${layer.clip.id}"]`,
          )
          .forEach((element) => {
            if (Math.abs(element.playbackRate - layer.clip.speed) > 0.001) {
              element.playbackRate = layer.clip.speed;
            }
            if (playbackQuality === "full") {
              syncMediaElementTime(element, layer.clipLocalTime, 0);
              element.pause();
              return;
            }
            syncMediaElementTime(element, layer.clipLocalTime, syncThreshold);
            void element.play().catch(() => undefined);
          });
      });

      activeAudioPlaybackLayers.forEach((layer) => {
        const element = audioHost?.querySelector<HTMLAudioElement>(
          `audio[data-player-audio-clip-id="${layer.clip.id}"]`,
        );
        if (!element) {
          return;
        }

        if (Math.abs(element.playbackRate - layer.clip.speed) > 0.001) {
          element.playbackRate = layer.clip.speed;
        }
        if (Math.abs(element.volume - layer.effectiveVolume) > 0.001) {
          element.volume = layer.effectiveVolume;
        }
        element.muted = false;
        syncMediaElementTime(element, layer.clipLocalTime, syncThreshold);
        void element.play().catch(() => undefined);
      });
    }
  }, [
    activeAudioPlaybackLayers,
    activeVisualLayers,
    isPlaying,
    isSequencePlaybackActive,
    playbackQuality,
    previewAsset,
    project.fps,
  ]);

  useEffect(() => {
    const audioElements =
      audioPlaybackHostRef.current?.querySelectorAll<HTMLAudioElement>(
        "audio[data-player-audio-clip-id]",
      ) ?? [];

    if (!isPlaying || previewAsset || isSequencePlaybackActive) {
      audioElements.forEach((element) => {
        element.pause();
      });
      return;
    }

    activeAudioPlaybackLayers.forEach((layer) => {
      const audio = audioPlaybackHostRef.current?.querySelector<HTMLAudioElement>(
        `audio[data-player-audio-clip-id="${layer.clip.id}"]`,
      );
      if (!audio) {
        return;
      }

      syncAudioPlaybackElement(audio, layer);
    });
  }, [
    activeAudioPlaybackLayers,
    isPlaying,
    isSequencePlaybackActive,
    previewAsset,
    syncAudioPlaybackElement,
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
    const previewPlaybackEndTime = Math.max(0, project.duration - 1 / project.fps);
    if (isPlaying && playhead >= previewPlaybackEndTime) {
      stopPlayback(previewPlaybackEndTime);
    }
  }, [isPlaying, playhead, project.duration, project.fps, stopPlayback]);

  useEffect(() => {
    if (!interaction || !displayedRect) {
      return;
    }

    const aspectRatio = displayedRect.width / displayedRect.height;
    const rotationRadians =
      ((selectedVisualClipForTransform?.rotationZ ?? 0) * Math.PI) / 180;

    const handleMouseMove = (event: MouseEvent) => {
      const currentUniversal = screenPointToUniversal(
        event.clientX,
        event.clientY,
        screenCenter.x,
        screenCenter.y,
        viewScale,
      );
      const startUniversal = screenPointToUniversal(
        interaction.originScreenX,
        interaction.originScreenY,
        screenCenter.x,
        screenCenter.y,
        viewScale,
      );
      const dx = currentUniversal.x - startUniversal.x;
      const dy = currentUniversal.y - startUniversal.y;

      if (interaction.type === "move") {
        const moved: UniversalRect = {
          ...interaction.startUniversalRect,
          centerX: interaction.startUniversalRect.centerX + dx,
          centerY: interaction.startUniversalRect.centerY + dy,
        };
        const snapped = snapRectToFrame(moved, projectSize, 10);
        setDraftRect(snapped.uRect);
        setGuides(snapped.guides);
        return;
      }

      const startRect = interaction.startUniversalRect;
      const handleDirection = getHandleDirection(interaction.handle);
      const diagonal = rotatePointYUpCW(
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
        10,
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
        centerX: center.x,
        centerY: center.y,
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

      if (!selectedVisualClipForTransform || !baseRect || !finalRect) {
        return;
      }

      void updateClipTransform(selectedVisualClipForTransform.id, {
        transformOffsetX: finalRect.centerX,
        transformOffsetY: finalRect.centerY,
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
    projectSize,
    screenCenter,
    viewScale,
    interaction,
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
    <div ref={panelRef} className="flex h-full w-full flex-col bg-background">
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

      <div
        ref={viewportRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted-foreground/20 p-3"
        onMouseDown={() => {
          if (isTransformMode && !interaction) {
            selectClip(null);
          }
        }}
      >
        <div className="flex h-full w-full items-center justify-center overflow-visible">
          <div
            ref={frameRef}
            className="relative flex items-center justify-center overflow-visible"
            style={{
              ...activeFrameStyle,
              backgroundColor: projectBackgroundColor,
              isolation: "isolate",
            }}
          >
            {activeSharpenFilterDefinitions.length > 0 ? (
              <svg className="pointer-events-none absolute h-0 w-0" aria-hidden="true">
                <defs>
                  {activeSharpenFilterDefinitions.map((definition) => (
                    <filter
                      key={definition.filterId}
                      id={definition.filterId}
                      colorInterpolationFilters="sRGB"
                    >
                      <feConvolveMatrix
                        order="3"
                        kernelMatrix={definition.kernelMatrix}
                        edgeMode="duplicate"
                        preserveAlpha="true"
                      />
                    </filter>
                  ))}
                </defs>
              </svg>
            ) : null}
            <div ref={audioPlaybackHostRef} className="hidden" aria-hidden="true">
              {activeAudioPlaybackLayers.map((layer) => (
                <audio
                  key={layer.clip.id}
                  data-player-audio-clip-id={layer.clip.id}
                  src={layer.canonicalUrl}
                  preload="auto"
                  onLoadedMetadata={(event) =>
                    syncAudioPlaybackElement(event.currentTarget, layer)
                  }
                  onCanPlay={(event) =>
                    syncAudioPlaybackElement(event.currentTarget, layer)
                  }
                />
              ))}
            </div>
            <div
              className={cn(
                "absolute inset-0",
                isTransformMode ? "overflow-visible" : "overflow-hidden",
                previewAsset &&
                  isPreviewVisualAsset &&
                  "flex items-center justify-center",
              )}
            >
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
                  muted
                  preload="auto"
                />
              ) : activeVisualRenderLayers.length > 0 ? (
                <>
                  <div className="absolute inset-0 overflow-hidden">
                    {activeVisualRenderLayers.map((layer) => (
                      <div key={layer.clip.id}>{renderVisualLayer(layer)}</div>
                    ))}
                  </div>
                  {isTransformMode && selectedVisualRenderLayer ? (
                    <>
                      <div
                        className="pointer-events-none absolute overflow-hidden"
                        style={{
                          right: "100%",
                          top: -selectedOverflowExtent.height,
                          width: selectedOverflowExtent.width,
                          height:
                            project.height * viewScale +
                            selectedOverflowExtent.height * 2,
                        }}
                      >
                        {renderVisualLayer(selectedVisualRenderLayer, {
                          opacity:
                            selectedVisualRenderLayer.effectiveOpacity * 0.5,
                          offsetX: selectedOverflowExtent.width,
                          offsetY: selectedOverflowExtent.height,
                        })}
                      </div>
                      <div
                        className="pointer-events-none absolute overflow-hidden"
                        style={{
                          left: "100%",
                          top: -selectedOverflowExtent.height,
                          width: selectedOverflowExtent.width,
                          height:
                            project.height * viewScale +
                            selectedOverflowExtent.height * 2,
                        }}
                      >
                        {renderVisualLayer(selectedVisualRenderLayer, {
                          opacity:
                            selectedVisualRenderLayer.effectiveOpacity * 0.5,
                          offsetX: -(project.width * viewScale),
                          offsetY: selectedOverflowExtent.height,
                        })}
                      </div>
                      <div
                        className="pointer-events-none absolute overflow-hidden"
                        style={{
                          left: 0,
                          bottom: "100%",
                          width: project.width * viewScale,
                          height: selectedOverflowExtent.height,
                        }}
                      >
                        {renderVisualLayer(selectedVisualRenderLayer, {
                          opacity:
                            selectedVisualRenderLayer.effectiveOpacity * 0.5,
                          offsetY: selectedOverflowExtent.height,
                        })}
                      </div>
                      <div
                        className="pointer-events-none absolute overflow-hidden"
                        style={{
                          left: 0,
                          top: "100%",
                          width: project.width * viewScale,
                          height: selectedOverflowExtent.height,
                        }}
                      >
                        {renderVisualLayer(selectedVisualRenderLayer, {
                          opacity:
                            selectedVisualRenderLayer.effectiveOpacity * 0.5,
                          offsetY: -(project.height * viewScale),
                        })}
                      </div>
                    </>
                  ) : null}
                </>
              ) : null}

              {unsupportedLiveVideoLutMessage ? (
                <div className="pointer-events-none absolute bottom-2 left-2 z-10 rounded bg-black/70 px-2 py-1 text-[10px] text-white/80">
                  {unsupportedLiveVideoLutMessage}
                </div>
              ) : null}

              {isTransformMode && displayedScreenRect ? (
                <>
                  {guides.vertical.map((guide, index) => (
                    <div
                      key={`vertical-${guide}-${index}`}
                      className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-cyan-300"
                      style={{ left: screenCenter.x + guide * viewScale }}
                    />
                  ))}
                  {guides.horizontal.map((guide, index) => (
                    <div
                      key={`horizontal-${guide}-${index}`}
                      className="pointer-events-none absolute left-0 right-0 z-20 h-px bg-cyan-300"
                      style={{ top: screenCenter.y - guide * viewScale }}
                    />
                  ))}
                  <div
                    className={cn(
                      "absolute z-20 border border-white/80",
                      !interaction && "cursor-grab",
                      interaction?.type === "move" && "cursor-grabbing",
                    )}
                    style={{
                      left: displayedScreenRect.x,
                      top: displayedScreenRect.y,
                      width: displayedScreenRect.width,
                      height: displayedScreenRect.height,
                      transition: shouldAnimateTransformOverlay
                        ? "left 360ms linear, top 360ms linear, width 360ms linear, height 360ms linear, transform 360ms linear"
                        : undefined,
                      ...visualRotationStyle,
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!displayedRect) return;
                      setInteraction({
                        type: "move",
                        originScreenX: event.clientX,
                        originScreenY: event.clientY,
                        startUniversalRect: displayedRect,
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
                          transform: "translate(-50%, -50%)",
                          transformOrigin: "center center",
                        }}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (!displayedRect) return;
                          setInteraction({
                            type: "resize",
                            handle,
                            originScreenX: event.clientX,
                            originScreenY: event.clientY,
                            startUniversalRect: displayedRect,
                            anchorPoint:
                              getRotatedOppositeCornerAnchorUniversal(
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

        {isPlaybackWaiting ? (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55">
            <div className="flex max-w-sm flex-col items-center gap-3 rounded-md border border-white/10 bg-black/75 px-5 py-4 text-center text-white">
              <LoaderCircle className="h-5 w-5 animate-spin" />
              <div className="text-sm font-medium">
                {waitingOverlayLabel ?? "Waiting for sequence preview"}
              </div>
              {shouldShowSequencePreviewProgress ? (
                <div className="flex w-full flex-col gap-1.5">
                  <div className="h-1.5 w-full rounded-full bg-white/20">
                    <div
                      className="h-full rounded-full bg-white/80 transition-all duration-300"
                      style={{ width: `${sequencePreviewProgressValue}%` }}
                    />
                  </div>
                  <div className="text-[11px] text-white/70">
                    {sequencePreviewProgressLabel}
                  </div>
                </div>
              ) : null}
              {sequencePreviewHint ? (
                <div className="text-xs text-white/70">
                  {sequencePreviewHint}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
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
                            setPlayerZoom((value) =>
                              Math.max(MIN_PLAYER_ZOOM, value - 0.1),
                            )
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
                        min={MIN_PLAYER_ZOOM}
                        max={MAX_PLAYER_ZOOM}
                        step={0.05}
                        gradientFill
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
                            setPlayerZoom((value) =>
                              Math.min(MAX_PLAYER_ZOOM, value + 0.1),
                            )
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
