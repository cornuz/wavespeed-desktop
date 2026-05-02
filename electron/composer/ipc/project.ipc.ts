/**
 * Project IPC handlers for the Composer module.
 * Handles project create, open, close, list, rename, delete, and save.
 */
import { ipcMain, app, shell } from "electron";
import { v4 as uuid } from "uuid";
import { basename, join, relative } from "path";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import {
  openProjectDatabase,
  closeProjectDatabase,
  getProjectDatabase,
  persistProjectDatabaseNow,
} from "../db/connection";
import {
  loadRegistry,
  addProjectToRegistry,
  removeProjectFromRegistry,
  updateProjectSummary,
  updateProjectTimestamps,
} from "../db/project-registry";
import {
  ensureComposerFfmpegAvailable,
  getComposerFfmpegStatus,
} from "../ffmpeg";
import { loadAssetMetadata, saveAssetMetadata } from "../asset-metadata";
import { createDefaultTracks, listTracks } from "../db/tracks.repo";
import { listClips } from "../db/clips.repo";
import {
  disposeProjectSequencePreview,
  ensureProjectSequencePreview,
  getProjectSequencePreview,
  invalidateProjectSequencePreview,
  scheduleProjectSequencePreviewRefresh,
} from "../sequence-preview";
import type {
  ComposerPlaybackQuality,
  ComposerProject,
  ComposerProjectSummary,
} from "../../../src/composer/types/project";
import type {
  LayoutPreset,
  LayoutSizesMap,
} from "../../../src/composer/types/project";
import type {
  ComposerFfmpegStatus,
  CreateProjectInput,
  OpenProjectInput,
  OpenProjectLocationInput,
  RenameProjectInput,
  SetProjectFavoriteInput,
  DuplicateProjectInput,
  DeleteProjectInput,
  GetSequencePreviewInput,
  InvalidateSequencePreviewInput,
  SaveProjectInput,
} from "../../../src/composer/types/ipc";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the current user-configured assets directory. */
function getAssetsDirectory(): string {
  try {
    const settingsPath = join(app.getPath("userData"), "settings.json");
    if (existsSync(settingsPath)) {
      const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (data.assetsDirectory) return data.assetsDirectory as string;
    }
  } catch {
    /* fall through to default */
  }
  return join(app.getPath("documents"), "WaveSpeed");
}

/** Derives the project folder path from assetsDirectory + project name. */
function getComposerProjectsRoot(): string {
  return join(getAssetsDirectory(), "composer");
}

/** Stable storage path for new projects, independent from display title. */
function getProjectFolderPath(projectId: string): string {
  return join(getComposerProjectsRoot(), projectId);
}

function getProjectDatabasePath(
  projectId: string,
  projectFolder: string,
): string {
  return join(projectFolder, `${projectId}.composer`);
}

function getProjectAssetsPath(projectFolder: string): string {
  return join(projectFolder, "assets");
}

function getDuplicateProjectName(
  sourceName: string,
  existingNames: string[],
): string {
  const trimmedSourceName = sourceName.trim();
  const lowerCaseNames = new Set(existingNames.map((name) => name.toLowerCase()));
  let copyIndex = 1;

  while (true) {
    const candidate =
      copyIndex === 1
        ? `Copy - ${trimmedSourceName}`
        : `Copy ${copyIndex} - ${trimmedSourceName}`;
    if (!lowerCaseNames.has(candidate.toLowerCase())) {
      return candidate;
    }
    copyIndex += 1;
  }
}

function remapProjectPath(
  filePath: string,
  sourceProjectPath: string,
  targetProjectPath: string,
): string {
  const relativePath = relative(sourceProjectPath, filePath);
  if (relativePath.startsWith("..")) {
    return filePath;
  }
  return join(targetProjectPath, relativePath);
}

