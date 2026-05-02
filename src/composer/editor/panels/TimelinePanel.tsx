import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import {
  Eye,
  EyeOff,
  Film,
  GripVertical,
  Layers,
  Lock,
  MoreVertical,
  Music2,
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
import type { Clip, ComposerAsset, Track } from "@/composer/types/project";
import { useComposerRuntime } from "../context/ComposerRuntimeContext";
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
  snapTimeToFrame,
} from "../utils/timeline";

const RULER_HEIGHT = 34;
const TRACK_ROW_HEIGHT = 60;
const ADD_TRACK_TARGET_HEIGHT = 15;
const CROSS_TRACK_DRAG_TOLERANCE = 15;
const MIN_VIEWPORT_WIDTH = 720;
const MIN_FRAME_PIXEL_WIDTH = 32;
const MAX_FRAME_PIXEL_WIDTH = 128;
const TARGET_TICK_WIDTH = 84;
const MAX_ZOOM_OUT_PROJECT_MULTIPLIER = 3;

type Interaction =
  | {
      type: "move";
      clip: Clip;
      originX: number;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getFramePixelWidth(zoom: number, fps: number): number {
  return zoom / fps;
}

function shouldUseFrameRuler(zoom: number, fps: number): boolean {
  const framePixelWidth = getFramePixelWidth(zoom, fps);
  return framePixelWidth >= MIN_FRAME_PIXEL_WIDTH && framePixelWidth <= MAX_FRAME_PIXEL_WIDTH;
}

function getTimeTickStep(zoom: number): number {
  const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((step) => step * zoom >= TARGET_TICK_WIDTH) ?? steps[steps.length - 1];
}

function formatFrameLabel(frame: number): string {
  return `${frame}f`;
}

function formatRulerTimeLabel(time: number): string {
  if (time < 1) {
    return `${time.toFixed(2)}s`;
  }
  if (time < 10) {
    return `${time.toFixed(1)}s`;
  }
  return formatTimelineTime(time);
}

function getTrackAcceptsAsset(track: Track, asset: ComposerAsset): boolean {
  return track.type === "audio" ? asset.type === "audio" : asset.type !== "audio";
}

function isImageClip(clip: Clip): boolean {
  return clip.sourcePath?.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i) != null;
}

function getSnapThreshold(fps: number): number {
  return 10 / fps;
}

function resolveTrackStart(
  desiredStart: number,
  duration: number,
  otherClips: Clip[],
  fps: number,
): number {
  const threshold = getSnapThreshold(fps);
  let nextStart = Math.max(0, desiredStart);

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const overlappingClip = otherClips.find(
      (clip) => nextStart < getClipEnd(clip) && nextStart + duration > clip.startTime,
    );
    if (!overlappingClip) {
      break;
    }

    const leftCandidate = Math.max(0, overlappingClip.startTime - duration);
    const rightCandidate = getClipEnd(overlappingClip);
    nextStart =
      Math.abs(nextStart - leftCandidate) <= Math.abs(nextStart - rightCandidate)
        ? leftCandidate
        : rightCandidate;
  }

  if (Math.abs(nextStart) <= threshold) {
    return 0;
  }

  for (const clip of otherClips) {
    const previousEdge = getClipEnd(clip);
    const nextEdge = clip.startTime - duration;
    if (Math.abs(nextStart - previousEdge) <= threshold) {
      return snapTimeToFrame(previousEdge, fps);
    }
    if (nextEdge >= 0 && Math.abs(nextStart - nextEdge) <= threshold) {
      return snapTimeToFrame(nextEdge, fps);
    }
  }

  return snapTimeToFrame(nextStart, fps);
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
  return trackType === "audio" ? Music2 : Film;
}

