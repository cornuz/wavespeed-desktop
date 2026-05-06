/**
 * Timeline IPC handlers for the Composer module.
 * Handles track and clip CRUD operations.
 */
import { ipcMain } from "electron";
import {
  createTrack,
  updateTrack,
  deleteTrack,
} from "../db/tracks.repo";
import {
  createClip,
  getClipById,
  updateClip,
  deleteClip,
} from "../db/clips.repo";
import {
  buildDirtyRangeForClip,
  invalidateProjectSequencePreview,
  scheduleProjectSequencePreviewRefresh,
} from "../sequence-preview";
import {
  clearTimelineLutProxy,
  ensureTimelineLutProxy,
} from "../timeline-lut-proxy";
import type { Track, Clip } from "../../../src/composer/types/project";
import type {
  AddTrackInput,
  UpdateTrackInput,
  DeleteTrackInput,
  AddClipInput,
  UpdateClipInput,
  DeleteClipInput,
  ResolveTimelineLutProxyResult,
} from "../../../src/composer/types/ipc";

export function registerTimelineIpc(): void {
  // ── Tracks ──────────────────────────────────────────────────────────────

  ipcMain.handle(
    "composer:track-add",
    async (_event, input: AddTrackInput): Promise<Track> => {
      const track = createTrack(input.projectId, input.name, input.type);
      invalidateProjectSequencePreview(input.projectId, ["timeline"], {
        fullReset: true,
      });
      void scheduleProjectSequencePreviewRefresh(input.projectId);
      return track;
    },
  );

  ipcMain.handle(
    "composer:track-update",
    async (_event, input: UpdateTrackInput): Promise<Track> => {
      const track = updateTrack(input.projectId, input.trackId, {
        name: input.name,
        muted: input.muted,
        locked: input.locked,
        visible: input.visible,
        order: input.order,
      });
      if (
        input.muted !== undefined ||
        input.visible !== undefined ||
        input.order !== undefined
      ) {
        invalidateProjectSequencePreview(input.projectId, ["timeline"], {
          fullReset: true,
        });
        void scheduleProjectSequencePreviewRefresh(input.projectId);
      }
      return track;
    },
  );

  ipcMain.handle(
    "composer:track-delete",
    async (_event, input: DeleteTrackInput): Promise<void> => {
      deleteTrack(input.projectId, input.trackId);
      invalidateProjectSequencePreview(input.projectId, ["timeline"], {
        fullReset: true,
      });
      void scheduleProjectSequencePreviewRefresh(input.projectId);
    },
  );

  // ── Clips ────────────────────────────────────────────────────────────────

  ipcMain.handle(
    "composer:clip-add",
    async (_event, input: AddClipInput): Promise<Clip> => {
      const clip = createClip(input.projectId, {
        id: input.id,
        trackId: input.trackId,
        sourceType: input.sourceType,
        sourcePath: input.sourcePath,
        sourceAssetId: input.sourceAssetId,
        startTime: input.startTime,
        duration: input.duration,
        trimStart: input.trimStart,
        trimEnd: input.trimEnd,
        speed: input.speed,
        transformOffsetX: input.transformOffsetX,
        transformOffsetY: input.transformOffsetY,
        transformScale: input.transformScale,
        flipHorizontal: input.flipHorizontal,
        flipVertical: input.flipVertical,
        rotationZ: input.rotationZ,
        opacity: input.opacity,
        brightness: input.brightness,
        contrast: input.contrast,
        saturation: input.saturation,
        adjustments: input.adjustments,
        fadeInDuration: input.fadeInDuration,
        fadeOutDuration: input.fadeOutDuration,
        createdAt: input.createdAt,
      });
      try {
        const derived = await ensureTimelineLutProxy(input.projectId, clip);
        clip.derivedMediaId = derived.derivedMediaId;
        clip.lutProxyPath = derived.path;
        updateClip(input.projectId, clip.id, {
          derivedMediaId: derived.derivedMediaId,
          lutProxyPath: derived.path,
        });
      } catch (error) {
        console.warn("[Composer] Failed to generate timeline LUT proxy on clip add:", error);
      }
      invalidateProjectSequencePreview(input.projectId, ["timeline"], {
        dirtyRange: buildDirtyRangeForClip(clip),
      });
      void scheduleProjectSequencePreviewRefresh(input.projectId);
      return clip;
    },
  );

  ipcMain.handle(
    "composer:clip-update",
    async (_event, input: UpdateClipInput): Promise<Clip> => {
      const previousClip = getClipById(input.projectId, input.clipId);
      const clip = updateClip(input.projectId, input.clipId, {
        startTime: input.startTime,
        duration: input.duration,
        trimStart: input.trimStart,
        trimEnd: input.trimEnd,
        speed: input.speed,
        trackId: input.trackId,
        transformOffsetX: input.transformOffsetX,
        transformOffsetY: input.transformOffsetY,
        transformScale: input.transformScale,
        flipHorizontal: input.flipHorizontal,
        flipVertical: input.flipVertical,
        rotationZ: input.rotationZ,
        opacity: input.opacity,
        brightness: input.brightness,
        contrast: input.contrast,
        saturation: input.saturation,
        adjustments: input.adjustments,
        fadeInDuration: input.fadeInDuration,
        fadeOutDuration: input.fadeOutDuration,
      });
      try {
        const derived = await ensureTimelineLutProxy(input.projectId, clip);
        clip.derivedMediaId = derived.derivedMediaId;
        clip.lutProxyPath = derived.path;
        updateClip(input.projectId, clip.id, {
          derivedMediaId: derived.derivedMediaId,
          lutProxyPath: derived.path,
        });
      } catch (error) {
        console.warn(
          "[Composer] Failed to generate timeline LUT proxy on clip update:",
          error,
        );
      }
      invalidateProjectSequencePreview(input.projectId, ["timeline"], {
        dirtyRange: {
          startTime: Math.min(
            buildDirtyRangeForClip(previousClip).startTime,
            buildDirtyRangeForClip(clip).startTime,
          ),
          endTime: Math.max(
            buildDirtyRangeForClip(previousClip).endTime,
            buildDirtyRangeForClip(clip).endTime,
          ),
        },
      });
      void scheduleProjectSequencePreviewRefresh(input.projectId);
      return clip;
    },
  );

  ipcMain.handle(
    "composer:clip-resolve-timeline-lut-proxy",
    async (_event, input: { projectId: string; clipId: string }): Promise<ResolveTimelineLutProxyResult> => {
      const clip = getClipById(input.projectId, input.clipId);
      const resolution = await ensureTimelineLutProxy(input.projectId, clip);
      if (
        clip.lutProxyPath !== resolution.path ||
        clip.derivedMediaId !== resolution.derivedMediaId
      ) {
        updateClip(input.projectId, clip.id, {
          derivedMediaId: resolution.derivedMediaId,
          lutProxyPath: resolution.path,
        });
      }
      return resolution;
    },
  );

  ipcMain.handle(
    "composer:clip-delete",
    async (_event, input: DeleteClipInput): Promise<void> => {
      const clip = getClipById(input.projectId, input.clipId);
      clearTimelineLutProxy(input.projectId, clip.id);
      deleteClip(input.projectId, input.clipId);
      invalidateProjectSequencePreview(input.projectId, ["timeline"], {
        dirtyRange: buildDirtyRangeForClip(clip),
      });
      void scheduleProjectSequencePreviewRefresh(input.projectId);
    },
  );
}
