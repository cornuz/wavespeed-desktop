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
import { listClips, updateClip } from "../db/clips.repo";
import {
  disposeProjectSequencePreview,
  ensureProjectSequencePreview,
  getProjectSequencePreview,
  invalidateProjectSequencePreview,
  scheduleProjectSequencePreviewRefresh,
  renderSequencePreviewForRequest,
  computeProjectTimelineSignature,
  SEQUENCE_PREVIEW_REQUEST_VERSION,
} from "../sequence-preview";
import { renderProjectExport, cancelProjectExportJob } from "../export";
import {
  createHeadlessRenderer,
  destroyHeadlessRenderer,
} from "../headless-renderer";
import type {
  ComposerPlaybackQuality,
  ComposerProject,
  ComposerProjectSummary,
} from "../../../src/composer/types/project";
import type {
  LayoutPreset,
  LayoutSizesMap,
} from "../../../src/composer/types/project";
import {
  DEFAULT_COMPOSER_PROJECT_BACKGROUND_COLOR,
  normalizeComposerProjectBackgroundColor,
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

function getMetaColumns(db: ReturnType<typeof getProjectDatabase>): string[] {
  if (!db) {
    return [];
  }
  const info = db.exec(`PRAGMA table_info(meta)`);
  return (info[0]?.values ?? []).map((row) => String(row[1]));
}

function ensureProjectBackgroundColorColumn(projectId: string): void {
  const db = getProjectDatabase(projectId);
  if (!db) {
    throw new Error(`Project ${projectId} is not open`);
  }
  const columns = getMetaColumns(db);
  if (!columns.includes("background_color")) {
    db.run(`ALTER TABLE meta ADD COLUMN background_color TEXT NOT NULL DEFAULT '#000000'`);
  }
}

/** Reads meta row from an open DB and returns duration + fps + layout. */
function readProjectMeta(projectId: string): {
  duration: number;
  fps: number;
  width: number;
  height: number;
  backgroundColor: string;
  playbackQuality: ComposerPlaybackQuality;
  safeZoneEnabled: boolean;
  safeZoneMargin: number;
  projectName: string;
  layoutPreset: LayoutPreset;
  layoutSizes: LayoutSizesMap;
} {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);
  const metaColumns = getMetaColumns(db);
  const hasBackgroundColor = metaColumns.includes("background_color");
  const result = db.exec(
    hasBackgroundColor
      ? `SELECT duration, fps, width, height, background_color, playback_quality, safe_zone_enabled, safe_zone_margin, project_name, layout_preset, layout_sizes FROM meta LIMIT 1`
      : `SELECT duration, fps, width, height, playback_quality, safe_zone_enabled, safe_zone_margin, project_name, layout_preset, layout_sizes FROM meta LIMIT 1`,
  );
  const row = result[0]?.values?.[0];
  if (!row) throw new Error("meta row missing");
  let layoutSizes: LayoutSizesMap = {};
  const layoutSizesIndex = hasBackgroundColor ? 10 : 9;
  try {
    layoutSizes = JSON.parse(row[layoutSizesIndex] as string) as LayoutSizesMap;
  } catch {
    /* keep empty map */
  }
  return {
    duration: row[0] as number,
    fps: row[1] as number,
    width: row[2] as number,
    height: row[3] as number,
    backgroundColor: normalizeComposerProjectBackgroundColor(
      hasBackgroundColor ? row[4] : DEFAULT_COMPOSER_PROJECT_BACKGROUND_COLOR,
    ),
    playbackQuality: ((row[hasBackgroundColor ? 5 : 4] as string) || "med") as ComposerPlaybackQuality,
    safeZoneEnabled: Boolean(row[hasBackgroundColor ? 6 : 5]),
    safeZoneMargin: row[hasBackgroundColor ? 7 : 6] as number,
    projectName: row[hasBackgroundColor ? 8 : 7] as string,
    layoutPreset: ((row[hasBackgroundColor ? 9 : 8] as string) || "timeline") as LayoutPreset,
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
    backgroundColor,
    playbackQuality,
    safeZoneEnabled,
    safeZoneMargin,
    layoutPreset,
    layoutSizes,
  } = readProjectMeta(projectId);
  const tracks = listTracks(projectId);
  const clips = listClips(projectId);

  // Migrate only clearly legacy projects that still store normalized offsets.
  // Per-clip migration was unsafe because a modern clip centered near (0, 0)
  // could be remigrated on every reopen and jump far out of frame.
  const shouldMigrateLegacyFractionalOffsets =
    clips.length > 0 &&
    clips.every(
      (clip) =>
        Math.abs(clip.transformOffsetX) <= 1 &&
        Math.abs(clip.transformOffsetY) <= 1,
    ) &&
    clips.some(
      (clip) =>
        Math.abs(clip.transformOffsetX) > 0.0001 ||
        Math.abs(clip.transformOffsetY) > 0.0001,
    );

  const migratedClips = shouldMigrateLegacyFractionalOffsets
    ? clips.map((clip) => ({
        ...clip,
        transformOffsetX: clip.transformOffsetX * width,
        transformOffsetY: -clip.transformOffsetY * height,
      }))
    : clips;
  const hasMigrations = migratedClips.some(
    (clip, index) =>
      clip.transformOffsetX !== clips[index].transformOffsetX ||
      clip.transformOffsetY !== clips[index].transformOffsetY,
  );
  if (hasMigrations) {
    for (const clip of migratedClips) {
      updateClip(projectId, clip.id, {
        transformOffsetX: clip.transformOffsetX,
        transformOffsetY: clip.transformOffsetY,
      });
    }
    console.info(
      `[Composer] Migrated clip transforms to universal coordinates for project ${projectId}`,
    );
  }

  return {
    ...summary,
    duration,
    fps,
    width,
    height,
    backgroundColor,
    playbackQuality,
    safeZoneEnabled,
    safeZoneMargin,
    sequencePreview: getProjectSequencePreview(projectId),
    tracks,
    clips: hasMigrations ? migratedClips : clips,
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

  // ── FFmpeg installer download ───────────────────────────────────────────────
  ipcMain.handle(
    "composer:ffmpeg:download-installer",
    async (): Promise<string> => {
      const { downloadFFmpegInstaller } = await import("../ffmpeg");
      return downloadFFmpegInstaller();
    },
  );

  // ── FFmpeg installer launch ─────────────────────────────────────────────────
  ipcMain.handle(
    "composer:ffmpeg:launch-installer",
    async (_event, installerPath: string): Promise<void> => {
      const { launchFFmpegInstaller } = await import("../ffmpeg");
      return launchFFmpegInstaller(installerPath);
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
      await createHeadlessRenderer();
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
      await createHeadlessRenderer();
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
      destroyHeadlessRenderer();
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
      if (input.backgroundColor !== undefined) {
        ensureProjectBackgroundColorColumn(input.id);
        updates.push("background_color = ?");
        values.push(normalizeComposerProjectBackgroundColor(input.backgroundColor));
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
        input.backgroundColor !== undefined ||
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
          ...(input.backgroundColor !== undefined
            ? (["background-color"] as const)
            : []),
          ...(input.width !== undefined || input.height !== undefined
            ? (["dimensions"] as const)
            : []),
        ];
        if (invalidationCauses.length > 0) {
          invalidateProjectSequencePreview(input.id, [...invalidationCauses], {
            fullReset: true,
          });
          void scheduleProjectSequencePreviewRefresh(input.id);
        }
      }
    },
  );

  ipcMain.handle(
    "composer:sequence-preview-get",
    async (_event, input: GetSequencePreviewInput) =>
      ensureProjectSequencePreview(input.projectId),
  );

  ipcMain.handle(
    "composer:sequence-preview-invalidate",
    async (_event, input: InvalidateSequencePreviewInput) => {
      invalidateProjectSequencePreview(input.projectId, input.causes);
      return scheduleProjectSequencePreviewRefresh(input.projectId);
    },
  );

  // ── Export (copy latest ready sequence preview to project exports) ──────
  ipcMain.handle(
    "composer:project-export",
    async (
      _event,
      input: {
        projectId: string;
        fileName?: string | null;
        width?: number | null;
        height?: number | null;
        fps?: number | null;
        playbackQuality?: ComposerPlaybackQuality | null;
      },
    ): Promise<string> => {
      const projectId = input.projectId;
      if (!projectId) throw new Error("projectId is required");

      await ensureComposerFfmpegAvailable();

      const registry = loadRegistry();
      const summary = registry.projects.find((p) => p.id === projectId);
      if (!summary) throw new Error(`Project ${projectId} not found in registry`);

      const exportDir = join(summary.path, "exports");
      if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });

      let fileName = (input.fileName || "").trim();
      if (!fileName) {
        const safeName = summary.name.replace(/[^a-z0-9-_\.]/gi, "_");
        fileName = `${safeName}_export_${Date.now()}.mp4`;
      }
      if (!fileName.toLowerCase().endsWith(".mp4")) fileName += ".mp4";
      // Build a render request from current project meta and any overrides,
      // then run the dedicated export pipeline which is fully decoupled from
      // the preview/cache lifecycle.
      const meta = readProjectMeta(projectId);
      const request = {
        version: SEQUENCE_PREVIEW_REQUEST_VERSION,
        timelineSignature: computeProjectTimelineSignature(
          projectId,
          input.playbackQuality ?? meta.playbackQuality,
        ),
        duration: meta.duration,
        fps: input.fps ?? meta.fps,
        projectWidth: input.width ?? meta.width,
        projectHeight: input.height ?? meta.height,
        playbackQuality: input.playbackQuality ?? meta.playbackQuality,
        backgroundColor: meta.backgroundColor,
      };

      const destPath = join(exportDir, fileName);
      const generatedPath = await renderProjectExport(projectId, request, destPath);
      const now = new Date().toISOString();
      updateProjectTimestamps(projectId, { updatedAt: now });
      return generatedPath;
    },
  );

  // ── Export cancel ───────────────────────────────────────────────────────
  ipcMain.handle("composer:project-export-cancel", async (_event, input: { projectId: string }) => {
    if (!input || !input.projectId) return;
    cancelProjectExportJob(input.projectId);
  });

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
