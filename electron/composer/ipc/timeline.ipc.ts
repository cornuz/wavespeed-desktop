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
  updateClip,
  deleteClip,
} from "../db/clips.repo";
import {
  invalidateProjectSequencePreview,
  scheduleProjectSequencePreviewRefresh,
} from "../sequence-preview";
import type { Track, Clip } from "../../../src/composer/types/project";
import type {
  AddTrackInput,
  UpdateTrackInput,
  DeleteTrackInput,
  AddClipInput,
  UpdateClipInput,
  DeleteClipInput,
} from "../../../src/composer/types/ipc";

export function registerTimelineIpc(): void {
  // ── Tracks ──────────────────────────────────────────────────────────────

  ipcMain.handle(
    "composer:track-add",
    async (_event, input: AddTrackInput): Promise<Track> => {
      const track = createTrack(input.projectId, input.name, input.type);
      invalidateProjectSequencePreview(input.projectId, ["timeline"]);
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
        invalidateProjectSequencePreview(input.projectId, ["timeline"]);
        void scheduleProjectSequencePreviewRefresh(input.projectId);
      }
      return track;
    },
  );

  ipcMain.handle(
    "composer:track-delete",
    async (_event, input: DeleteTrackInput): Promise<void> => {
      deleteTrack(input.projectId, input.trackId);
      invalidateProjectSequencePreview(input.projectId, ["timeline"]);
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
        rotationZ: input.rotationZ,
        opacity: input.opacity,
        fadeInDuration: input.fadeInDuration,
        fadeOutDuration: input.fadeOutDuration,
        createdAt: input.createdAt,
      });
      invalidateProjectSequencePreview(input.projectId, ["timeline"]);
      void scheduleProjectSequencePreviewRefresh(input.projectId);
      return clip;
    },
  );

  ipcMain.handle(
    "composer:clip-update",
    async (_event, input: UpdateClipInput): Promise<Clip> => {
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
        rotationZ: input.rotationZ,
        opacity: input.opacity,
        fadeInDuration: input.fadeInDuration,
        fadeOutDuration: input.fadeOutDuration,
      });
      invalidateProjectSequencePreview(input.projectId, ["timeline"]);
      void scheduleProjectSequencePreviewRefresh(input.projectId);
      return clip;
    },
  );

  ipcMain.handle(
    "composer:clip-delete",
    async (_event, input: DeleteClipInput): Promise<void> => {
      deleteClip(input.projectId, input.clipId);
      invalidateProjectSequencePreview(input.projectId, ["timeline"]);
      void scheduleProjectSequencePreviewRefresh(input.projectId);
    },
  );
}
