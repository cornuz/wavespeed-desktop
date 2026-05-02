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

export type ComposerAssetType = "image" | "video" | "audio";

export type RegionStatus = "pending" | "success" | "error" | "stale";

export type ComposerPlaybackQuality = "full" | "high" | "med" | "low";

// ─── Registry entry (persisted in composer.json) ─────────────────────────────

export interface ComposerProjectSummary {
  id: string;
  name: string;
  /** Absolute path to the project folder (contains the .composer file) */
  path: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  lastOpenedAt: string; // ISO 8601
  favorite?: boolean;
  previewPath?: string | null;
  sizeOnDiskBytes?: number | null;
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
  /** Offset from centered contain-fit placement, normalized by export frame size. */
  transformOffsetX: number;
  transformOffsetY: number;
  /** Scale multiplier over default contain-fit placement. */
  transformScale: number;
  /** Z-axis rotation in degrees. */
  rotationZ: number;
  /** Visual opacity, where 1 is fully opaque. */
  opacity: number;
  /** Fade-in duration in seconds. */
  fadeInDuration: number;
  /** Fade-out duration in seconds. */
  fadeOutDuration: number;
  createdAt: string; // ISO 8601
}

// ─── Project-local asset library ─────────────────────────────────────────────

export type AssetStatus = "ready" | "processing" | "error";

export type ComposerPreviewProxyTier = Exclude<ComposerPlaybackQuality, "full">;

export type ComposerPreviewProxyStatus =
  | "missing"
  | "processing"
  | "ready"
  | "error"
  | "stale";

export type ComposerSequencePreviewStatus =
  | "missing"
  | "processing"
  | "ready"
  | "stale"
  | "error";

export type ComposerSequencePreviewInvalidationCause =
  | "timeline"
  | "dimensions"
  | "playback-quality";

export interface ComposerSequencePreviewRequest {
  version: number;
  timelineSignature: string;
  duration: number;
  fps: number;
  projectWidth: number;
  projectHeight: number;
  playbackQuality: ComposerPlaybackQuality;
}

export interface ComposerSequencePreview {
  status: ComposerSequencePreviewStatus;
  requestSignature: string;
  request: ComposerSequencePreviewRequest;
  filePath: string | null;
  playbackQuality: ComposerPlaybackQuality;
  invalidationReasons: ComposerSequencePreviewInvalidationCause[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  lastRequestedAt?: string;
  startedAt?: string;
  completedAt?: string;
  invalidatedAt?: string;
}

export interface ComposerPreviewProxyRequest {
  version: number;
  projectWidth: number;
  projectHeight: number;
  maxWidth: number;
  maxHeight: number;
}

export interface ComposerPreviewProxyVariant {
  tier: ComposerPreviewProxyTier;
  fileName: string;
  filePath: string;
  status: ComposerPreviewProxyStatus;
  statusMessage?: string;
  request: ComposerPreviewProxyRequest;
  updatedAt?: string;
}

export type ComposerPreviewProxySet = Partial<
  Record<ComposerPreviewProxyTier, ComposerPreviewProxyVariant>
>;

export type ComposerAssetImportStage =
  | "discovered"
  | "canonical"
  | "proxy"
  | "complete"
  | "error";

export interface ComposerAssetImportProgress {
  stage: ComposerAssetImportStage;
  progress: number;
  stageProgress: number;
  currentStep: number;
  totalSteps: number;
  stageLabel: string;
  proxyQuality?: ComposerPlaybackQuality;
  updatedAt?: string;
}

export interface ComposerAsset {
  id: string;
  fileName: string;
  filePath: string;
  type: ComposerAssetType;
  fileSize: number;
  createdAt: string;
  modifiedAt: string;
  /** Status of the asset: "ready" = safe to drag/play, "processing" = being transcoded, "error" = failed */
  status?: AssetStatus;
  /** Error message if status === "error" */
  statusMessage?: string;
  /** For videos: true if audio codec is unsupported but video is usable */
  hasUnsupportedAudio?: boolean;
  /** For videos that were transcoded: path to the working/canonical file */
  workingPath?: string;
  /** Import/pipeline progress for renderer polling. */
  importProgress?: ComposerAssetImportProgress;
  /** Asset remains locked for preview/drag until the full import pipeline completes. */
  locked: boolean;
  /** Preview-only playback proxies for timeline playback. Never use for edit/export/AI. */
  playbackProxies?: ComposerPreviewProxySet;
  /** @deprecated Use playbackProxies. */
  previewProxies?: ComposerPreviewProxySet;
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
  width: number;
  height: number;
  playbackQuality: ComposerPlaybackQuality;
  safeZoneEnabled: boolean;
  safeZoneMargin: number;
  sequencePreview: ComposerSequencePreview;
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
