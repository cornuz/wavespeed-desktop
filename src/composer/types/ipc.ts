/**
 * IPC channel definitions for the Composer module.
 * Pattern mirrors src/workflow/types/ipc.ts.
 */
import type {
  ComposerProject,
  ComposerProjectSummary,
  ComposerAsset,
  ComposerLutAsset,
  ComposerSequencePreview,
  ComposerSequencePreviewInvalidationCause,
  Track,
  Clip,
  ClipAdjustmentsPatch,
  TrackType,
  SourceType,
  LayoutPreset,
  LayoutSizesMap,
  ComposerPlaybackQuality,
} from "./project";

// ─── Input / result shapes ────────────────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
}

export interface OpenProjectInput {
  id: string;
}

export interface OpenProjectLocationInput {
  id: string;
}

export interface RenameProjectInput {
  id: string;
  name: string;
}

export interface DeleteProjectInput {
  id: string;
}

export interface SetProjectFavoriteInput {
  id: string;
  favorite: boolean;
}

export interface DuplicateProjectInput {
  id: string;
}

export interface SaveProjectInput {
  id: string;
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  playbackQuality?: ComposerPlaybackQuality;
  safeZoneEnabled?: boolean;
  safeZoneMargin?: number;
  layoutPreset?: LayoutPreset;
  layoutSizes?: LayoutSizesMap;
}

export interface GetSequencePreviewInput {
  projectId: string;
}

export interface InvalidateSequencePreviewInput {
  projectId: string;
  causes: ComposerSequencePreviewInvalidationCause[];
}

export interface ComposerFfmpegStatus {
  available: boolean;
  blockedReason: string | null;
}

// ─── Track inputs ─────────────────────────────────────────────────────────────

export interface AddTrackInput {
  projectId: string;
  name: string;
  type: TrackType;
}

export interface UpdateTrackInput {
  projectId: string;
  trackId: string;
  name?: string;
  muted?: boolean;
  locked?: boolean;
  visible?: boolean;
  order?: number;
}

export interface DeleteTrackInput {
  projectId: string;
  trackId: string;
}

// ─── Clip inputs ──────────────────────────────────────────────────────────────

export interface AddClipInput {
  projectId: string;
  id?: string;
  trackId: string;
  sourceType: SourceType;
  sourcePath: string | null;
  sourceAssetId: string | null;
  startTime: number;
  duration: number;
  trimStart?: number;
  trimEnd?: number | null;
  speed?: number;
  transformOffsetX?: number;
  transformOffsetY?: number;
  transformScale?: number;
  rotationZ?: number;
  opacity?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  adjustments?: ClipAdjustmentsPatch;
  fadeInDuration?: number;
  fadeOutDuration?: number;
  createdAt?: string;
}

export interface UpdateClipInput {
  projectId: string;
  clipId: string;
  startTime?: number;
  duration?: number;
  trimStart?: number;
  trimEnd?: number | null;
  speed?: number;
  trackId?: string;
  transformOffsetX?: number;
  transformOffsetY?: number;
  transformScale?: number;
  rotationZ?: number;
  opacity?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  adjustments?: ClipAdjustmentsPatch;
  fadeInDuration?: number;
  fadeOutDuration?: number;
}

export interface DeleteClipInput {
  projectId: string;
  clipId: string;
}

// ─── Asset inputs ─────────────────────────────────────────────────────────────

export interface ListAssetsInput {
  projectId: string;
}

export interface ImportAssetsInput {
  projectId: string;
}

export interface ImportAssetsByPathsInput {
  projectId: string;
  sourcePaths: string[];
}

export interface DeleteAssetInput {
  projectId: string;
  assetId: string;
}

export interface ListLutsInput {
  projectId: string;
}

export interface ImportLutsInput {
  projectId: string;
}

export interface ImportLutsByPathsInput {
  projectId: string;
  sourcePaths: string[];
}

// ─── Channel map ─────────────────────────────────────────────────────────────

export type ComposerIpcChannels = {
  // Project CRUD
  "composer:ffmpeg-check": {
    args: void;
    result: ComposerFfmpegStatus;
  };
  "composer:project-create": {
    args: CreateProjectInput;
    result: ComposerProject;
  };
  "composer:project-open": {
    args: OpenProjectInput;
    result: ComposerProject;
  };
  "composer:project-open-location": {
    args: OpenProjectLocationInput;
    result: void;
  };
  "composer:project-close": {
    args: { id: string };
    result: void;
  };
  "composer:project-list": {
    args: void;
    result: ComposerProjectSummary[];
  };
  "composer:project-rename": {
    args: RenameProjectInput;
    result: void;
  };
  "composer:project-set-favorite": {
    args: SetProjectFavoriteInput;
    result: ComposerProjectSummary;
  };
  "composer:project-duplicate": {
    args: DuplicateProjectInput;
    result: ComposerProjectSummary;
  };
  "composer:project-delete": {
    args: DeleteProjectInput;
    result: void;
  };
  "composer:project-save": {
    args: SaveProjectInput;
    result: void;
  };
  "composer:sequence-preview-get": {
    args: GetSequencePreviewInput;
    result: ComposerSequencePreview;
  };
  "composer:sequence-preview-invalidate": {
    args: InvalidateSequencePreviewInput;
    result: ComposerSequencePreview;
  };

  // Track CRUD
  "composer:track-add": {
    args: AddTrackInput;
    result: Track;
  };
  "composer:track-update": {
    args: UpdateTrackInput;
    result: Track;
  };
  "composer:track-delete": {
    args: DeleteTrackInput;
    result: void;
  };

  // Clip CRUD
  "composer:clip-add": {
    args: AddClipInput;
    result: Clip;
  };
  "composer:clip-update": {
    args: UpdateClipInput;
    result: Clip;
  };
  "composer:clip-delete": {
    args: DeleteClipInput;
    result: void;
  };

  // Project-local assets
  "composer:asset-list": {
    args: ListAssetsInput;
    result: ComposerAsset[];
  };
  "composer:asset-import": {
    args: ImportAssetsInput;
    result: ComposerAsset[];
  };
  "composer:asset-import-from-paths": {
    args: ImportAssetsByPathsInput;
    result: ComposerAsset[];
  };
  "composer:asset-delete": {
    args: DeleteAssetInput;
    result: ComposerAsset[];
  };
  "composer:lut-list": {
    args: ListLutsInput;
    result: ComposerLutAsset[];
  };
  "composer:lut-import": {
    args: ImportLutsInput;
    result: ComposerLutAsset[];
  };
  "composer:lut-import-from-paths": {
    args: ImportLutsByPathsInput;
    result: ComposerLutAsset[];
  };
};

// ─── Helpers (mirror workflow IPC pattern) ────────────────────────────────────

export type ComposerIpcChannelName = keyof ComposerIpcChannels;

export type ComposerIpcArgs<C extends ComposerIpcChannelName> =
  ComposerIpcChannels[C]["args"];

export type ComposerIpcResult<C extends ComposerIpcChannelName> =
  ComposerIpcChannels[C]["result"];
