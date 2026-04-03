/**
 * Project IPC handlers for the Composer module.
 * Handles project create, open, close, list, rename, delete, and save.
 */
import { ipcMain, app } from "electron";
import { v4 as uuid } from "uuid";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
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
  updateProjectTimestamps,
} from "../db/project-registry";
import { createDefaultTracks, listTracks } from "../db/tracks.repo";
import { listClips } from "../db/clips.repo";
import type {
  ComposerProject,
  ComposerProjectSummary,
} from "../../../src/composer/types/project";
import type { LayoutPreset, LayoutSizesMap } from "../../../src/composer/types/project";
import type {
  CreateProjectInput,
  OpenProjectInput,
  RenameProjectInput,
  DeleteProjectInput,
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
function getProjectFolderPath(projectName: string): string {
  return join(getAssetsDirectory(), "composer", projectName);
}

/** Reads meta row from an open DB and returns duration + fps + layout. */
function readProjectMeta(
  projectId: string,
): { duration: number; fps: number; projectName: string; layoutPreset: LayoutPreset; layoutSizes: LayoutSizesMap } {
  const db = getProjectDatabase(projectId);
  if (!db) throw new Error(`Project ${projectId} is not open`);
  const result = db.exec(
    `SELECT duration, fps, project_name, layout_preset, layout_sizes FROM meta LIMIT 1`,
  );
  const row = result[0]?.values?.[0];
  if (!row) throw new Error("meta row missing");
  let layoutSizes: LayoutSizesMap = {};
  try {
    layoutSizes = JSON.parse(row[4] as string) as LayoutSizesMap;
  } catch {
    /* keep empty map */
  }
  return {
    duration: row[0] as number,
    fps: row[1] as number,
    projectName: row[2] as string,
    layoutPreset: (row[3] as string || "timeline") as LayoutPreset,
    layoutSizes,
  };
}

/** Assembles a full ComposerProject from an already-open DB. */
function buildProject(
  projectId: string,
  summary: ComposerProjectSummary,
): ComposerProject {
  const { duration, fps, layoutPreset, layoutSizes } = readProjectMeta(projectId);
  const tracks = listTracks(projectId);
  const clips = listClips(projectId);
  return { ...summary, duration, fps, tracks, clips, layoutPreset, layoutSizes };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerProjectIpc(): void {
  // ── List ──────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:project-list",
    async (): Promise<ComposerProjectSummary[]> => {
      return loadRegistry().projects;
    },
  );

  // ── Create ────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:project-create",
    async (_event, input: CreateProjectInput): Promise<ComposerProject> => {
      const name = input.name.trim();
      if (!name) throw new Error("Project name cannot be empty");

      const id = uuid();
      const now = new Date().toISOString();
      const projectFolder = getProjectFolderPath(name);
      const dbPath = join(projectFolder, `${name}.composer`);

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
      };

      addProjectToRegistry(summary);

      return buildProject(id, summary);
    },
  );

  // ── Open ──────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:project-open",
    async (_event, input: OpenProjectInput): Promise<ComposerProject> => {
      const registry = loadRegistry();
      const summary = registry.projects.find((p) => p.id === input.id);
      if (!summary) throw new Error(`Project ${input.id} not found in registry`);

      const dbPath = join(summary.path, `${summary.name}.composer`);
      await openProjectDatabase(input.id, dbPath, summary.name);

      const now = new Date().toISOString();
      updateProjectTimestamps(input.id, { lastOpenedAt: now });
      summary.lastOpenedAt = now;

      return buildProject(input.id, summary);
    },
  );

  // ── Close ─────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:project-close",
    async (_event, { id }: { id: string }): Promise<void> => {
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

  // ── Delete ────────────────────────────────────────────────────────────────
  ipcMain.handle(
    "composer:project-delete",
    async (_event, input: DeleteProjectInput): Promise<void> => {
      // Close DB if open
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
