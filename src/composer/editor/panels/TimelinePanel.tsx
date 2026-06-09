import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type UIEvent,
} from "react";
import {
  Eye,
  EyeOff,
  Film,
  GripVertical,
  Layers,
  Lock,
  MoreVertical,
  Plus,
  Ruler,
  Scissors,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/useToast";
import { composerAssetIpc, composerClipIpc } from "@/composer/ipc/ipc-client";
import type { Clip, ComposerAsset, Track } from "@/composer/types/project";
import { useComposerRuntime } from "../context/ComposerRuntimeContext";
import AudioWaveform from "../../timeline/AudioWaveform";
import { getCachedPeaks } from "../../timeline/waveformCache";
import {
  getInstanceGhostStyle,
  getInstanceGhostWidth,
} from "../utils/instanceDragGhost";
import {
  formatTimelineTime,
  getClipEnd,
  getFrameDuration,
  getTrimEnd,
  MIN_CLIP_DURATION,
  resolveTrackStart,
  snapTimeToFrame,
} from "../utils/timeline";

const RULER_HEIGHT = 34;
const TRACK_ROW_HEIGHT = 60;
const ADD_TRACK_TARGET_HEIGHT = 15;
const CROSS_TRACK_DRAG_TOLERANCE = 15;
const MIN_VIEWPORT_WIDTH = 720;
const MIN_SUBSECOND_PIXEL_WIDTH = 32;
const MAX_SUBSECOND_PIXEL_WIDTH = 128;
const TARGET_TICK_WIDTH = 84;
const MAX_ZOOM_OUT_PROJECT_MULTIPLIER = 3;
const MUTED_VOLUME_EPSILON = 0.0001;

type Interaction =
  | {
      type: "move";
      clip: Clip;
      originX: number;
      duplicate: boolean;
      groupInitialStates: Array<{ id: string; startTime: number; trackId: string }>;
    }
  | {
      type: "trim-left";
      clip: Clip;
      originX: number;
    }
  | {
      type: "trim-right";
      clip: Clip;
      originX: number;
    };

type TrackDropTarget = {
  trackId: string;
  placement: "before" | "after";
};

type PointerPosition = {
  x: number;
  y: number;
};

type TimelineLutProxyState = {
  status: "loading" | "ready" | "error";
  path: string | null;
  derivedMediaId?: string | null;
  operationLabel?: string | null;
  requestKey: string;
};

function isSvgPath(path: string | null | undefined): boolean {
  return path?.match(/\.svg$/i) != null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getSubSecondPixelWidth(zoom: number, stepSeconds: number): number {
  return zoom * stepSeconds;
}

function getTimeTickStep(zoom: number): number {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((step) => step * zoom >= TARGET_TICK_WIDTH) ?? steps[steps.length - 1];
}

function formatRulerTimeLabel(time: number): string {
  if (time < 1) {
    return `${Number(time.toFixed(1))}s`;
  }
  if (time < 10) {
    return `${Number(time.toFixed(1))}s`;
  }
  return formatTimelineTime(time);
}

function getTrackAcceptsAsset(track: Track, asset: ComposerAsset): boolean {
  return track.type === "audio" ? asset.type === "audio" : asset.type !== "audio";
}

function isImageClip(clip: Clip): boolean {
  return clip.sourcePath?.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i) != null;
}

function supportsClipVolume(clip: Clip): boolean {
  return clip.sourcePath?.match(/\.(mp4|webm|mov|avi|mkv|m4v|mp3|wav|ogg|flac|aac|m4a|wma)$/i) != null;
}

function isClipMutedByProperties(clip: Clip): boolean {
  return clip.volume <= MUTED_VOLUME_EPSILON;
}

function getClipFill(trackType: Track["type"], selected: boolean): string {
  if (selected) {
    return trackType === "audio"
      ? "bg-emerald-500/80 border-emerald-300"
      : "bg-sky-500/80 border-sky-300";
  }
  return trackType === "audio"
    ? "bg-emerald-500/45 border-emerald-400/70"
    : "bg-sky-500/45 border-sky-400/70";
}

function isTrackDimmed(track: Track): boolean {
  return !track.visible || track.locked || (track.type === "audio" && track.muted);
}

function getTrackTypeIcon(trackType: Track["type"]) {
  return trackType === "audio" ? Volume2 : Film;
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

export function TimelinePanel() {
  const {
    project,
    tracks,
    clips,
    selectedClipId,
    selectedClipIds,
    playhead,
    isPlaying,
    isPlaybackWaiting,
    zoom,
    timelineDuration,
    canUndo,
    seek,
    stopPlayback,
    selectClip,
    setZoom,
    addTrack,
    deleteTrack,
    reorderTrack,
    updateTrack,
    addAssetToTrack,
    duplicateClip,
    getMediaDuration,
    moveClip,
    trimClip,
    splitSelectedClip,
    deleteSelectedClip,
    undo,
    getAssetUrl,
  } = useComposerRuntime();
  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [draftClip, setDraftClip] = useState<Clip | null>(null);
  const [draftGroupClips, setDraftGroupClips] = useState<Map<string, Clip>>(new Map());
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
  const [trackDropTarget, setTrackDropTarget] = useState<TrackDropTarget | null>(null);
  const [moveGhostPointer, setMoveGhostPointer] = useState<PointerPosition | null>(null);
  const [isCrossTrackDrag, setIsCrossTrackDrag] = useState(false);
  const [timelineLutProxyStates, setTimelineLutProxyStates] = useState<
    Record<string, TimelineLutProxyState>
  >({});
  const [libraryAssets, setLibraryAssets] = useState<ComposerAsset[]>([]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackListRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const trackRowsRef = useRef<HTMLDivElement | null>(null);
  const syncingScrollSourceRef = useRef<"tracks" | "viewport" | null>(null);
  const previousZoomRef = useRef(zoom);
  const autoFitProjectRef = useRef<string | null>(null);
  const groupDragRef = useRef<{ snappedDelta: number; targetTrackId: string } | null>(null);
  const [viewportWidth, setViewportWidth] = useState(MIN_VIEWPORT_WIDTH);
  const timelineStepDuration = useMemo(() => getFrameDuration(project.fps), [project.fps]);
  const tracksById = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);

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
    if (!project.id || !libraryAssets.some((asset) => asset.status === "processing")) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadLibraryAssets();
    }, 2000);
    return () => window.clearInterval(intervalId);
  }, [libraryAssets, loadLibraryAssets, project.id]);

  const minZoom = useMemo(() => {
    const safeDuration = Math.max(project.duration, timelineStepDuration);
    return viewportWidth / (safeDuration * MAX_ZOOM_OUT_PROJECT_MULTIPLIER);
  }, [project.duration, timelineStepDuration, viewportWidth]);
  const maxZoom = useMemo(
    () => MAX_SUBSECOND_PIXEL_WIDTH / timelineStepDuration,
    [timelineStepDuration],
  );
  const timelineWidth = Math.max(timelineDuration * zoom, viewportWidth);
  const timelineLutProxyRequests = useMemo(
    () =>
      clips
        .filter(
          (clip) =>
            typeof clip.sourcePath === "string" &&
            clip.sourcePath.length > 0 &&
            !isSvgPath(clip.sourcePath) &&
            typeof clip.adjustments?.lutAssetId === "string" &&
            clip.adjustments.lutAssetId.length > 0,
        )
        .map((clip) => ({
          clipId: clip.id,
          requestKey: `${clip.sourcePath ?? ""}|${clip.adjustments?.lutAssetId ?? ""}`,
          existingProxyPath:
            typeof clip.lutProxyPath === "string" && clip.lutProxyPath.length > 0
              ? clip.lutProxyPath
              : null,
        })),
    [clips],
  );
  const rulerTicks = useMemo(() => {
    const tickStep = getTimeTickStep(zoom);
    const totalTicks = Math.ceil(timelineDuration / tickStep);
    return Array.from({ length: totalTicks + 1 }, (_, index) => {
      const time = Number((index * tickStep).toFixed(6));
      return {
        key: `time-${time}`,
        left: time * zoom,
        label: formatRulerTimeLabel(time),
        major: tickStep >= 1 || Math.abs(time - Math.round(time)) < 0.0001,
      };
    }).filter((tick) => tick.left <= timelineWidth);
  }, [timelineDuration, timelineWidth, zoom]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateWidth = () => {
      setViewportWidth(Math.max(element.clientWidth, MIN_VIEWPORT_WIDTH));
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const boundedZoom = clamp(zoom, minZoom, maxZoom);
    if (Math.abs(boundedZoom - zoom) > 0.001) {
      setZoom(boundedZoom);
    }
  }, [maxZoom, minZoom, setZoom, zoom]);

  useEffect(() => {
    if (!project.id) {
      return;
    }

    const requestMap = new Map(
      timelineLutProxyRequests.map((request) => [request.clipId, request]),
    );

    setTimelineLutProxyStates((current) => {
      const next: Record<string, TimelineLutProxyState> = {};
      for (const request of timelineLutProxyRequests) {
        if (request.existingProxyPath) {
          next[request.clipId] = {
            status: "ready",
            path: request.existingProxyPath,
            derivedMediaId:
              clips.find((clip) => clip.id === request.clipId)?.derivedMediaId ?? null,
            operationLabel: "LUT",
            requestKey: request.requestKey,
          };
          continue;
        }

        const previous = current[request.clipId];
        next[request.clipId] =
          previous && previous.requestKey === request.requestKey
            ? previous
            : {
                status: "loading",
                path: null,
                requestKey: request.requestKey,
              };
      }
      return next;
    });

    const pendingRequests = timelineLutProxyRequests.filter(
      (request) => !request.existingProxyPath,
    );
    if (pendingRequests.length === 0) {
      return;
    }

    let cancelled = false;

    void Promise.all(
      pendingRequests.map(async (request) => {
        try {
          const resolved = await composerClipIpc.resolveTimelineLutProxy({
            projectId: project.id,
            clipId: request.clipId,
          });

          return {
            clipId: request.clipId,
            requestKey: request.requestKey,
            status: resolved.status ?? "ready",
            path: resolved.path,
            derivedMediaId: resolved.derivedMediaId,
            operationLabel: resolved.operationLabel,
          };
        } catch (error) {
          return {
            clipId: request.clipId,
            requestKey: request.requestKey,
            status: "error" as const,
            path: null,
            derivedMediaId: null,
            operationLabel: null,
            errorMessage: error instanceof Error ? error.message : "Failed to resolve LUT proxy.",
          };
        }
      }),
    ).then((results) => {
      if (cancelled) {
        return;
      }

      setTimelineLutProxyStates((current) => {
        const next = { ...current };
        for (const result of results) {
          if (!requestMap.has(result.clipId)) {
            delete next[result.clipId];
            continue;
          }
          if (result.status === "error") {
            console.warn(
              `Failed to resolve LUT proxy for clip ${result.clipId} in TimelinePanel`,
              result.errorMessage,
            );
          }
          next[result.clipId] = {
            status: result.status,
            path: result.path,
            derivedMediaId: result.derivedMediaId,
            operationLabel: result.operationLabel,
            requestKey: result.requestKey,
          };
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [project.id, timelineLutProxyRequests]);

  useEffect(() => {
    if (viewportWidth <= 0 || autoFitProjectRef.current === project.id) {
      return;
    }

    const fittedZoom = clamp(
      viewportWidth / Math.max(timelineDuration, timelineStepDuration),
      minZoom,
      maxZoom,
    );
    autoFitProjectRef.current = project.id;
    previousZoomRef.current = fittedZoom;
    setZoom(fittedZoom);
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
    }
  }, [maxZoom, minZoom, project.id, setZoom, timelineDuration, timelineStepDuration, viewportWidth]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const previousZoom = previousZoomRef.current;
    if (Math.abs(previousZoom - zoom) < 0.001) {
      return;
    }

    const playheadOffset = playhead * previousZoom - element.scrollLeft;
    const nextScrollLeft = clamp(
      playhead * zoom - playheadOffset,
      0,
      Math.max(0, timelineWidth - element.clientWidth),
    );
    element.scrollLeft = nextScrollLeft;
    previousZoomRef.current = zoom;
  }, [playhead, timelineWidth, zoom]);

  const syncTimelineScroll = (source: "tracks" | "viewport", scrollTop: number) => {
    const target = source === "viewport" ? trackListRef.current : viewportRef.current;
    if (!target || Math.abs(target.scrollTop - scrollTop) < 1) {
      return;
    }

    syncingScrollSourceRef.current = source;
    target.scrollTop = scrollTop;
  };

  const handleTrackListScroll = (event: UIEvent<HTMLDivElement>) => {
    if (syncingScrollSourceRef.current === "viewport") {
      syncingScrollSourceRef.current = null;
      return;
    }

    syncTimelineScroll("tracks", event.currentTarget.scrollTop);
  };

  const handleViewportScroll = (event: UIEvent<HTMLDivElement>) => {
    if (syncingScrollSourceRef.current === "tracks") {
      syncingScrollSourceRef.current = null;
      return;
    }

    syncTimelineScroll("viewport", event.currentTarget.scrollTop);
  };

  const handleZoomToFit = () => {
    const fittedZoom = viewportWidth / Math.max(timelineDuration, timelineStepDuration);
    setZoom(clamp(fittedZoom, minZoom, maxZoom));
  };

  const handleZoomStep = (direction: -1 | 1) => {
    const nextStepWidth = clamp(
      getSubSecondPixelWidth(zoom, timelineStepDuration) + direction * 8,
      MIN_SUBSECOND_PIXEL_WIDTH,
      MAX_SUBSECOND_PIXEL_WIDTH,
    );
    setZoom(clamp(nextStepWidth / timelineStepDuration, minZoom, maxZoom));
  };

  const resolveTrackFromClientY = (clientY: number, fallbackTrackId: string): Track | null => {
    const rowsElement = trackRowsRef.current;
    const viewportElement = viewportRef.current;
    if (!rowsElement || !viewportElement) {
      return tracksById.get(fallbackTrackId) ?? null;
    }

    const rect = rowsElement.getBoundingClientRect();
    const relativeY = clientY - rect.top + viewportElement.scrollTop;
    const rowIndex = Math.floor(relativeY / TRACK_ROW_HEIGHT);
    const candidate = tracks[rowIndex];
    return candidate ?? tracksById.get(fallbackTrackId) ?? null;
  };

  const isWithinSourceTrackDragZone = (clientY: number, sourceTrackId: string): boolean => {
    const rowsElement = trackRowsRef.current;
    const viewportElement = viewportRef.current;
    const sourceTrackIndex = tracks.findIndex((track) => track.id === sourceTrackId);
    if (!rowsElement || !viewportElement || sourceTrackIndex < 0) {
      return true;
    }

    const rect = rowsElement.getBoundingClientRect();
    const relativeY = clientY - rect.top + viewportElement.scrollTop;
    const rowTop = ADD_TRACK_TARGET_HEIGHT + sourceTrackIndex * TRACK_ROW_HEIGHT;
    const rowBottom = rowTop + TRACK_ROW_HEIGHT;
    return (
      relativeY >= rowTop - CROSS_TRACK_DRAG_TOLERANCE &&
      relativeY <= rowBottom + CROSS_TRACK_DRAG_TOLERANCE
    );
  };

  useEffect(() => {
    if (!interaction) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      const deltaSeconds = (event.clientX - interaction.originX) / zoom;
      const baseClip = interaction.clip;
      const trackClips = (clips.filter(
        (clip) => clip.trackId === baseClip.trackId && clip.id !== baseClip.id,
      )).sort((left, right) => left.startTime - right.startTime);
      const previousClip = [...trackClips]
        .reverse()
        .find((clip) => getClipEnd(clip) <= baseClip.startTime);
      const nextClip = trackClips.find((clip) => clip.startTime >= getClipEnd(baseClip));

      if (interaction.type === "move") {
        setMoveGhostPointer({ x: event.clientX, y: event.clientY });
        const hasGroup = interaction.groupInitialStates.length > 1;
        const sourceTrack = tracksById.get(baseClip.trackId);

        // Cross-track drag only allowed for single clip
        let targetTrack = sourceTrack;
        if (!hasGroup) {
          const withinSourceTrackZone = isWithinSourceTrackDragZone(
            event.clientY,
            baseClip.trackId,
          );
          const hoveredTrack = resolveTrackFromClientY(event.clientY, baseClip.trackId);
          targetTrack =
            !withinSourceTrackZone &&
            sourceTrack &&
            hoveredTrack &&
            hoveredTrack.id !== sourceTrack.id &&
            hoveredTrack.type === sourceTrack.type &&
            !hoveredTrack.locked
              ? hoveredTrack
              : sourceTrack;
          setIsCrossTrackDrag(Boolean(targetTrack && sourceTrack && targetTrack.id !== sourceTrack.id));
        } else {
          setIsCrossTrackDrag(false);
        }

        if (!targetTrack) {
          return;
        }
        const trackClips = clips
          .filter(
            (clip) =>
              clip.trackId === targetTrack.id &&
              (interaction.duplicate || clip.id !== baseClip.id),
          )
          .sort((left, right) => left.startTime - right.startTime);
        const nextStartTime = resolveTrackStart(
          baseClip.startTime + deltaSeconds,
          baseClip.duration,
          trackClips,
          project.fps,
        );
        const snappedDelta = nextStartTime - baseClip.startTime;
        groupDragRef.current = { snappedDelta, targetTrackId: targetTrack.id };
        setDraftClip({ ...baseClip, startTime: nextStartTime, trackId: targetTrack.id });

        // Update all group clips visually
        if (hasGroup) {
          const newDrafts = new Map<string, Clip>();
          for (const initial of interaction.groupInitialStates) {
            if (initial.id === baseClip.id) {
              newDrafts.set(initial.id, { ...baseClip, startTime: nextStartTime, trackId: targetTrack.id });
            } else {
              const clipObj = clips.find((c) => c.id === initial.id);
              if (clipObj) {
                const clampedStart = Math.max(0, snapTimeToFrame(initial.startTime + snappedDelta, project.fps));
                newDrafts.set(initial.id, { ...clipObj, startTime: clampedStart });
              }
            }
          }
          setDraftGroupClips(newDrafts);
        }
        return;
      }

      if (interaction.type === "trim-left") {
        const maxLeftTrim = baseClip.duration - MIN_CLIP_DURATION;
        if (isImageClip(baseClip)) {
          const minimumStart = previousClip ? getClipEnd(previousClip) : 0;
          const delta = Math.min(
            maxLeftTrim,
            Math.max(minimumStart - baseClip.startTime, deltaSeconds),
          );
          setDraftClip({
            ...baseClip,
            startTime: snapTimeToFrame(baseClip.startTime + delta, project.fps),
            duration: Math.max(MIN_CLIP_DURATION, snapTimeToFrame(baseClip.duration - delta, project.fps)),
            trimStart: 0,
            trimEnd: 0,
          });
          return;
        }
        // Peak-snapping for audio clips (poC): if we have a cached waveform,
        // snap the left trim to the nearest strong peak within tolerance.
        try {
          const newTrimStart = snapTimeToFrame(baseClip.trimStart + delta, project.fps);
          const assetUrlForPeaks = baseClip.sourcePath ? getAssetUrl(baseClip.sourcePath) ?? baseClip.sourcePath : undefined;
          const peakEntry = assetUrlForPeaks ? getCachedPeaks(assetUrlForPeaks) : undefined;
          if (peakEntry && peakEntry.peaks.length > 0) {
            const { peaks, duration: assetDuration } = peakEntry;
            const targetBuckets = peaks.length;
            const nearestIndex = Math.min(targetBuckets - 1, Math.max(0, Math.round((newTrimStart / Math.max(0.0001, assetDuration)) * targetBuckets)));
            // search neighbors for the highest nearby peak
            let bestIndex = nearestIndex;
            let bestScore = peaks[nearestIndex] ?? 0;
            for (let k = Math.max(0, nearestIndex - 3); k <= Math.min(targetBuckets - 1, nearestIndex + 3); k++) {
              if ((peaks[k] ?? 0) > bestScore) {
                bestScore = peaks[k] ?? 0;
                bestIndex = k;
              }
            }
            const nearestPeakTime = (bestIndex + 0.5) / targetBuckets * assetDuration;
            const peakSnapTolerance = 0.08; // seconds
            const peakAmplitudeThreshold = 0.55; // normalized
            if (Math.abs(nearestPeakTime - newTrimStart) <= peakSnapTolerance && bestScore >= peakAmplitudeThreshold) {
              const adjustedDelta = nearestPeakTime - baseClip.trimStart;
              setDraftClip({
                ...baseClip,
                startTime: snapTimeToFrame(baseClip.startTime + adjustedDelta, project.fps),
                duration: Math.max(MIN_CLIP_DURATION, snapTimeToFrame(baseClip.duration - adjustedDelta, project.fps)),
                trimStart: snapTimeToFrame(nearestPeakTime, project.fps),
              });
              return;
            }
          }
        } catch {
          // ignore any waveform lookup errors — fallback to normal behaviour
        }

        const minimumStart = Math.max(
          previousClip ? getClipEnd(previousClip) : 0,
          baseClip.startTime - baseClip.trimStart,
        );
        const delta = Math.min(
          maxLeftTrim,
          Math.max(minimumStart - baseClip.startTime, deltaSeconds),
        );
        setDraftClip({
          ...baseClip,
          startTime: snapTimeToFrame(baseClip.startTime + delta, project.fps),
          duration: Math.max(MIN_CLIP_DURATION, snapTimeToFrame(baseClip.duration - delta, project.fps)),
          trimStart: snapTimeToFrame(baseClip.trimStart + delta, project.fps),
        });
        return;
      }

      const rightHandleRoom = getTrimEnd(baseClip);
      const maximumEnd = nextClip?.startTime ?? Number.POSITIVE_INFINITY;
      if (isImageClip(baseClip)) {
        const delta = Math.max(
          -(baseClip.duration - MIN_CLIP_DURATION),
          Math.min(maximumEnd - getClipEnd(baseClip), deltaSeconds),
        );
        setDraftClip({
          ...baseClip,
          duration: Math.max(MIN_CLIP_DURATION, snapTimeToFrame(baseClip.duration + delta, project.fps)),
          trimEnd: 0,
        });
        return;
      }

      const delta = Math.max(
        -(baseClip.duration - MIN_CLIP_DURATION),
        Math.min(
          rightHandleRoom,
          Math.min(maximumEnd - getClipEnd(baseClip), deltaSeconds),
        ),
      );
      setDraftClip({
        ...baseClip,
        duration: Math.max(MIN_CLIP_DURATION, snapTimeToFrame(baseClip.duration + delta, project.fps)),
        trimEnd: snapTimeToFrame(rightHandleRoom - delta, project.fps),
      });
    };

    const handleMouseUp = () => {
      const currentInteraction = interaction;
      const currentDraft = draftClip;
      setInteraction(null);
      setDraftClip(null);
      setDraftGroupClips(new Map());
      setMoveGhostPointer(null);
      setIsCrossTrackDrag(false);

      if (!currentDraft) {
        return;
      }

      if (currentInteraction.type === "move") {
        const shouldDuplicate =
          currentInteraction.duplicate &&
          (currentDraft.trackId !== currentInteraction.clip.trackId ||
            Math.abs(currentDraft.startTime - currentInteraction.clip.startTime) >= 0.001);
        if (shouldDuplicate) {
          void duplicateClip(
            currentInteraction.clip.id,
            currentDraft.startTime,
            currentDraft.trackId,
          );
          groupDragRef.current = null;
          return;
        }
        // Move the base clip
        void moveClip(currentDraft.id, currentDraft.startTime, currentDraft.trackId);
        // Move other selected clips in the group — each stays on its own track
        const groupDrag = groupDragRef.current;
        if (groupDrag && currentInteraction.groupInitialStates.length > 1) {
          for (const initial of currentInteraction.groupInitialStates) {
            if (initial.id === currentDraft.id) continue;
            const newStart = snapTimeToFrame(initial.startTime + groupDrag.snappedDelta, project.fps);
            void moveClip(initial.id, Math.max(0, newStart), initial.trackId);
          }
        }
        groupDragRef.current = null;
        return;
      }

      void trimClip(currentDraft.id, {
        startTime: currentDraft.startTime,
        duration: currentDraft.duration,
        trimStart: currentDraft.trimStart,
        trimEnd: currentDraft.trimEnd,
      });
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [clips, draftClip, draftGroupClips, interaction, moveClip, project.fps, trimClip, zoom]);

  const handleTimelineSeek = (
    event: MouseEvent<HTMLDivElement>,
    element: HTMLDivElement,
  ) => {
    selectClip(null);
    const rect = element.getBoundingClientRect();
    const time = snapTimeToFrame((event.clientX - rect.left) / zoom, project.fps);
    if (isPlaying) {
      stopPlayback(time);
      return;
    }
    seek(time);
  };

  const seekToTimelineClientX = (clientX: number, element: HTMLDivElement) => {
    selectClip(null);
    const rect = element.getBoundingClientRect();
    const time = snapTimeToFrame((clientX - rect.left) / zoom, project.fps);
    if (isPlaying) {
      stopPlayback(time);
      return;
    }
    seek(time);
  };

  useEffect(() => {
    if (!isDraggingPlayhead) {
      return;
    }

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const element = rulerRef.current;
      if (!element) {
        return;
      }
      seekToTimelineClientX(event.clientX, element);
    };

    const handleMouseUp = () => {
      setIsDraggingPlayhead(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDraggingPlayhead, isPlaying, project.fps, seek, selectClip, stopPlayback, zoom]);

  const handleAssetDrop = async (
    event: DragEvent<HTMLDivElement>,
    track: Track,
  ) => {
    event.preventDefault();
    setDragOverTrackId(null);

    const payload = event.dataTransfer.getData("application/x-composer-asset");
    if (!payload) {
      return;
    }

    const asset = JSON.parse(payload) as ComposerAsset;

    // Gate: only ready assets can be dropped
    if (asset.status && asset.status !== "ready") {
      return;
    }

    if (track.locked) {
      return;
    }
    if (!getTrackAcceptsAsset(track, asset)) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    // Use canonical safe media path: transcoded working file if available, otherwise original
    const mediaPath = asset.workingPath ?? asset.filePath;
    const duration =
      asset.type === "image"
        ? 5
        : await getMediaDuration(mediaPath, asset.type);
    const trackClips = clips.filter((clip) => clip.trackId === track.id);
    const startTime = resolveTrackStart(
      (event.clientX - rect.left) / zoom,
      duration,
      trackClips,
      project.fps,
    );
    await addAssetToTrack(track.id, asset, startTime, duration);
  };

  const visibleClipsByTrack = useMemo(() => {
    const byTrack = new Map<string, Clip[]>();
    for (const track of tracks) {
      byTrack.set(track.id, []);
    }

    for (const clip of clips) {
      const list = byTrack.get(clip.trackId);
      if (list) {
        list.push(clip);
      }
    }

    return byTrack;
  }, [clips, tracks]);

  const renderTimelineClip = ({
    renderedClip,
    sourceClip,
    track,
    selected,
    onClipMouseDown,
    interactive = true,
    clipKey,
  }: {
    renderedClip: Clip;
    sourceClip: Clip;
    track: Track;
    selected: boolean;
    onClipMouseDown?: (event: MouseEvent<HTMLDivElement>) => void;
    interactive?: boolean;
    clipKey: string;
  }) => {
    const clipLutState = timelineLutProxyStates[sourceClip.id] ?? null;
    const sourceAsset = findAssetForClip(sourceClip, libraryAssets);
    const hasAudioSpec =
      track.type === "audio" ||
      sourceAsset?.type === "audio" ||
      sourceAsset?.hasAudio === true ||
      supportsClipVolume(sourceClip);
    const AudioIndicatorIcon =
      hasAudioSpec && isClipMutedByProperties(sourceClip) ? VolumeX : Volume2;
    const hasLut =
      typeof renderedClip.adjustments?.lutAssetId === "string" &&
      renderedClip.adjustments.lutAssetId.length > 0;
    const hasDerivedVisual = Boolean(renderedClip.derivedMediaId || clipLutState?.derivedMediaId);
    const isLutGenerating =
      hasLut &&
      hasDerivedVisual &&
      clipLutState?.status === "loading";
    const isLutReady =
      hasLut &&
      hasDerivedVisual &&
      (Boolean(renderedClip.lutProxyPath) || clipLutState?.status === "ready");
    const isLutError = hasLut && clipLutState?.status === "error";

    // Determine whether to show waveform: only when the clip has a sourcePath,
    // the track's audio is enabled (not muted), and the clip/asset contains audio.
    const showWaveform = Boolean(renderedClip.sourcePath) &&
      !track.muted &&
      (track.type === "audio" ||
        (track.type === "video" && (sourceAsset?.hasAudio === true || supportsClipVolume(sourceClip) || sourceAsset?.type === "audio")));

    return (
      <div
        key={clipKey}
        className={cn(
          "absolute top-2 flex h-[44px] items-stretch overflow-hidden rounded-md border shadow-sm",
          getClipFill(track.type, selected),
          isTrackDimmed(track) && "opacity-40",
          interactive && selected && !interaction && "cursor-grab",
          interactive && selected && interaction?.type === "move" && "cursor-grabbing",
          !interactive && "pointer-events-none",
        )}
        style={{
          left: renderedClip.startTime * zoom,
          width: Math.max(renderedClip.duration * zoom, 18),
        }}
        onMouseDown={onClipMouseDown}
      >
        {showWaveform ? (
          <AudioWaveform
            src={getAssetUrl(renderedClip.sourcePath) ?? renderedClip.sourcePath}
            width={Math.max(renderedClip.duration * zoom, 18)}
            height={44}
          />
        ) : null}
        {hasDerivedVisual ? (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                isLutGenerating
                  ? "repeating-linear-gradient(135deg, rgba(255,136,0,0.18) 0px, rgba(255,136,0,0.18) 8px, rgba(255,255,255,0.08) 8px, rgba(255,255,255,0.08) 16px)"
                  : "repeating-linear-gradient(135deg, rgba(0,255,0,0.14) 0px, rgba(0,255,0,0.14) 8px, rgba(255,255,255,0.06) 8px, rgba(255,255,255,0.06) 16px)",
              backgroundSize: "24px 24px",
              animation: isLutGenerating
                ? "composer-lut-generating-stripes 0.9s linear infinite"
                : undefined,
            }}
          />
        ) : null}
        <button
          type="button"
          className="relative z-10 w-2 shrink-0 cursor-ew-resize bg-black/20 hover:bg-black/30"
          onMouseDown={(event) => {
            if (!interactive || track.locked) {
              return;
            }
            event.stopPropagation();
            selectClip(renderedClip.id, event.shiftKey);
            setInteraction({
              type: "trim-left",
              clip: sourceClip,
              originX: event.clientX,
            });
            setDraftClip(sourceClip);
          }}
          aria-label="Trim clip start"
          tabIndex={interactive ? 0 : -1}
        />
        <div className="relative z-10 flex min-w-0 flex-1 flex-col justify-center px-2 text-left">
          <div className="truncate text-xs font-medium text-white">
            {renderedClip.sourcePath?.split(/[\\/]/).pop() ?? "Clip"}
          </div>
          <div className="truncate text-[10px] text-white/80">
            {hasAudioSpec ? <AudioIndicatorIcon className="mr-1 inline h-3 w-3 align-[-1px]" /> : null}
            <span>{formatTimelineTime(renderedClip.duration)}</span>
            {hasLut ? (
              <>
                <span className="px-1">-</span>
                <span
                  className={cn(
                    isLutGenerating && "text-[#f80]",
                    isLutReady && "text-[#0f0]",
                    isLutError && "text-red-300",
                  )}
                >
                  {isLutGenerating ? "LUT generating" : isLutError ? "LUT error" : "LUT"}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          className="relative z-10 w-2 shrink-0 cursor-ew-resize bg-black/20 hover:bg-black/30"
          onMouseDown={(event) => {
            if (!interactive || track.locked) {
              return;
            }
            event.stopPropagation();
            selectClip(renderedClip.id, event.shiftKey);
            setInteraction({
              type: "trim-right",
              clip: sourceClip,
              originX: event.clientX,
            });
            setDraftClip(sourceClip);
          }}
          aria-label="Trim clip end"
          tabIndex={interactive ? 0 : -1}
        />
      </div>
    );
  };

  const moveGhostModel = useMemo(() => {
    if (
      !moveGhostPointer ||
      !isCrossTrackDrag ||
      interaction?.type !== "move" ||
      !draftClip
    ) {
      return null;
    }

    return {
      label: draftClip.sourcePath?.split(/[\\/]/).pop() ?? "Clip",
      detail: formatTimelineTime(draftClip.duration),
      trackType: tracksById.get(draftClip.trackId)?.type ?? "video",
      width: getInstanceGhostWidth(draftClip.duration, zoom),
    } as const;
  }, [
    draftClip,
    interaction?.type,
    isCrossTrackDrag,
    moveGhostPointer,
    tracksById,
    zoom,
  ]);

  const handleAddTrack = (type: Track["type"], placement: "start" | "end") => {
    const label = type === "audio" ? "audio" : "video";
    void addTrack(type, placement).catch((error: unknown) => {
      toast({
        title: `Couldn't add ${label} track`,
        description: error instanceof Error ? error.message : "Try again.",
        variant: "destructive",
      });
    });
  };

  const handleDeleteTrack = (track: Track) => {
    const sameTypeTracks = tracks.filter((candidate) => candidate.type === track.type);
    const clipCount = clips.filter((clip) => clip.trackId === track.id).length;
    if (clipCount > 0) {
      toast({
        title: "Track is not empty",
        description: `Move or delete the ${clipCount} clip${clipCount === 1 ? "" : "s"} on ${track.name} before removing the track.`,
        variant: "destructive",
      });
      return;
    }
    if (sameTypeTracks.length <= 1) {
      toast({
        title: "Track can't be deleted",
        description: `Keep at least one ${track.type} track in the timeline.`,
      });
      return;
    }
    void deleteTrack(track.id).catch((error: unknown) => {
      toast({
        title: "Couldn't delete track",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "destructive",
      });
    });
  };

  const handleTrackDragStart = (event: DragEvent<HTMLButtonElement>, track: Track) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", track.id);
    setDraggingTrackId(track.id);
    setTrackDropTarget(null);
  };

  const handleTrackDragOver = (event: DragEvent<HTMLDivElement>, track: Track) => {
    if (!draggingTrackId || draggingTrackId === track.id) {
      return;
    }

    const draggingTrack = tracksById.get(draggingTrackId);
    if (!draggingTrack || draggingTrack.type !== track.type) {
      setTrackDropTarget(null);
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const placement = event.clientY - bounds.top < bounds.height / 2 ? "before" : "after";
    setTrackDropTarget({ trackId: track.id, placement });
  };

  const handleTrackDrop = (event: DragEvent<HTMLDivElement>, track: Track) => {
    event.preventDefault();
    if (!draggingTrackId || !trackDropTarget || trackDropTarget.trackId !== track.id) {
      return;
    }

    const draggingTrack = tracksById.get(draggingTrackId);
    if (!draggingTrack || draggingTrack.type !== track.type) {
      setDraggingTrackId(null);
      setTrackDropTarget(null);
      return;
    }

    void reorderTrack(draggingTrackId, track.id, trackDropTarget.placement).catch((error: unknown) => {
      toast({
        title: "Couldn't reorder track",
        description:
          error instanceof Error ? error.message : "Try again.",
        variant: "destructive",
      });
    });
    setDraggingTrackId(null);
    setTrackDropTarget(null);
  };

  const handleTrackDragEnd = () => {
    setDraggingTrackId(null);
    setTrackDropTarget(null);
  };

  return (
    <div className="flex h-full w-full flex-col border-t border-border bg-background">
      <style>{`
        @keyframes composer-lut-generating-stripes {
          0% { background-position: 0 0; }
          100% { background-position: 24px 0; }
        }
      `}</style>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Layers className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium text-muted-foreground">Timeline</span>
        <div className="text-[11px] text-muted-foreground">
          {formatTimelineTime(Math.min(playhead, project.duration))} / {formatTimelineTime(project.duration)}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleZoomToFit}
            >
              <Ruler className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom to fit timeline</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleZoomStep(-1)}
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom out</TooltipContent>
        </Tooltip>
        <div className="w-28 px-1">
          <Slider
            value={[zoom]}
            min={minZoom}
            max={maxZoom}
            step={0.1}
            gradientFill
            onValueChange={(values) => {
              const nextZoom = values[0];
              if (typeof nextZoom === "number") {
                setZoom(clamp(nextZoom, minZoom, maxZoom));
              }
            }}
            aria-label="Timeline zoom"
          />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleZoomStep(1)}
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom in</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void splitSelectedClip()}
                disabled={!selectedClipId}
              >
                <Scissors className="h-4 w-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Split selected clip</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void deleteSelectedClip()}
                disabled={!selectedClipId}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Delete selected clip</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void undo()}
                disabled={!canUndo}
              >
                <Undo2 className="h-4 w-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Undo</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="grid h-full min-h-0 grid-cols-[136px_minmax(0,1fr)]">
          <div
            ref={trackListRef}
            className="hide-scrollbar min-h-0 overflow-y-auto border-r border-border bg-muted/20"
            onScroll={handleTrackListScroll}
          >
            <div
              className="sticky top-0 z-20 flex items-center border-b border-border bg-muted/95 px-3 text-[11px] uppercase tracking-wide text-muted-foreground backdrop-blur"
              style={{ height: RULER_HEIGHT }}
            >
              Tracks
            </div>
            <div className="min-h-0">
              <button
                type="button"
                className="flex w-full items-center justify-center border-b border-border/70 bg-background/35 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                style={{ height: ADD_TRACK_TARGET_HEIGHT }}
                onClick={() => handleAddTrack("video", "start")}
                aria-label="Add video track"
              >
                <Plus className="h-2.5 w-2.5" />
              </button>
              {tracks.map((track) => {
                const TrackIcon = getTrackTypeIcon(track.type);
                const dropBefore =
                  trackDropTarget?.trackId === track.id && trackDropTarget.placement === "before";
                const dropAfter =
                  trackDropTarget?.trackId === track.id && trackDropTarget.placement === "after";

                return (
                  <div
                    key={track.id}
                    className={cn(
                      "relative flex items-center border-b border-border text-sm transition-colors",
                      isTrackDimmed(track) && "bg-muted/30",
                      draggingTrackId === track.id && "opacity-70",
                    )}
                    style={{ height: TRACK_ROW_HEIGHT }}
                    onDragOver={(event) => handleTrackDragOver(event, track)}
                    onDrop={(event) => handleTrackDrop(event, track)}
                    onDragLeave={() => {
                      if (trackDropTarget?.trackId === track.id) {
                        setTrackDropTarget(null);
                      }
                    }}
                  >
                    {dropBefore ? (
                      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-primary" />
                    ) : null}
                    {dropAfter ? (
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-primary" />
                    ) : null}
                    {track.locked ? (
                      <div
                        className="pointer-events-none absolute inset-0 opacity-40"
                        style={{
                          backgroundImage:
                            "repeating-linear-gradient(135deg, rgba(255,255,255,0.08) 0px, rgba(255,255,255,0.08) 6px, transparent 6px, transparent 12px)",
                        }}
                      />
                    ) : null}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          draggable
                          className="relative z-10 flex h-full w-5 shrink-0 cursor-grab items-center justify-center border-r border-border/70 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground active:cursor-grabbing"
                          onDragStart={(event) => handleTrackDragStart(event, track)}
                          onDragEnd={handleTrackDragEnd}
                          aria-label={`Reorder ${track.name}`}
                        >
                          <GripVertical className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Drag to reorder {track.type} tracks</TooltipContent>
                    </Tooltip>
                    <div className="relative z-10 flex min-w-0 flex-1 items-center justify-between gap-1 px-2">
                      <div className="flex h-6 w-6 items-center justify-center text-muted-foreground">
                        <TrackIcon className="h-4 w-4" />
                      </div>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "h-6 w-6",
                              track.locked && "bg-foreground/10 text-foreground hover:bg-foreground/15",
                            )}
                            onClick={() => void updateTrack(track.id, { locked: !track.locked })}
                          >
                            <Lock className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{track.locked ? "Unlock track" : "Lock track"}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "h-6 w-6",
                              track.type === "audio" && "pointer-events-none invisible",
                              !track.visible && "bg-foreground/10 text-foreground hover:bg-foreground/15",
                            )}
                            onClick={() => void updateTrack(track.id, { visible: !track.visible })}
                          >
                            {track.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{track.visible ? "Hide track" : "Show track"}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "h-6 w-6",
                              track.muted && "bg-foreground/10 text-foreground hover:bg-foreground/15",
                            )}
                            onClick={() => void updateTrack(track.id, { muted: !track.muted })}
                          >
                            {track.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{track.muted ? "Unmute track" : "Mute track"}</TooltipContent>
                      </Tooltip>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-6 w-6">
                            <MoreVertical className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleDeleteTrack(track)}>
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                className="flex w-full items-center justify-center border-b border-border/70 bg-background/35 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                style={{ height: ADD_TRACK_TARGET_HEIGHT }}
                onClick={() => handleAddTrack("audio", "end")}
                aria-label="Add audio track"
              >
                <Plus className="h-2.5 w-2.5" />
              </button>
            </div>
          </div>

          <div
            ref={viewportRef}
            className="min-w-0 min-h-0 overflow-auto"
            onScroll={handleViewportScroll}
          >
            <div className="relative" style={{ width: timelineWidth }}>
                <div
                  ref={rulerRef}
                  className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur"
                  style={{ height: RULER_HEIGHT }}
                  onMouseDown={(event) =>
                  handleTimelineSeek(event, event.currentTarget as HTMLDivElement)
                }
              >
                <div className="relative h-full">
                  {rulerTicks.map((tick) => (
                    <div
                      key={tick.key}
                      className={cn(
                        "absolute top-0 bottom-0 border-l",
                        tick.major ? "border-border/70" : "border-border/35",
                      )}
                      style={{ left: tick.left }}
                    >
                      <span className="absolute left-1 top-1 text-[10px] text-muted-foreground">
                        {tick.label}
                      </span>
                    </div>
                  ))}
                  <div
                    className="absolute top-0 bottom-0 z-30 w-px bg-primary"
                    style={{ left: playhead * zoom }}
                  />
                    <button
                      type="button"
                      aria-label="Drag playhead"
                      className="absolute top-0 z-40 h-4 w-3 -translate-x-1/2 cursor-ew-resize rounded-b-sm bg-primary shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
                      style={{ left: playhead * zoom }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setIsDraggingPlayhead(true);
                      if (rulerRef.current) {
                        seekToTimelineClientX(event.clientX, rulerRef.current);
                      }
                    }}
                  />
                  {timelineWidth > project.duration * zoom ? (
                    <div
                      className="pointer-events-none absolute bottom-0 top-0 z-20 bg-background/55"
                      style={{
                        left: project.duration * zoom,
                        width: timelineWidth - project.duration * zoom,
                      }}
                    />
                  ) : null}
                </div>
              </div>

                <div ref={trackRowsRef} className="relative">
                  <div
                    className="absolute bottom-0 top-0 z-30 w-px bg-primary"
                    style={{ left: playhead * zoom }}
                  />
                  <div
                    className="absolute bottom-0 top-0 z-20 w-px border-l border-dashed border-primary/70"
                    style={{ left: project.duration * zoom }}
                  />
                  {timelineWidth > project.duration * zoom ? (
                    <div
                      className="pointer-events-none absolute bottom-0 top-0 z-10 bg-background/45"
                      style={{
                        left: project.duration * zoom,
                        width: timelineWidth - project.duration * zoom,
                      }}
                    />
                  ) : null}

                  <div
                    className="border-b border-border/70 bg-background/20"
                    style={{ height: ADD_TRACK_TARGET_HEIGHT }}
                  />

                  {tracks.map((track) => {
                    const trackClips = visibleClipsByTrack.get(track.id) ?? [];
                    const dropBefore =
                      trackDropTarget?.trackId === track.id && trackDropTarget.placement === "before";
                    const dropAfter =
                      trackDropTarget?.trackId === track.id && trackDropTarget.placement === "after";

                    return (
                      <div
                        key={track.id}
                        className={cn(
                          "relative border-b border-border transition-colors",
                          dragOverTrackId === track.id && "bg-primary/10",
                          interaction?.type === "move" && (draftClip?.trackId === track.id || [...draftGroupClips.values()].some((c) => c.trackId === track.id)) && "bg-primary/5",
                          isTrackDimmed(track) && "bg-muted/25",
                          track.locked && "cursor-not-allowed",
                        )}
                        style={{ height: TRACK_ROW_HEIGHT }}
                        onMouseDown={(event) =>
                          handleTimelineSeek(event, event.currentTarget as HTMLDivElement)
                        }
                        onDragOver={(event) => {
                          if (
                            track.locked ||
                            !Array.from(event.dataTransfer.types).includes(
                              "application/x-composer-asset-present",
                            )
                          ) {
                            return;
                          }
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "copy";
                          setDragOverTrackId(track.id);
                        }}
                        onDragLeave={() => {
                          if (dragOverTrackId === track.id) {
                            setDragOverTrackId(null);
                          }
                        }}
                        onDrop={(event) => void handleAssetDrop(event, track)}
                      >
                        {dropBefore ? (
                          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-px bg-primary" />
                        ) : null}
                        {dropAfter ? (
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-px bg-primary" />
                        ) : null}
                        {trackClips.length === 0 ? (
                          <div className="flex h-full items-center px-3 text-xs text-muted-foreground">
                            Drop {track.type === "audio" ? "audio" : "video or image"} assets here
                          </div>
                        ) : null}
                        {track.locked ? (
                          <div
                            className="pointer-events-none absolute inset-0 z-10 opacity-50"
                            style={{
                              backgroundImage:
                                "repeating-linear-gradient(135deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 6px, transparent 6px, transparent 12px)",
                            }}
                          />
                        ) : null}

                        {trackClips.map((clip) => {
                          const isDuplicateDrag =
                            interaction?.type === "move" && interaction.duplicate;
                          if (isCrossTrackDrag && draftClip?.id === clip.id && !isDuplicateDrag) {
                            return null;
                          }
                          const renderedClip =
                            draftGroupClips.get(clip.id) ??
                            (isDuplicateDrag ? clip : draftClip?.id === clip.id ? draftClip : clip);
                          const selected = selectedClipIds.includes(renderedClip.id) || renderedClip.id === selectedClipId;
                          return renderTimelineClip({
                            clipKey: renderedClip.id,
                            renderedClip,
                            sourceClip: clip,
                            track,
                            selected,
                            onClipMouseDown: (event) => {
                              if (track.locked) {
                                return;
                              }
                              event.stopPropagation();
                              const isAlreadySelected = selectedClipIds.includes(renderedClip.id);
                              const hasMultiSelect = selectedClipIds.length > 1;
                              // When clicking an already-selected clip in a group, keep the group
                              if (isAlreadySelected && hasMultiSelect && !event.shiftKey) {
                                // Keep existing selection, don't replace
                              } else {
                                selectClip(renderedClip.id, event.shiftKey);
                              }
                              const effectiveIds = selectedClipIds.includes(renderedClip.id)
                                ? selectedClipIds
                                : event.shiftKey
                                  ? [...selectedClipIds, renderedClip.id]
                                  : [renderedClip.id];
                              const duplicate =
                                (event.ctrlKey || event.metaKey) &&
                                effectiveIds.length === 1 &&
                                effectiveIds[0] === renderedClip.id;
                              const groupInitialStates = effectiveIds
                                .map((id) => clips.find((c) => c.id === id))
                                .filter((c): c is Clip => c != null)
                                .map((c) => ({ id: c.id, startTime: c.startTime, trackId: c.trackId }));
                              setMoveGhostPointer({
                                x: event.clientX,
                                y: event.clientY,
                              });
                              setIsCrossTrackDrag(false);
                              setInteraction({
                                type: "move",
                                clip,
                                originX: event.clientX,
                                duplicate,
                                groupInitialStates,
                              });
                              setDraftClip(clip);
                            },
                          });
                        })}
                        {interaction?.type === "move" &&
                        interaction.duplicate &&
                        draftClip?.trackId === track.id
                          ? renderTimelineClip({
                              clipKey: `draft-${draftClip.id}`,
                              renderedClip: draftClip,
                              sourceClip: interaction.clip,
                              track,
                              selected: true,
                              interactive: false,
                            })
                          : null}
                      </div>
                    );
                  })}

                  <div
                    className="border-b border-border/70 bg-background/20"
                    style={{ height: ADD_TRACK_TARGET_HEIGHT }}
                  />
                </div>
                {moveGhostModel && moveGhostPointer ? (
                  <div
                    className="pointer-events-none fixed z-[120] flex items-stretch overflow-hidden"
                    style={{
                      ...getInstanceGhostStyle(moveGhostModel),
                      opacity: 0.5,
                      left: moveGhostPointer.x - 12,
                      top: moveGhostPointer.y - 22,
                    }}
                  >
                    <div className="w-2 shrink-0 bg-black/20" />
                    <div className="flex min-w-0 flex-1 flex-col justify-center px-2 text-left">
                      <div className="truncate text-xs font-medium text-white">
                        {moveGhostModel.label}
                      </div>
                      <div className="truncate text-[10px] text-white/80">
                        {moveGhostModel.detail}
                      </div>
                    </div>
                    <div className="w-2 shrink-0 bg-black/20" />
                  </div>
                ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