function rewriteDuplicatedAssetMetadata(
  sourceProjectPath: string,
  targetProjectPath: string,
): void {
  const targetAssetsPath = getProjectAssetsPath(targetProjectPath);
  if (!existsSync(targetAssetsPath)) {
    return;
  }

  const metadata = loadAssetMetadata(targetAssetsPath);
  const remappedEntries = Object.entries(metadata).map(([assetPath, value]) => {
    const nextAssetPath = remapProjectPath(
      assetPath,
      sourceProjectPath,
      targetProjectPath,
    );
    return [
      nextAssetPath,
      {
        ...value,
        workingPath: value.workingPath
          ? remapProjectPath(
              value.workingPath,
              sourceProjectPath,
              targetProjectPath,
            )
          : undefined,
      },
    ] as const;
  });

  saveAssetMetadata(targetAssetsPath, Object.fromEntries(remappedEntries));
}

function resolveProjectDatabasePath(summary: ComposerProjectSummary): string {
  const stablePath = getProjectDatabasePath(summary.id, summary.path);
  if (existsSync(stablePath)) {
    return stablePath;
  }

  const legacyNamedPath = join(summary.path, `${summary.name}.composer`);
  if (existsSync(legacyNamedPath)) {
    return legacyNamedPath;
  }

  if (existsSync(summary.path)) {
    const composerFiles = readdirSync(summary.path, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && entry.name.toLowerCase().endsWith(".composer"),
      )
      .map((entry) => join(summary.path, entry.name));
    if (composerFiles.length > 0) {
      return composerFiles[0];
    }
  }

  return stablePath;
}

function calculateDirectorySize(dirPath: string): number {
  if (!existsSync(dirPath)) {
    return 0;
  }

  try {
    return readdirSync(dirPath, { withFileTypes: true }).reduce(
      (total, entry) => {
        const entryPath = join(dirPath, entry.name);
        try {
          if (entry.isDirectory()) {
            return total + calculateDirectorySize(entryPath);
          }
          return total + statSync(entryPath).size;
        } catch {
          return total;
        }
      },
      0,
    );
  } catch {
    return 0;
  }
}

