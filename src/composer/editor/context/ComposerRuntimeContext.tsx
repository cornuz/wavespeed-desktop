import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  composerClipIpc,
  composerSequencePreviewIpc,
  composerTrackIpc,
} from "@/composer/ipc/ipc-client";
import { useComposerProjectStore } from "@/composer/stores/project.store";
import type {
  Clip,
  ComposerAsset,
  ComposerProject,
  ComposerAssetType,
  Track,
} from "@/composer/types/project";
import { getFrameDuration, snapTimeToFrame } from "../utils/timeline";

const DEFAULT_IMAGE_DURATION = 5;
const DEFAULT_MEDIA_DURATION = 5;
const DEFAULT_ZOOM = 72;
const MIN_CLIP_DURATION = 0.25;
const MAX_UNDO = 20;

type EditableClipPatch = Partial<
  Pick<
    Clip,
    | "startTime"
    | "duration"
    | "trimStart"
    | "trimEnd"
    | "speed"
    | "trackId"
    | "transformOffsetX"
    | "transformOffsetY"
      | "transformScale"
      | "rotationZ"
      | "opacity"
      | "brightness"
      | "contrast"
      | "saturation"
      | "adjustments"
      | "fadeInDuration"
      | "fadeOutDuration"
  >
>;

type ClipUndoSnapshot = Pick<
  Clip,
  | "startTime"
  | "duration"
  | "trimStart"
  | "trimEnd"
  | "speed"
  | "trackId"
  | "transformOffsetX"
  | "transformOffsetY"
  | "transformScale"
  | "rotationZ"
  | "opacity"
  | "brightness"
  | "contrast"
  | "saturation"
  | "adjustments"
  | "fadeInDuration"
  | "fadeOutDuration"
>;

type UndoEntry =
  | {
      type: "delete-added";
      clipId: string;
    }
  | {
      type: "restore-deleted";
      clip: Clip;
    }
    | {
      type: "restore-updated";
      clipId: string;
      previous: ClipUndoSnapshot;
    }
  | {
      type: "restore-split";
      original: Clip;
      createdClipId: string;
    };

interface ComposerRuntimeContextValue {
  project: ComposerProject;
  tracks: Track[];
  clips: Clip[];
  previewAsset: ComposerAsset | null;
  selectedClipId: string | null;
  selectedClip: Clip | null;
  selectedVisualClip: Clip | null;
  playhead: number;
  pendingSequencePlaybackStartTime: number | null;
  isPlaying: boolean;
  isPlaybackWaiting: boolean;
  zoom: number;
  timelineDuration: number;
  canUndo: boolean;
  activeVisualClip: Clip | null;
  activeAudioClip: Clip | null;
  seek: (time: number) => void;
  syncPlaybackToMediaClock: (time: number) => void;
  setPlaybackClockSource: (source: "timeline" | "media") => void;
  togglePlayback: () => void;
  pausePlayback: () => void;
  stopPlayback: (time?: number) => void;
  selectClip: (clipId: string | null) => void;
  previewLibraryAsset: (asset: ComposerAsset | null) => void;
  setZoom: (value: number) => void;
  addTrack: (type: Track["type"]) => Promise<void>;
  deleteTrack: (trackId: string) => Promise<void>;
  updateTrack: (
    trackId: string,
    patch: Partial<Pick<Track, "muted" | "locked" | "visible" | "name" | "order">>,
  ) => Promise<void>;
  addAssetToTrack: (
    trackId: string,
    asset: ComposerAsset,
    startTime: number,
    durationOverride?: number,
  ) => Promise<void>;
  moveClip: (clipId: string, startTime: number, trackId?: string) => Promise<void>;
  trimClip: (
    clipId: string,
    nextValues: Pick<Clip, "startTime" | "duration" | "trimStart" | "trimEnd">,
  ) => Promise<void>;
  updateClip: (clipId: string, patch: EditableClipPatch) => Promise<void>;
  updateClipTransform: (
    clipId: string,
    nextValues: Pick<Clip, "transformOffsetX" | "transformOffsetY" | "transformScale">,
  ) => Promise<void>;
  splitSelectedClip: () => Promise<void>;
  deleteSelectedClip: () => Promise<void>;
  undo: () => Promise<void>;
  getAssetUrl: (filePath: string | null) => string | null;
  getMediaDuration: (filePath: string, type: ComposerAssetType) => Promise<number>;
}

const ComposerRuntimeContext = createContext<ComposerRuntimeContextValue | null>(null);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTime(value: number): number {
  return Number(value.toFixed(3));
}

function getClipEnd(clip: Clip): number {
  return clip.startTime + clip.duration;
}

function getTrimEnd(clip: Clip): number {
  return clip.trimEnd ?? 0;
}

