/**
 * Domain types for the Composer module.
 * These types are shared between the renderer and the Electron main process
 * (via IPC serialisation — keep them serialisation-safe: no Date objects, no class instances).
 */

// ─── Layout ───────────────────────────────────────────────────────────────────

export type LayoutPreset = "timeline" | "assets" | "properties" | "vertical";

/** Sizes for mode=equal (timeline preset). All values are ratios 0–1. */
export interface LayoutSizesEqual {
  /** Timeline height / total editor height below header */
  timelineH: number;
  /** Assets panel width / top-row width */
  assetsW: number;
  /** Properties panel width / top-row width (player fills the remainder) */
  propsW: number;
}

/** Sizes for mode=featured (assets / properties / vertical presets). All values are ratios 0–1. */
export interface LayoutSizesFeatured {
  /** Timeline height / total editor height below header */
  timelineH: number;
  /** Featured column width / total editor width */
  featuredW: number;
  /** Left panel of top-row / top-row width */
  topSplitW: number;
}

export type LayoutSizes = LayoutSizesEqual | LayoutSizesFeatured;

/** Stored per project: only presets whose defaults were overridden are present. */
export type LayoutSizesMap = Partial<Record<LayoutPreset, LayoutSizes>>;

// ─── Primitives ──────────────────────────────────────────────────────────────

export type TrackType = "video" | "audio";

export type SourceType = "asset" | "import" | "ai-result" | "workflow-ref";

export type RegionStatus = "pending" | "success" | "error" | "stale";

// ─── Registry entry (persisted in composer.json) ─────────────────────────────

export interface ComposerProjectSummary {
  id: string;
  name: string;
  /** Absolute path to the project folder (contains the .composer file) */
  path: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  lastOpenedAt: string; // ISO 8601
}

// ─── Track ───────────────────────────────────────────────────────────────────

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  /** Display order, 0-indexed */
  order: number;
  muted: boolean;
  locked: boolean;
  visible: boolean;
  /** True when at least one Workflow region has been added to this track */
  isComposite: boolean;
}

// ─── Clip ────────────────────────────────────────────────────────────────────

export interface Clip {
  id: string;
  trackId: string;
  sourceType: SourceType;
  /** Absolute path to the media file */
  sourcePath: string | null;
  /** Optional reference to an Assets entry */
  sourceAssetId: string | null;
  /** Position on the timeline in seconds */
  startTime: number;
  /** Duration as displayed on the timeline (seconds) */
  duration: number;
  /** Trim from the beginning of the source media (seconds) */
  trimStart: number;
  /** Trim from the end of the source media (seconds). null = no trim. */
  trimEnd: number | null;
  /** Playback speed multiplier */
  speed: number;
  createdAt: string; // ISO 8601
}

// ─── Region (L3 — Workflow integration) ──────────────────────────────────────

export interface Region {
  id: string;
  trackId: string;
  startTime: number;
  endTime: number;
  workflowId: string | null;
  executionId: string | null;
  resultPath: string | null;
  status: RegionStatus;
  createdAt: string;
  updatedAt: string;
}

// ─── Full project (loaded from .composer DB) ─────────────────────────────────

export interface ComposerProject extends ComposerProjectSummary {
  /** Duration in seconds */
  duration: number;
  fps: number;
  tracks: Track[];
  clips: Clip[];
  layoutPreset: LayoutPreset;
  layoutSizes: LayoutSizesMap;
}

// ─── Registry (composer.json) ────────────────────────────────────────────────

export interface ComposerRegistrySettings {
  defaultFps: number;
  defaultDuration: number;
}

export interface ComposerRegistry {
  projects: ComposerProjectSummary[];
  settings: ComposerRegistrySettings;
}
