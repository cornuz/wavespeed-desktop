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
      return createTrack(input.projectId, input.name, input.type);
    },
  );

  ipcMain.handle(
    "composer:track-update",
    async (_event, input: UpdateTrackInput): Promise<Track> => {
      return updateTrack(input.projectId, input.trackId, {
        name: input.name,
        muted: input.muted,
        locked: input.locked,
        visible: input.visible,
        order: input.order,
      });
    },
  );

  ipcMain.handle(
    "composer:track-delete",
    async (_event, input: DeleteTrackInput): Promise<void> => {
      deleteTrack(input.projectId, input.trackId);
    },
  );

  // ── Clips ────────────────────────────────────────────────────────────────

  ipcMain.handle(
    "composer:clip-add",
    async (_event, input: AddClipInput): Promise<Clip> => {
      return createClip(input.projectId, {
        trackId: input.trackId,
        sourceType: input.sourceType,
        sourcePath: input.sourcePath,
        sourceAssetId: input.sourceAssetId,
        startTime: input.startTime,
        duration: input.duration,
        trimStart: input.trimStart,
        trimEnd: input.trimEnd,
        speed: input.speed,
      });
    },
  );

  ipcMain.handle(
    "composer:clip-update",
    async (_event, input: UpdateClipInput): Promise<Clip> => {
      return updateClip(input.projectId, input.clipId, {
        startTime: input.startTime,
        duration: input.duration,
        trimStart: input.trimStart,
        trimEnd: input.trimEnd,
        speed: input.speed,
        trackId: input.trackId,
      });
    },
  );

  ipcMain.handle(
    "composer:clip-delete",
    async (_event, input: DeleteClipInput): Promise<void> => {
      deleteClip(input.projectId, input.clipId);
    },
  );
}