function getUndoClipSnapshot(clip: Clip): ClipUndoSnapshot {
  return {
    trackId: clip.trackId,
    startTime: clip.startTime,
    duration: clip.duration,
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd,
    speed: clip.speed,
    transformOffsetX: clip.transformOffsetX,
    transformOffsetY: clip.transformOffsetY,
    transformScale: clip.transformScale,
    rotationZ: clip.rotationZ,
    opacity: clip.opacity,
    brightness: clip.brightness,
    contrast: clip.contrast,
    saturation: clip.saturation,
    adjustments: clip.adjustments,
    fadeInDuration: clip.fadeInDuration,
    fadeOutDuration: clip.fadeOutDuration,
  };
}

function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort(
    (left, right) =>
      left.startTime - right.startTime ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

function getAssetUrl(filePath: string | null): string | null {
  if (!filePath) return null;
  return `local-asset://${encodeURIComponent(filePath)}`;
}

function getTrackForType(tracks: Track[], type: ComposerAssetType): Track | null {
  if (type === "lut") {
    // LUT files cannot be added to the timeline
    return null;
  }
  if (type === "audio") {
    return tracks.find((track) => track.type === "audio") ?? null;
  }
  return tracks.find((track) => track.type === "video") ?? null;
}

function getActiveClipAtTime(
  clips: Clip[],
  tracks: Track[],
  playhead: number,
  trackType: Track["type"],
  trackFilter: (track: Track) => boolean = (track) => track.visible,
): Clip | null {
  const sortedTrackIds = tracks
    .filter((track) => track.type === trackType && trackFilter(track))
    .sort((left, right) => right.order - left.order)
    .map((track) => track.id);

  for (const trackId of sortedTrackIds) {
    const clip = clips.find(
      (candidate) =>
        candidate.trackId === trackId &&
        playhead >= candidate.startTime &&
        playhead < getClipEnd(candidate),
    );
    if (clip) {
      return clip;
    }
  }

  return null;
}

interface ComposerRuntimeProviderProps {
  project: ComposerProject;
  children: ReactNode;
}

export function ComposerRuntimeProvider({
  project,
  children,
}: ComposerRuntimeProviderProps) {
  const patchCurrentProject = useComposerProjectStore(
    (state) => state.patchCurrentProject,
  );
  const setTracks = useComposerProjectStore((state) => state.setTracks);
  const setClips = useComposerProjectStore((state) => state.setClips);
  const [previewAsset, setPreviewAsset] = useState<ComposerAsset | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [pendingSequencePlaybackStartTime, setPendingSequencePlaybackStartTime] =
    useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPlaybackWaiting, setIsPlaybackWaiting] = useState(false);
  const [playbackClockSource, setPlaybackClockSourceState] = useState<
    "timeline" | "media"
  >("timeline");
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const playbackRef = useRef({ rafId: 0, startedAt: 0, originPlayhead: 0 });
  const playheadRef = useRef(playhead);
  const durationCacheRef = useRef<Record<string, number>>({});

  const tracks = useMemo(
    () => [...project.tracks].sort((left, right) => left.order - right.order),
    [project.tracks],
  );
  const clips = useMemo(() => sortClips(project.clips), [project.clips]);
  const timelineDuration = useMemo(() => {
    const latestClipEnd = clips.reduce((max, clip) => Math.max(max, getClipEnd(clip)), 0);
    return Math.max(project.duration, latestClipEnd, DEFAULT_IMAGE_DURATION);
  }, [clips, project.duration]);
  const frameDuration = useMemo(() => getFrameDuration(project.fps), [project.fps]);
  const selectedClip = useMemo(
    () => clips.find((clip) => clip.id === selectedClipId) ?? null,
    [clips, selectedClipId],
  );
  const activeVisualClip = useMemo(
    () => getActiveClipAtTime(clips, tracks, playhead, "video"),
    [clips, playhead, tracks],
  );
  const activeAudioClip = useMemo(
    () => getActiveClipAtTime(clips, tracks, playhead, "audio", (track) => track.visible && !track.muted),
    [clips, playhead, tracks],
  );
  const selectedVisualClip = useMemo(
    () =>
      selectedClip &&
      selectedClip.sourcePath?.match(/\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|avi|mkv|m4v)$/i)
        ? selectedClip
        : null,
    [selectedClip],
  );

  const getLiveProject = useCallback(
    () => useComposerProjectStore.getState().currentProject ?? project,
    [project],
  );

  const updateClipList = useCallback(
    (nextClips: Clip[]) => {
      setClips(sortClips(nextClips));
    },
    [setClips],
  );

  const updateTrackList = useCallback(
    (nextTracks: Track[]) => {
      setTracks([...nextTracks].sort((left, right) => left.order - right.order));
    },
    [setTracks],
  );

  const refreshSequencePreview = useCallback(async () => {
    try {
      const nextSequencePreview = await composerSequencePreviewIpc.get({
        projectId: project.id,
      });
      const currentProject = useComposerProjectStore.getState().currentProject;
      if (currentProject?.id === project.id) {
        patchCurrentProject({ sequencePreview: nextSequencePreview });
      }
    } catch {
      // Keep current renderer state when IPC refresh is unavailable.
    }
  }, [patchCurrentProject, project.id]);

  const pushUndo = useCallback((entry: UndoEntry) => {
    setUndoStack((previous) => [...previous.slice(-(MAX_UNDO - 1)), entry]);
  }, []);

  const getMediaDuration = useCallback(
    async (filePath: string, type: ComposerAssetType): Promise<number> => {
      if (type === "image") {
        return DEFAULT_IMAGE_DURATION;
      }

      const cached = durationCacheRef.current[filePath];
      if (cached) {
        return cached;
      }

      const assetUrl = getAssetUrl(filePath);
      if (!assetUrl) {
        return DEFAULT_MEDIA_DURATION;
      }

      const duration = await new Promise<number>((resolve) => {
        const element = document.createElement(type === "video" ? "video" : "audio");
        const cleanup = () => {
          element.src = "";
          element.load();
        };

        element.preload = "metadata";
        element.onloadedmetadata = () => {
          const nextDuration =
            Number.isFinite(element.duration) && element.duration > 0
              ? element.duration
              : DEFAULT_MEDIA_DURATION;
          cleanup();
          resolve(nextDuration);
        };
        element.onerror = () => {
          cleanup();
          resolve(DEFAULT_MEDIA_DURATION);
        };
        element.src = assetUrl;
      });

      durationCacheRef.current[filePath] = duration;
      return duration;
    },
    [],
  );

  const seek = useCallback(
    (time: number) => {
      const nextTime = clamp(snapTimeToFrame(time, project.fps), 0, timelineDuration);
      setPlayhead(nextTime);
      if (isPlaybackWaiting) {
        setPendingSequencePlaybackStartTime(nextTime);
      }
      if (isPlaying) {
        playbackRef.current.startedAt = performance.now();
        playbackRef.current.originPlayhead = nextTime;
      }
    },
    [isPlaybackWaiting, isPlaying, project.fps, timelineDuration],
  );

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const syncPlaybackToMediaClock = useCallback(
    (time: number) => {
      if (!isPlaying) {
        return;
      }

      const nextTime = clamp(snapTimeToFrame(time, project.fps), 0, timelineDuration);
      setPlayhead((current) =>
        Math.abs(current - nextTime) < 0.0001 ? current : nextTime,
      );
      playbackRef.current.startedAt = performance.now();
      playbackRef.current.originPlayhead = nextTime;
    },
    [isPlaying, project.fps, timelineDuration],
  );

  const setPlaybackClockSource = useCallback((source: "timeline" | "media") => {
    setPlaybackClockSourceState((current) => {
      if (current === source) {
        return current;
      }
      if (source === "timeline") {
        playbackRef.current.startedAt = performance.now();
        playbackRef.current.originPlayhead = playheadRef.current;
      }
      return source;
    });
  }, []);

  const pausePlayback = useCallback(() => {
    setIsPlaying(false);
    setIsPlaybackWaiting(false);
    setPendingSequencePlaybackStartTime(null);
    setPlaybackClockSourceState("timeline");
  }, []);

  const stopPlayback = useCallback(
    (time?: number) => {
      if (playbackRef.current.rafId) {
        cancelAnimationFrame(playbackRef.current.rafId);
        playbackRef.current.rafId = 0;
      }

      setIsPlaying(false);
      setIsPlaybackWaiting(false);
      setPendingSequencePlaybackStartTime(null);
      setPlaybackClockSourceState("timeline");

      if (typeof time !== "number") {
        return;
      }

      const nextTime = clamp(snapTimeToFrame(time, project.fps), 0, timelineDuration);
      playheadRef.current = nextTime;
      setPlayhead(nextTime);
      playbackRef.current.startedAt = performance.now();
      playbackRef.current.originPlayhead = nextTime;
    },
    [project.fps, timelineDuration],
  );

  const togglePlayback = useCallback(() => {
    if (previewAsset) {
      return;
    }

    if (isPlaying || isPlaybackWaiting) {
      stopPlayback();
      return;
    }

    const sequencePreviewReady =
      project.sequencePreview.status === "ready" &&
      typeof project.sequencePreview.filePath === "string" &&
      project.sequencePreview.filePath.length > 0;
    const requestedStartTime = playheadRef.current;
    setSelectedClipId(null);

    if (!sequencePreviewReady) {
      setPendingSequencePlaybackStartTime(requestedStartTime);
      setIsPlaybackWaiting(true);
      return;
    }

    setPendingSequencePlaybackStartTime(requestedStartTime);
    setPlaybackClockSourceState("timeline");
    playbackRef.current.startedAt = performance.now();
    playbackRef.current.originPlayhead = requestedStartTime;
    setIsPlaying(true);
  }, [
    isPlaybackWaiting,
    isPlaying,
    previewAsset,
    project.sequencePreview.filePath,
    project.sequencePreview.status,
    stopPlayback,
  ]);

  const selectClip = useCallback((clipId: string | null) => {
    setPreviewAsset(null);
    setSelectedClipId(clipId);
  }, []);

  const previewLibraryAsset = useCallback((asset: ComposerAsset | null) => {
    setPreviewAsset(asset);
    setIsPlaybackWaiting(false);
    setPendingSequencePlaybackStartTime(null);
    if (asset) {
      setSelectedClipId(null);
      setIsPlaying(false);
      setPlaybackClockSourceState("timeline");
    }
  }, []);

  const addAssetToTrack = useCallback(
    async (
      trackId: string,
      asset: ComposerAsset,
      startTime: number,
      durationOverride?: number,
    ) => {
      const track = getLiveProject().tracks.find((candidate) => candidate.id === trackId);
      if (!track) {
        throw new Error(`Track ${trackId} not found`);
      }
      if (track.locked) {
        throw new Error("Track is locked");
      }

      const expectedTrack = getTrackForType(getLiveProject().tracks, asset.type);
      if (!expectedTrack || expectedTrack.id !== trackId) {
        throw new Error(`"${asset.type}" assets must be dropped on a matching track`);
      }

      // Use working path if available (for transcoded videos), otherwise use filePath
      const mediaPath = asset.workingPath ?? asset.filePath;

      const duration =
        durationOverride ??
        (asset.type === "image"
          ? DEFAULT_IMAGE_DURATION
          : await getMediaDuration(mediaPath, asset.type));

      const createdClip = await composerClipIpc.add({
        projectId: project.id,
        trackId,
        sourceType: "asset",
        sourcePath: mediaPath,
        sourceAssetId: asset.id,
        startTime: snapTimeToFrame(startTime, project.fps),
        duration: Math.max(frameDuration, snapTimeToFrame(duration, project.fps)),
        trimStart: 0,
        trimEnd: 0,
        speed: 1,
      });

      updateClipList([...getLiveProject().clips, createdClip]);
      setPreviewAsset(null);
      setSelectedClipId(createdClip.id);
      pushUndo({ type: "delete-added", clipId: createdClip.id });
    },
    [frameDuration, getLiveProject, getMediaDuration, project.fps, project.id, pushUndo, updateClipList],
  );

  const updateTrack = useCallback(
    async (
      trackId: string,
      patch: Partial<Pick<Track, "muted" | "locked" | "visible" | "name" | "order">>,
    ) => {
      const currentTrack = getLiveProject().tracks.find((track) => track.id === trackId);
      if (!currentTrack) {
        return;
      }

      const updatedTrack = await composerTrackIpc.update({
        projectId: project.id,
        trackId,
        name: patch.name,
        muted: patch.muted,
        locked: patch.locked,
        visible: patch.visible,
        order: patch.order,
      });

      updateTrackList(
        getLiveProject().tracks.map((track) => (track.id === trackId ? updatedTrack : track)),
      );

      const selectedClip = getLiveProject().clips.find((clip) => clip.id === selectedClipId);
      if (
        selectedClip?.trackId === trackId &&
        (updatedTrack.locked || !updatedTrack.visible)
      ) {
        setSelectedClipId(null);
      }
    },
    [getLiveProject, project.id, selectedClipId, updateTrackList],
  );

  const addTrack = useCallback(
    async (type: Track["type"]) => {
      const currentTracks = getLiveProject().tracks;
      const prefix = type === "audio" ? "Audio" : "Video";
      const nextIndex =
        currentTracks
          .filter((track) => track.type === type)
          .reduce((max, track) => {
            const match = track.name.match(new RegExp(`^${prefix}\\s+(\\d+)$`, "i"));
            const parsed = match ? Number(match[1]) : Number.NaN;
            return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
          }, 0) + 1;
      const createdTrack = await composerTrackIpc.add({
        projectId: project.id,
        type,
        name: `${prefix} ${nextIndex}`,
      });

      updateTrackList([...getLiveProject().tracks, createdTrack]);
    },
    [getLiveProject, project.id, updateTrackList],
  );

  const deleteTrack = useCallback(
    async (trackId: string) => {
      await composerTrackIpc.delete({
        projectId: project.id,
        trackId,
      });
      updateTrackList(getLiveProject().tracks.filter((track) => track.id !== trackId));
    },
    [getLiveProject, project.id, updateTrackList],
  );

  const updateClip = useCallback(
    async (clipId: string, patch: EditableClipPatch) => {
      const currentProject = getLiveProject();
      const currentClip = currentProject.clips.find((clip) => clip.id === clipId);
      if (!currentClip) {
        return;
      }

      const currentTrack = currentProject.tracks.find((track) => track.id === currentClip.trackId);
      const nextTrackId = patch.trackId ?? currentClip.trackId;
      const nextTrack = currentProject.tracks.find((track) => track.id === nextTrackId);
      if (!nextTrack || nextTrack.locked) {
        return;
      }
      if (currentTrack && currentTrack.type !== nextTrack.type) {
        return;
      }

      const hasChanges = Object.entries(patch).some(([key, value]) => {
        const currentValue = currentClip[key as keyof EditableClipPatch];
        return currentValue !== value;
      });
      if (!hasChanges) {
        return;
      }

      const optimisticClip = { ...currentClip, ...patch };
      updateClipList(
        currentProject.clips.map((clip) => (clip.id === clipId ? optimisticClip : clip)),
      );
      setSelectedClipId(clipId);

      try {
        const updatedClip = await composerClipIpc.update({
          projectId: project.id,
          clipId,
          ...patch,
        });

        updateClipList(
          useComposerProjectStore
            .getState()
            .currentProject?.clips.map((clip) => (clip.id === clipId ? updatedClip : clip)) ??
            currentProject.clips.map((clip) => (clip.id === clipId ? updatedClip : clip)),
        );
        pushUndo({
          type: "restore-updated",
          clipId,
          previous: getUndoClipSnapshot(currentClip),
        });
      } catch (error) {
        updateClipList(
          useComposerProjectStore
            .getState()
            .currentProject?.clips.map((clip) => (clip.id === clipId ? currentClip : clip)) ??
            currentProject.clips.map((clip) => (clip.id === clipId ? currentClip : clip)),
        );
        throw error;
      }
    },
    [getLiveProject, project.id, pushUndo, updateClipList],
  );

  const moveClip = useCallback(
    async (clipId: string, startTime: number, trackId?: string) => {
      const currentClip = getLiveProject().clips.find((clip) => clip.id === clipId);
      if (!currentClip) {
        return;
      }
      const currentTrack = getLiveProject().tracks.find((track) => track.id === currentClip.trackId);
      const nextTrackId = trackId ?? currentClip.trackId;
      const nextTrack = getLiveProject().tracks.find((track) => track.id === nextTrackId);
      if (!currentTrack || currentTrack.locked || !nextTrack || nextTrack.locked) {
        return;
      }
      if (currentTrack.type !== nextTrack.type) {
        return;
      }

      const nextStartTime = snapTimeToFrame(startTime, project.fps);
      if (
        Math.abs(nextStartTime - currentClip.startTime) < 0.001 &&
        nextTrackId === currentClip.trackId
      ) {
        return;
      }
      await updateClip(clipId, { startTime: nextStartTime, trackId: nextTrackId });
    },
    [getLiveProject, project.fps, updateClip],
  );

  const trimClip = useCallback(
    async (
      clipId: string,
      nextValues: Pick<Clip, "startTime" | "duration" | "trimStart" | "trimEnd">,
    ) => {
      const currentClip = getLiveProject().clips.find((clip) => clip.id === clipId);
      if (!currentClip) {
        return;
      }
      const currentTrack = getLiveProject().tracks.find((track) => track.id === currentClip.trackId);
      if (currentTrack?.locked) {
        return;
      }

      const normalized = {
        startTime: snapTimeToFrame(nextValues.startTime, project.fps),
        duration: Math.max(frameDuration, snapTimeToFrame(Math.max(MIN_CLIP_DURATION, nextValues.duration), project.fps)),
        trimStart: snapTimeToFrame(Math.max(0, nextValues.trimStart), project.fps),
        trimEnd: snapTimeToFrame(Math.max(0, nextValues.trimEnd ?? 0), project.fps),
      };

      const unchanged =
        Math.abs(normalized.startTime - currentClip.startTime) < 0.001 &&
        Math.abs(normalized.duration - currentClip.duration) < 0.001 &&
        Math.abs(normalized.trimStart - currentClip.trimStart) < 0.001 &&
        Math.abs((normalized.trimEnd ?? 0) - getTrimEnd(currentClip)) < 0.001;
      if (unchanged) {
        return;
      }

      await updateClip(clipId, normalized);
    },
    [frameDuration, getLiveProject, project.fps, updateClip],
  );

  const updateClipTransform = useCallback(
    async (
      clipId: string,
      nextValues: Pick<Clip, "transformOffsetX" | "transformOffsetY" | "transformScale">,
    ) => {
      const currentClip = getLiveProject().clips.find((clip) => clip.id === clipId);
      if (!currentClip) {
        return;
      }
      const currentTrack = getLiveProject().tracks.find((track) => track.id === currentClip.trackId);
      if (currentTrack?.locked) {
        return;
      }

      const unchanged =
        Math.abs(nextValues.transformOffsetX - currentClip.transformOffsetX) < 0.0001 &&
        Math.abs(nextValues.transformOffsetY - currentClip.transformOffsetY) < 0.0001 &&
        Math.abs(nextValues.transformScale - currentClip.transformScale) < 0.0001;
      if (unchanged) {
        return;
      }

      await updateClip(clipId, nextValues);
    },
    [getLiveProject, updateClip],
  );

  const splitSelectedClip = useCallback(async () => {
    const currentClip = getLiveProject().clips.find((clip) => clip.id === selectedClipId);
    if (!currentClip) {
      return;
    }
    const currentTrack = getLiveProject().tracks.find((track) => track.id === currentClip.trackId);
    if (currentTrack?.locked) {
      return;
    }

    const splitOffset = snapTimeToFrame(playhead - currentClip.startTime, project.fps);
    if (splitOffset <= MIN_CLIP_DURATION || splitOffset >= currentClip.duration - MIN_CLIP_DURATION) {
      return;
    }

    const originalTrimEnd = getTrimEnd(currentClip);
    const leftClip = await composerClipIpc.update({
      projectId: project.id,
      clipId: currentClip.id,
      duration: splitOffset,
      trimEnd: snapTimeToFrame(originalTrimEnd + (currentClip.duration - splitOffset), project.fps),
    });

      const rightClip = await composerClipIpc.add({
        projectId: project.id,
        trackId: currentClip.trackId,
        sourceType: currentClip.sourceType,
        sourcePath: currentClip.sourcePath,
      sourceAssetId: currentClip.sourceAssetId,
      startTime: snapTimeToFrame(playhead, project.fps),
        duration: Math.max(frameDuration, snapTimeToFrame(currentClip.duration - splitOffset, project.fps)),
       trimStart: snapTimeToFrame(currentClip.trimStart + splitOffset, project.fps),
        trimEnd: originalTrimEnd,
        speed: currentClip.speed,
        transformOffsetX: currentClip.transformOffsetX,
        transformOffsetY: currentClip.transformOffsetY,
        transformScale: currentClip.transformScale,
        rotationZ: currentClip.rotationZ,
        opacity: currentClip.opacity,
        brightness: currentClip.brightness,
        contrast: currentClip.contrast,
        saturation: currentClip.saturation,
        adjustments: currentClip.adjustments,
        fadeInDuration: currentClip.fadeInDuration,
        fadeOutDuration: currentClip.fadeOutDuration,
      });

    updateClipList([
      ...getLiveProject().clips
        .filter((clip) => clip.id !== currentClip.id)
        .concat(leftClip, rightClip),
    ]);
    setPreviewAsset(null);
    setSelectedClipId(rightClip.id);
    pushUndo({
      type: "restore-split",
      original: currentClip,
      createdClipId: rightClip.id,
    });
  }, [frameDuration, getLiveProject, playhead, project.fps, project.id, pushUndo, selectedClipId, updateClipList]);

  const deleteSelectedClip = useCallback(async () => {
    const currentClip = getLiveProject().clips.find((clip) => clip.id === selectedClipId);
    if (!currentClip) {
      return;
    }
    const currentTrack = getLiveProject().tracks.find((track) => track.id === currentClip.trackId);
    if (currentTrack?.locked) {
      return;
    }

    await composerClipIpc.delete({
      projectId: project.id,
      clipId: currentClip.id,
    });

    updateClipList(getLiveProject().clips.filter((clip) => clip.id !== currentClip.id));
    setPreviewAsset(null);
    setSelectedClipId(null);
    pushUndo({ type: "restore-deleted", clip: currentClip });
  }, [getLiveProject, project.id, pushUndo, selectedClipId, updateClipList]);

  const undo = useCallback(async () => {
    const previousEntry = undoStack[undoStack.length - 1];
    if (!previousEntry) {
      return;
    }

    setUndoStack((current) => current.slice(0, -1));

    switch (previousEntry.type) {
      case "delete-added": {
        await composerClipIpc.delete({
          projectId: project.id,
          clipId: previousEntry.clipId,
        });
        updateClipList(
          getLiveProject().clips.filter((clip) => clip.id !== previousEntry.clipId),
        );
        if (selectedClipId === previousEntry.clipId) {
          setSelectedClipId(null);
        }
        break;
      }
      case "restore-deleted": {
        const restoredClip = await composerClipIpc.add({
          projectId: project.id,
          id: previousEntry.clip.id,
          createdAt: previousEntry.clip.createdAt,
          trackId: previousEntry.clip.trackId,
          sourceType: previousEntry.clip.sourceType,
          sourcePath: previousEntry.clip.sourcePath,
          sourceAssetId: previousEntry.clip.sourceAssetId,
          startTime: previousEntry.clip.startTime,
          duration: previousEntry.clip.duration,
          trimStart: previousEntry.clip.trimStart,
          trimEnd: previousEntry.clip.trimEnd,
          speed: previousEntry.clip.speed,
          transformOffsetX: previousEntry.clip.transformOffsetX,
          transformOffsetY: previousEntry.clip.transformOffsetY,
          transformScale: previousEntry.clip.transformScale,
          rotationZ: previousEntry.clip.rotationZ,
          opacity: previousEntry.clip.opacity,
          brightness: previousEntry.clip.brightness,
          contrast: previousEntry.clip.contrast,
          saturation: previousEntry.clip.saturation,
          adjustments: previousEntry.clip.adjustments,
          fadeInDuration: previousEntry.clip.fadeInDuration,
          fadeOutDuration: previousEntry.clip.fadeOutDuration,
        });
        updateClipList([...getLiveProject().clips, restoredClip]);
        setSelectedClipId(restoredClip.id);
        break;
      }
      case "restore-updated": {
        const restoredClip = await composerClipIpc.update({
          projectId: project.id,
          clipId: previousEntry.clipId,
          trackId: previousEntry.previous.trackId,
          startTime: previousEntry.previous.startTime,
          duration: previousEntry.previous.duration,
          trimStart: previousEntry.previous.trimStart,
          trimEnd: previousEntry.previous.trimEnd,
          speed: previousEntry.previous.speed,
          transformOffsetX: previousEntry.previous.transformOffsetX,
          transformOffsetY: previousEntry.previous.transformOffsetY,
          transformScale: previousEntry.previous.transformScale,
          rotationZ: previousEntry.previous.rotationZ,
          opacity: previousEntry.previous.opacity,
          brightness: previousEntry.previous.brightness,
          contrast: previousEntry.previous.contrast,
          saturation: previousEntry.previous.saturation,
          adjustments: previousEntry.previous.adjustments,
          fadeInDuration: previousEntry.previous.fadeInDuration,
          fadeOutDuration: previousEntry.previous.fadeOutDuration,
        });
        updateClipList(
          getLiveProject().clips.map((clip) =>
            clip.id === previousEntry.clipId ? restoredClip : clip,
          ),
        );
        setSelectedClipId(previousEntry.clipId);
        break;
      }
      case "restore-split": {
        await composerClipIpc.delete({
          projectId: project.id,
          clipId: previousEntry.createdClipId,
        });
        const restoredClip = await composerClipIpc.update({
          projectId: project.id,
          clipId: previousEntry.original.id,
          startTime: previousEntry.original.startTime,
          duration: previousEntry.original.duration,
          trimStart: previousEntry.original.trimStart,
          trimEnd: previousEntry.original.trimEnd,
          speed: previousEntry.original.speed,
          trackId: previousEntry.original.trackId,
          transformOffsetX: previousEntry.original.transformOffsetX,
          transformOffsetY: previousEntry.original.transformOffsetY,
          transformScale: previousEntry.original.transformScale,
          rotationZ: previousEntry.original.rotationZ,
          opacity: previousEntry.original.opacity,
          brightness: previousEntry.original.brightness,
          contrast: previousEntry.original.contrast,
          saturation: previousEntry.original.saturation,
          adjustments: previousEntry.original.adjustments,
          fadeInDuration: previousEntry.original.fadeInDuration,
          fadeOutDuration: previousEntry.original.fadeOutDuration,
        });
        updateClipList(
          getLiveProject().clips
            .filter((clip) => clip.id !== previousEntry.createdClipId)
            .map((clip) => (clip.id === restoredClip.id ? restoredClip : clip)),
        );
        setSelectedClipId(restoredClip.id);
        break;
      }
    }
  }, [getLiveProject, project.id, selectedClipId, undoStack, updateClipList]);

  useEffect(() => {
    void refreshSequencePreview();
  }, [
    clips,
    project.duration,
    project.fps,
    project.height,
    project.id,
    project.playbackQuality,
    project.width,
    refreshSequencePreview,
    tracks,
  ]);

  useEffect(() => {
    if (previewAsset) {
      return;
    }

    if (!isPlaybackWaiting && project.sequencePreview.status !== "processing") {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshSequencePreview();
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [
    isPlaybackWaiting,
    previewAsset,
    project.sequencePreview.status,
    refreshSequencePreview,
  ]);

  useEffect(() => {
    if (
      !isPlaybackWaiting ||
      previewAsset ||
      project.sequencePreview.status !== "ready" ||
      !project.sequencePreview.filePath
    ) {
      return;
    }

    const requestedStartTime =
      pendingSequencePlaybackStartTime ?? playheadRef.current;
    playheadRef.current = requestedStartTime;
    setPlayhead(requestedStartTime);
    setIsPlaybackWaiting(false);
    playbackRef.current.startedAt = performance.now();
    playbackRef.current.originPlayhead = requestedStartTime;
    setIsPlaying(true);
  }, [
    isPlaybackWaiting,
    pendingSequencePlaybackStartTime,
    previewAsset,
    project.sequencePreview.filePath,
    project.sequencePreview.status,
  ]);

  useEffect(() => {
    setPreviewAsset(null);
    setSelectedClipId(null);
    setPlayhead(0);
    setPendingSequencePlaybackStartTime(null);
    setIsPlaying(false);
    setIsPlaybackWaiting(false);
    setPlaybackClockSourceState("timeline");
    setUndoStack([]);
  }, [project.id]);

  useEffect(() => {
    if (selectedClipId && !clips.some((clip) => clip.id === selectedClipId)) {
      setSelectedClipId(null);
    }
  }, [clips, selectedClipId]);

  useEffect(() => {
    if (playhead > timelineDuration) {
      setPlayhead(timelineDuration);
    }
  }, [playhead, timelineDuration]);

  useEffect(() => {
    if (!isPlaying) {
      if (playbackRef.current.rafId) {
        cancelAnimationFrame(playbackRef.current.rafId);
        playbackRef.current.rafId = 0;
      }
      return;
    }

    if (playbackClockSource === "media") {
      return;
    }

    playbackRef.current.startedAt = performance.now();
    playbackRef.current.originPlayhead = playhead;

    const tick = (now: number) => {
      const nextTime = clamp(
        snapTimeToFrame(
          playbackRef.current.originPlayhead + (now - playbackRef.current.startedAt) / 1000,
          project.fps,
        ),
        0,
        timelineDuration,
      );
      setPlayhead(nextTime);

      if (nextTime >= timelineDuration) {
        setPendingSequencePlaybackStartTime(null);
        setIsPlaying(false);
        return;
      }

      playbackRef.current.rafId = requestAnimationFrame(tick);
    };

    playbackRef.current.rafId = requestAnimationFrame(tick);
    return () => {
      if (playbackRef.current.rafId) {
        cancelAnimationFrame(playbackRef.current.rafId);
        playbackRef.current.rafId = 0;
      }
    };
  }, [isPlaying, playbackClockSource, playhead, project.fps, timelineDuration]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName ?? "";
      const isTyping =
        target?.isContentEditable ||
        tagName === "INPUT" ||
        tagName === "TEXTAREA" ||
        tagName === "SELECT";
      if (isTyping) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void undo();
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        void deleteSelectedClip();
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [deleteSelectedClip, togglePlayback, undo]);

  const value = useMemo<ComposerRuntimeContextValue>(
    () => ({
      project,
      tracks,
      clips,
      previewAsset,
      selectedClipId,
      selectedClip,
      selectedVisualClip,
      playhead,
      pendingSequencePlaybackStartTime,
      isPlaying,
      isPlaybackWaiting,
      zoom,
      timelineDuration,
      canUndo: undoStack.length > 0,
      activeVisualClip,
      activeAudioClip,
      seek,
      syncPlaybackToMediaClock,
      setPlaybackClockSource,
      togglePlayback,
      pausePlayback,
      stopPlayback,
      selectClip,
      previewLibraryAsset,
      setZoom,
      addTrack,
      deleteTrack,
      updateTrack,
      addAssetToTrack,
      moveClip,
      trimClip,
      updateClip,
      updateClipTransform,
      splitSelectedClip,
      deleteSelectedClip,
      undo,
      getAssetUrl,
      getMediaDuration,
    }),
    [
      activeAudioClip,
      activeVisualClip,
      addAssetToTrack,
      addTrack,
      clips,
      deleteTrack,
      deleteSelectedClip,
      isPlaying,
      isPlaybackWaiting,
      moveClip,
      pausePlayback,
      playhead,
      playbackClockSource,
      previewAsset,
      previewLibraryAsset,
      project,
      seek,
      setPlaybackClockSource,
      selectClip,
      selectedClip,
      selectedClipId,
      selectedVisualClip,
      splitSelectedClip,
      stopPlayback,
      syncPlaybackToMediaClock,
      timelineDuration,
      togglePlayback,
      tracks,
      trimClip,
      updateClip,
      updateTrack,
      updateClipTransform,
      undo,
      undoStack.length,
      zoom,
      getMediaDuration,
    ],
  );

  return (
    <ComposerRuntimeContext.Provider value={value}>
      {children}
    </ComposerRuntimeContext.Provider>
  );
}

export function useComposerRuntime(): ComposerRuntimeContextValue {
  const context = useContext(ComposerRuntimeContext);
  if (!context) {
    throw new Error("useComposerRuntime must be used inside ComposerRuntimeProvider");
  }
  return context;
}