function getLatestSequencePreviewPath(projectPath: string): string | null {
  const cachePath = join(projectPath, "cache");
  if (!existsSync(cachePath)) {
    return null;
  }

  const previewEntries = readdirSync(cachePath, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /^seqprev-[0-9a-f]+\.mp4$/i.test(entry.name),
    )
    .map((entry) => {
      const filePath = join(cachePath, entry.name);
      const modifiedAt = statSync(filePath).mtimeMs;
      return { filePath, modifiedAt };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  return previewEntries[0]?.filePath ?? null;
}

function enrichProjectSummary(
  summary: ComposerProjectSummary,
): ComposerProjectSummary {
  return {
    ...summary,
    favorite: summary.favorite ?? false,
    previewPath: getLatestSequencePreviewPath(summary.path),
    sizeOnDiskBytes: calculateDirectorySize(summary.path),
  };
}

/** Reads meta row from an open DB and returns duration + fps + layout. */
function readProjectMeta(projectId: string): {
  duration: number;
  fps: number;
  width: number;
  height: number;
  playbackQuality: ComposerPlaybackQuality;
  safeZoneEnabled: boolean;
  safeZoneMargin: number;
  projectName: string;
  layoutPreset: LayoutPreset;
  layoutSizes: LayoutSizesMap;
} {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);
  const result = db.exec(
    `SELECT duration, fps, width, height, playback_quality, safe_zone_enabled, safe_zone_margin, project_name, layout_preset, layout_sizes FROM meta LIMIT 1`,
  );
  const row = result[0]?.values?.[0];
  if (!row) throw new Error("meta row missing");
  let layoutSizes: LayoutSizesMap = {};
  try {
    layoutSizes = JSON.parse(row[9] as string) as LayoutSizesMap;
  } catch {
    /* keep empty map */
  }
  return {
    duration: row[0] as number,
    fps: row[1] as number,
    width: row[2] as number,
    height: row[3] as number,
    playbackQuality: ((row[4] as string) || "med") as ComposerPlaybackQuality,
    safeZoneEnabled: Boolean(row[5]),
    safeZoneMargin: row[6] as number,
    projectName: row[7] as string,
    layoutPreset: ((row[8] as string) || "timeline") as LayoutPreset,
    layoutSizes,
  };
}

/** Assembles a full ComposerProject from an already-open DB. */
function buildProject(
  projectId: string,
  summary: ComposerProjectSummary,
): ComposerProject {
  const {
    duration,
    fps,
    width,
    height,
    playbackQuality,
    safeZoneEnabled,
    safeZoneMargin,
    layoutPreset,
    layoutSizes,
  } = readProjectMeta(projectId);
  const tracks = listTracks(projectId);
  const clips = listClips(projectId);
  return {
    ...summary,
    duration,
    fps,
    width,
    height,
    playbackQuality,
    safeZoneEnabled,
    safeZoneMargin,
    sequencePreview: getProjectSequencePreview(projectId),
    tracks,
    clips,
    layoutPreset,
    layoutSizes,
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerProjectIpc(): void {
  // ── FFmpeg gate status ──────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:ffmpeg-check",
    async (): Promise<ComposerFfmpegStatus> => {
      return getComposerFfmpegStatus();
    },
  );

  // ── List ──────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:project-list",
    async (): Promise<ComposerProjectSummary[]> => {
      return loadRegistry().projects.map(enrichProjectSummary);
    },
  );

  // ── Create ────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:project-create",
    async (_event, input: CreateProjectInput): Promise<ComposerProject> => {
      const name = input.name.trim();
      if (!name) throw new Error("Project name cannot be empty");
      await ensureComposerFfmpegAvailable();

      const id = uuid();
      const now = new Date().toISOString();
      const projectFolder = getProjectFolderPath(id);
      const dbPath = getProjectDatabasePath(id, projectFolder);

      // Create folder structure
      for (const sub of ["", "assets", "exports", "cache", "autosave"]) {
        const dir = sub ? join(projectFolder, sub) : projectFolder;
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      }

      // Open (creates) the DB
      const db = await openProjectDatabase(id, dbPath, name);
      void db; // already stored in the Map

      // Create default tracks
      createDefaultTracks(id);

      const summary: ComposerProjectSummary = {
        id,
        name,
        path: projectFolder,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
        favorite: false,
        previewPath: null,
        sizeOnDiskBytes: 0,
      };

      addProjectToRegistry(summary);

      const project = buildProject(id, summary);
      project.sequencePreview = ensureProjectSequencePreview(id);
      return project;
    },
  );

  // ── Open ──────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:project-open",
    async (_event, input: OpenProjectInput): Promise<ComposerProject> => {
      const registry = loadRegistry();
      const summary = registry.projects.find((p) => p.id === input.id);
      if (!summary)
        throw new Error(`Project ${input.id} not found in registry`);
      await ensureComposerFfmpegAvailable();

      const dbPath = resolveProjectDatabasePath(summary);
      await openProjectDatabase(input.id, dbPath, summary.name);

      const now = new Date().toISOString();
      updateProjectTimestamps(input.id, { lastOpenedAt: now });
      summary.lastOpenedAt = now;

      const project = buildProject(input.id, summary);
      project.sequencePreview = ensureProjectSequencePreview(input.id);
      return project;
    },
  );

  ipcMain.handle(
    "composer:project-open-location",
    async (_event, input: OpenProjectLocationInput): Promise<void> => {
      const summary = loadRegistry().projects.find(
        (project) => project.id === input.id,
      );
      if (!summary) {
        throw new Error(`Project ${input.id} not found in registry`);
      }

      const error = await shell.openPath(summary.path);
      if (error) {
        throw new Error(error);
      }
    },
  );

  // ── Close ─────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:project-close",
    async (_event, { id }: { id: string }): Promise<void> => {
      disposeProjectSequencePreview(id);
      persistProjectDatabaseNow(id);
      closeProjectDatabase(id);
    },
  );

  // ── Save ──────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:project-save",
    async (_event, input: SaveProjectInput): Promise<void> => {
      const db = getProjectDatabase(input.id);
      if (!db) throw new Error(`Project ${input.id} is not open`);

      const now = new Date().toISOString();
      const updates: string[] = ["updated_at = ?"];
      const values: unknown[] = [now];

      if (input.duration !== undefined) {
        updates.push("duration = ?");
        values.push(input.duration);
      }
      if (input.fps !== undefined) {
        updates.push("fps = ?");
        values.push(input.fps);
      }
      if (input.width !== undefined) {
        updates.push("width = ?");
        values.push(input.width);
      }
      if (input.height !== undefined) {
        updates.push("height = ?");
        values.push(input.height);
      }
      if (input.playbackQuality !== undefined) {
        updates.push("playback_quality = ?");
        values.push(input.playbackQuality);
      }
      if (input.safeZoneEnabled !== undefined) {
        updates.push("safe_zone_enabled = ?");
        values.push(input.safeZoneEnabled ? 1 : 0);
      }
      if (input.safeZoneMargin !== undefined) {
        updates.push("safe_zone_margin = ?");
        values.push(input.safeZoneMargin);
      }
      if (input.layoutPreset !== undefined) {
        updates.push("layout_preset = ?");
        values.push(input.layoutPreset);
      }
      if (input.layoutSizes !== undefined) {
        updates.push("layout_sizes = ?");
        values.push(JSON.stringify(input.layoutSizes));
      }

      // meta is a singleton row — no WHERE clause needed
      db.run(`UPDATE meta SET ${updates.join(", ")}`, values);

      persistProjectDatabaseNow(input.id);
      updateProjectTimestamps(input.id, { updatedAt: now });

      if (
        input.duration !== undefined ||
        input.fps !== undefined ||
        input.playbackQuality !== undefined ||
        input.width !== undefined ||
        input.height !== undefined
      ) {
        const invalidationCauses = [
          ...(input.duration !== undefined || input.fps !== undefined
            ? (["timeline"] as const)
            : []),
          ...(input.playbackQuality !== undefined
            ? (["playback-quality"] as const)
            : []),
          ...(input.width !== undefined || input.height !== undefined
            ? (["dimensions"] as const)
            : []),
        ];
        if (invalidationCauses.length > 0) {
          invalidateProjectSequencePreview(input.id, [...invalidationCauses]);
          void scheduleProjectSequencePreviewRefresh(input.id);
        }
      }
    },
  );

  ipcMain.handle(
    "composer:sequence-preview-get",
    async (_event, input: GetSequencePreviewInput) =>
      getProjectSequencePreview(input.projectId),
  );

  ipcMain.handle(
    "composer:sequence-preview-invalidate",
    async (_event, input: InvalidateSequencePreviewInput) => {
      invalidateProjectSequencePreview(input.projectId, input.causes);
      return scheduleProjectSequencePreviewRefresh(input.projectId);
    },
  );

  // ── Rename ────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:project-rename",
    async (_event, input: RenameProjectInput): Promise<void> => {
      const name = input.name.trim();
      if (!name) throw new Error("Project name cannot be empty");

      const db = getProjectDatabase(input.id);
      if (db) {
        const now = new Date().toISOString();
        db.run(`UPDATE meta SET project_name = ?, updated_at = ?`, [name, now]);
        persistProjectDatabaseNow(input.id);
      }

      const now = new Date().toISOString();
      updateProjectTimestamps(input.id, { name, updatedAt: now });
    },
  );

  ipcMain.handle(
    "composer:project-set-favorite",
    async (
      _event,
      input: SetProjectFavoriteInput,
    ): Promise<ComposerProjectSummary> => {
      const updated = updateProjectSummary(input.id, {
        favorite: input.favorite,
      });
      if (!updated) {
        throw new Error(`Project ${input.id} not found in registry`);
      }
      return enrichProjectSummary(updated);
    },
  );

  ipcMain.handle(
    "composer:project-duplicate",
    async (
      _event,
      input: DuplicateProjectInput,
    ): Promise<ComposerProjectSummary> => {
      const registry = loadRegistry();
      const sourceSummary = registry.projects.find((project) => project.id === input.id);
      if (!sourceSummary) {
        throw new Error(`Project ${input.id} not found in registry`);
      }

      persistProjectDatabaseNow(sourceSummary.id);

      const duplicateId = uuid();
      const now = new Date().toISOString();
      const duplicateName = getDuplicateProjectName(
        sourceSummary.name,
        registry.projects.map((project) => project.name),
      );
      const duplicatePath = getProjectFolderPath(duplicateId);
      const duplicateDatabasePath = getProjectDatabasePath(duplicateId, duplicatePath);
      const sourceDatabasePath = resolveProjectDatabasePath(sourceSummary);
      const sourceSequencePreviewPath = getLatestSequencePreviewPath(sourceSummary.path);
      const duplicateSequencePreviewPath = sourceSequencePreviewPath
        ? join(duplicatePath, "cache", basename(sourceSequencePreviewPath))
        : null;

      for (const sub of ["", "assets", "exports", "cache", "autosave"]) {
        const dir = sub ? join(duplicatePath, sub) : duplicatePath;
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }

      copyFileSync(sourceDatabasePath, duplicateDatabasePath);

      const sourceAssetsPath = getProjectAssetsPath(sourceSummary.path);
      const duplicateAssetsPath = getProjectAssetsPath(duplicatePath);
      if (existsSync(sourceAssetsPath)) {
        cpSync(sourceAssetsPath, duplicateAssetsPath, { recursive: true });
      }
      if (sourceSequencePreviewPath && duplicateSequencePreviewPath) {
        copyFileSync(sourceSequencePreviewPath, duplicateSequencePreviewPath);
      }
      rewriteDuplicatedAssetMetadata(sourceSummary.path, duplicatePath);

      await openProjectDatabase(duplicateId, duplicateDatabasePath, duplicateName);
      const duplicateDb = getProjectDatabase(duplicateId);
      if (!duplicateDb) {
        throw new Error(`Failed to open duplicated project ${duplicateId}`);
      }

      duplicateDb.run(
        `UPDATE meta SET project_name = ?, updated_at = ?`,
        [duplicateName, now],
      );
      duplicateDb.run(
        `UPDATE clips
         SET source_path = CASE
               WHEN source_path IS NULL THEN NULL
               ELSE REPLACE(source_path, ?, ?)
             END,
             source_asset_id = CASE
               WHEN source_asset_id IS NULL THEN NULL
               ELSE REPLACE(source_asset_id, ?, ?)
             END`,
        [
          sourceSummary.path,
          duplicatePath,
          sourceSummary.path,
          duplicatePath,
        ],
      );
      if (duplicateSequencePreviewPath) {
        duplicateDb.run(
          `UPDATE sequence_preview
           SET file_path = ?,
               updated_at = ?,
               error_message = NULL
           WHERE id = 1`,
          [duplicateSequencePreviewPath, now],
        );
      } else {
        duplicateDb.run(
          `UPDATE sequence_preview
           SET status = 'missing',
               request_signature = '',
               request_json = '{}',
               file_path = NULL,
               invalidation_reasons = '[]',
               error_message = NULL,
               updated_at = ?,
               last_requested_at = NULL,
               started_at = NULL,
               completed_at = NULL,
               invalidated_at = NULL
           WHERE id = 1`,
          [now],
        );
      }
      persistProjectDatabaseNow(duplicateId);
      closeProjectDatabase(duplicateId);

      const summary: ComposerProjectSummary = {
        id: duplicateId,
        name: duplicateName,
        path: duplicatePath,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
        favorite: false,
        previewPath: null,
        sizeOnDiskBytes: 0,
      };
      addProjectToRegistry(summary);
      return enrichProjectSummary(summary);
    },
  );

  // ── Delete ────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:project-delete",
    async (_event, input: DeleteProjectInput): Promise<void> => {
      // Close DB if open
      disposeProjectSequencePreview(input.id);
      closeProjectDatabase(input.id);

      const registry = loadRegistry();
      const summary = registry.projects.find((p) => p.id === input.id);

      removeProjectFromRegistry(input.id);

      // Remove project folder from disk
      if (summary?.path && existsSync(summary.path)) {
        try {
          rmSync(summary.path, { recursive: true, force: true });
        } catch (err) {
          console.error(
            `[Composer] Failed to delete project folder ${summary.path}:`,
            err,
          );
        }
      }
    },
  );
}
