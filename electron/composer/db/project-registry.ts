/**
 * Project Registry — manages composer.json in {userData}.
 * This is a flat JSON file listing all known projects (same pattern as
 * assets-metadata.json in the main process).
 */
import { app } from "electron";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type {
  ComposerRegistry,
  ComposerProjectSummary,
  ComposerRegistrySettings,
} from "../../../src/composer/types/project";

// ─── Registry path ────────────────────────────────────────────────────────────

function getRegistryPath(): string {
  return join(app.getPath("userData"), "composer.json");
}

function normalizeProjectSummary(
  summary: ComposerProjectSummary,
): ComposerProjectSummary {
  return {
    ...summary,
    favorite: summary.favorite ?? false,
  };
}

// ─── Default settings ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: ComposerRegistrySettings = {
  defaultFps: 30,
  defaultDuration: 60,
};

// ─── Read / write ─────────────────────────────────────────────────────────────

export function loadRegistry(): ComposerRegistry {
  try {
    const registryPath = getRegistryPath();
    if (existsSync(registryPath)) {
      const raw = readFileSync(registryPath, "utf-8");
      const data = JSON.parse(raw) as Partial<ComposerRegistry>;
      return {
        projects: Array.isArray(data.projects)
          ? data.projects.map((project) =>
              normalizeProjectSummary(project as ComposerProjectSummary),
            )
          : [],
        settings: { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) },
      };
    }
  } catch (err) {
    console.error("[Composer Registry] Failed to load registry:", err);
  }
  return { projects: [], settings: { ...DEFAULT_SETTINGS } };
}

function saveRegistry(registry: ComposerRegistry): void {
  const registryPath = getRegistryPath();
  const dir = dirname(registryPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function addProjectToRegistry(summary: ComposerProjectSummary): void {
  const registry = loadRegistry();
  // Avoid duplicates
  const existing = registry.projects.findIndex((p) => p.id === summary.id);
  if (existing >= 0) {
    registry.projects[existing] = summary;
  } else {
    registry.projects.push(summary);
  }
  saveRegistry(registry);
}

export function removeProjectFromRegistry(projectId: string): void {
  const registry = loadRegistry();
  registry.projects = registry.projects.filter((p) => p.id !== projectId);
  saveRegistry(registry);
}

export function updateProjectTimestamps(
  projectId: string,
  fields: Partial<
    Pick<ComposerProjectSummary, "updatedAt" | "lastOpenedAt" | "name">
  >,
): void {
  const registry = loadRegistry();
  const project = registry.projects.find((p) => p.id === projectId);
  if (!project) return;
  Object.assign(project, fields);
  saveRegistry(registry);
}

export function updateProjectSummary(
  projectId: string,
  patch: Partial<ComposerProjectSummary>,
): ComposerProjectSummary | null {
  const registry = loadRegistry();
  const project = registry.projects.find((entry) => entry.id === projectId);
  if (!project) {
    return null;
  }
  Object.assign(project, patch);
  saveRegistry(registry);
  return project;
}

export function getRegistrySettings(): ComposerRegistrySettings {
  return loadRegistry().settings;
}

export function updateRegistrySettings(
  patch: Partial<ComposerRegistrySettings>,
): void {
  const registry = loadRegistry();
  registry.settings = { ...registry.settings, ...patch };
  saveRegistry(registry);
}