export function TimelinePanel() {
  const {
    project,
    tracks,
    clips,
    selectedClipId,
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
    getMediaDuration,
    moveClip,
    trimClip,
    splitSelectedClip,
    deleteSelectedClip,
    undo,
  } = useComposerRuntime();
  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [draftClip, setDraftClip] = useState<Clip | null>(null);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
  const [trackDropTarget, setTrackDropTarget] = useState<TrackDropTarget | null>(null);
  const [moveGhostPointer, setMoveGhostPointer] = useState<PointerPosition | null>(null);
  const [isCrossTrackDrag, setIsCrossTrackDrag] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const trackRowsRef = useRef<HTMLDivElement | null>(null);
  const previousZoomRef = useRef(zoom);
  const autoFitProjectRef = useRef<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(MIN_VIEWPORT_WIDTH);
  const frameDuration = useMemo(() => getFrameDuration(project.fps), [project.fps]);
  const tracksById = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);

  const minZoom = useMemo(() => {
    const safeDuration = Math.max(project.duration, 1 / project.fps);
    return viewportWidth / (safeDuration * MAX_ZOOM_OUT_PROJECT_MULTIPLIER);
  }, [project.duration, project.fps, viewportWidth]);
  const maxZoom = useMemo(() => project.fps * MAX_FRAME_PIXEL_WIDTH, [project.fps]);
  const frameRuler = useMemo(() => shouldUseFrameRuler(zoom, project.fps), [project.fps, zoom]);
  const timelineWidth = Math.max(timelineDuration * zoom, viewportWidth);
  const rulerTicks = useMemo(() => {
    if (frameRuler) {
      const frameWidth = getFramePixelWidth(zoom, project.fps);
      const frameStep = Math.max(1, Math.ceil(TARGET_TICK_WIDTH / frameWidth));
      const totalFrames = Math.ceil(timelineDuration * project.fps);

      return Array.from({ length: Math.ceil(totalFrames / frameStep) + 1 }, (_, index) => {
        const frame = index * frameStep;
        const time = frame / project.fps;
        return {
          key: `frame-${frame}`,
          left: time * zoom,
          label: formatFrameLabel(frame),
          major: frame % Math.max(1, Math.round(project.fps)) === 0,
        };
      }).filter((tick) => tick.left <= timelineWidth);
    }

    const tickStep = getTimeTickStep(zoom);
    const totalTicks = Math.ceil(timelineDuration / tickStep);
    return Array.from({ length: totalTicks + 1 }, (_, index) => {
      const time = index * tickStep;
      return {
        key: `time-${time}`,
        left: time * zoom,
        label: formatRulerTimeLabel(time),
        major: Number.isInteger(time) || tickStep >= 1,
      };
    }).filter((tick) => tick.left <= timelineWidth);
  }, [frameRuler, project.fps, timelineDuration, timelineWidth, zoom]);

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
    if (viewportWidth <= 0 || autoFitProjectRef.current === project.id) {
      return;
    }

    const fittedZoom = clamp(
      viewportWidth / Math.max(timelineDuration, frameDuration),
      minZoom,
      maxZoom,
    );
    autoFitProjectRef.current = project.id;
    previousZoomRef.current = fittedZoom;
    setZoom(fittedZoom);
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
    }
  }, [frameDuration, maxZoom, minZoom, project.id, setZoom, timelineDuration, viewportWidth]);

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

  const handleZoomToFit = () => {
    const fittedZoom = viewportWidth / Math.max(timelineDuration, 1 / project.fps);
    setZoom(clamp(fittedZoom, minZoom, maxZoom));
  };

  const handleZoomStep = (direction: -1 | 1) => {
    const frameWidth = getFramePixelWidth(zoom, project.fps);
    if (frameRuler) {
      const nextFrameWidth = clamp(
        frameWidth + direction * 8,
        MIN_FRAME_PIXEL_WIDTH,
        MAX_FRAME_PIXEL_WIDTH,
      );
      setZoom(clamp(nextFrameWidth * project.fps, minZoom, maxZoom));
      return;
    }

    const factor = direction > 0 ? 1.25 : 0.8;
    setZoom(clamp(zoom * factor, minZoom, maxZoom));
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
        const sourceTrack = tracksById.get(baseClip.trackId);
        const withinSourceTrackZone = isWithinSourceTrackDragZone(
          event.clientY,
          baseClip.trackId,
        );
        const hoveredTrack = resolveTrackFromClientY(event.clientY, baseClip.trackId);
        const targetTrack =
          !withinSourceTrackZone &&
          sourceTrack &&
          hoveredTrack &&
          hoveredTrack.id !== sourceTrack.id &&
          hoveredTrack.type === sourceTrack.type &&
          !hoveredTrack.locked
            ? hoveredTrack
            : sourceTrack;
        setIsCrossTrackDrag(Boolean(targetTrack && sourceTrack && targetTrack.id !== sourceTrack.id));
        if (!targetTrack) {
          return;
        }
        const trackClips = clips
          .filter((clip) => clip.trackId === targetTrack.id && clip.id !== baseClip.id)
          .sort((left, right) => left.startTime - right.startTime);
        const nextStartTime = resolveTrackStart(
          baseClip.startTime + deltaSeconds,
          baseClip.duration,
          trackClips,
          project.fps,
        );
        setDraftClip({ ...baseClip, startTime: nextStartTime, trackId: targetTrack.id });
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
            duration: Math.max(frameDuration, snapTimeToFrame(baseClip.duration - delta, project.fps)),
            trimStart: 0,
            trimEnd: 0,
          });
          return;
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
          duration: Math.max(frameDuration, snapTimeToFrame(baseClip.duration - delta, project.fps)),
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
          duration: Math.max(frameDuration, snapTimeToFrame(baseClip.duration + delta, project.fps)),
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
        duration: Math.max(frameDuration, snapTimeToFrame(baseClip.duration + delta, project.fps)),
        trimEnd: snapTimeToFrame(rightHandleRoom - delta, project.fps),
      });
    };

    const handleMouseUp = () => {
      const currentInteraction = interaction;
      const currentDraft = draftClip;
      setInteraction(null);
      setDraftClip(null);
      setMoveGhostPointer(null);
      setIsCrossTrackDrag(false);

      if (!currentDraft) {
        return;
      }

      if (currentInteraction.type === "move") {
        void moveClip(currentDraft.id, currentDraft.startTime, currentDraft.trackId);
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
  }, [draftClip, frameDuration, interaction, moveClip, project.fps, trimClip, zoom]);

  const handleTimelineSeek = (
    event: MouseEvent<HTMLDivElement>,
    element: HTMLDivElement,
  ) => {
    selectClip(null);
    const rect = element.getBoundingClientRect();
    const time = (event.clientX - rect.left) / zoom;
    if (isPlaying) {
      stopPlayback(time);
      return;
    }
    seek(time);
  };

  const seekToTimelineClientX = (clientX: number, element: HTMLDivElement) => {
    selectClip(null);
    const rect = element.getBoundingClientRect();
    const time = (clientX - rect.left) / zoom;
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
  }, [isDraggingPlayhead, isPlaying, seek, selectClip, stopPlayback, zoom]);

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
      detail: `${draftClip.duration.toFixed(2)}s · ${Math.round(draftClip.duration * project.fps)}f`,
      trackType: tracksById.get(draftClip.trackId)?.type ?? "video",
      width: getInstanceGhostWidth(draftClip.duration, zoom),
    } as const;
  }, [
    draftClip,
    interaction?.type,
    isCrossTrackDrag,
    moveGhostPointer,
    project.fps,
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
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Layers className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium text-muted-foreground">Timeline</span>
        <div className="text-[11px] text-muted-foreground">
          {Math.round(playhead * project.fps)}f - {playhead.toFixed(2)}s / {project.duration.toFixed(2)}s
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
          <div className="border-r border-border bg-muted/20">
            <div
              className="sticky top-0 z-10 flex items-center border-b border-border px-3 text-[11px] uppercase tracking-wide text-muted-foreground"
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

          <div ref={viewportRef} className="min-w-0 min-h-0 overflow-auto">
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
                          interaction?.type === "move" && draftClip?.trackId === track.id && "bg-primary/5",
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
                          if (isCrossTrackDrag && draftClip?.id === clip.id) {
                            return null;
                          }
                          const renderedClip = draftClip?.id === clip.id ? draftClip : clip;
                          const selected = renderedClip.id === selectedClipId;
                          return (
                            <div
                              key={renderedClip.id}
                              className={cn(
                                "absolute top-2 flex h-[44px] items-stretch overflow-hidden rounded-md border shadow-sm",
                                getClipFill(track.type, selected),
                                isTrackDimmed(track) && "opacity-40",
                              )}
                              style={{
                                left: renderedClip.startTime * zoom,
                                width: Math.max(renderedClip.duration * zoom, 18),
                              }}
                              onMouseDown={(event) => {
                                if (track.locked) {
                                  return;
                                }
                                event.stopPropagation();
                                selectClip(renderedClip.id);
                                setMoveGhostPointer({
                                  x: event.clientX,
                                  y: event.clientY,
                                });
                                setIsCrossTrackDrag(false);
                                setInteraction({
                                  type: "move",
                                  clip,
                                  originX: event.clientX,
                                });
                                setDraftClip(clip);
                              }}
                            >
                              <button
                                type="button"
                                className="w-2 shrink-0 cursor-ew-resize bg-black/20 hover:bg-black/30"
                                onMouseDown={(event) => {
                                  if (track.locked) {
                                    return;
                                  }
                                  event.stopPropagation();
                                  selectClip(renderedClip.id);
                                  setInteraction({
                                    type: "trim-left",
                                    clip,
                                    originX: event.clientX,
                                  });
                                  setDraftClip(clip);
                                }}
                                aria-label="Trim clip start"
                              />
                              <div className="flex min-w-0 flex-1 flex-col justify-center px-2 text-left">
                                <div className="truncate text-xs font-medium text-white">
                                  {clip.sourcePath?.split(/[\\/]/).pop() ?? "Clip"}
                                </div>
                                <div className="text-[10px] text-white/80">
                                  {renderedClip.duration.toFixed(2)}s · {Math.round(renderedClip.duration * project.fps)}f
                                </div>
                              </div>
                              <button
                                type="button"
                                className="w-2 shrink-0 cursor-ew-resize bg-black/20 hover:bg-black/30"
                                onMouseDown={(event) => {
                                  if (track.locked) {
                                    return;
                                  }
                                  event.stopPropagation();
                                  selectClip(renderedClip.id);
                                  setInteraction({
                                    type: "trim-right",
                                    clip,
                                    originX: event.clientX,
                                  });
                                  setDraftClip(clip);
                                }}
                                aria-label="Trim clip end"
                              />
                            </div>
                          );
                        })}
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
