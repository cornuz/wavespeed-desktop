/**
 * IPC channel definitions for the Composer module.
 * Pattern mirrors src/workflow/types/ipc.ts.
 */
import type {
  ComposerProject,
  ComposerProjectSummary,
  Track,
  Clip,
  TrackType,
  SourceType,
  LayoutPreset,
  LayoutSizesMap,
} from "./project";

// ─── Input / result shapes ────────────────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
}

export interface OpenProjectInput {
  id: string;
}

export interface RenameProjectInput {
  id: string;
  name: string;
}

export interface DeleteProjectInput {
  id: string;
}

export interface SaveProjectInput {
  id: string;
  duration?: number;
  fps?: number;
  layoutPreset?: LayoutPreset;
  layoutSizes?: LayoutSizesMap;
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
  trackId: string;
  sourceType: SourceType;
  sourcePath: string | null;
  sourceAssetId: string | null;
  startTime: number;
  duration: number;
  trimStart?: number;
  trimEnd?: number | null;
  speed?: number;
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
}

export interface DeleteClipInput {
  projectId: string;
  clipId: string;
}

// ─── Channel map ─────────────────────────────────────────────────────────────

export type ComposerIpcChannels = {
  // Project CRUD
  "composer:project-create": {
    args: CreateProjectInput;
    result: ComposerProject;
  };
  "composer:project-open": {
    args: OpenProjectInput;
    result: ComposerProject;
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
  "composer:project-delete": {
    args: DeleteProjectInput;
    result: void;
  };
  "composer:project-save": {
    args: SaveProjectInput;
    result: void;
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
};

// ─── Helpers (mirror workflow IPC pattern) ────────────────────────────────────

export type ComposerIpcChannelName = keyof ComposerIpcChannels;

export type ComposerIpcArgs<C extends ComposerIpcChannelName> =
  ComposerIpcChannels[C]["args"];

export type ComposerIpcResult<C extends ComposerIpcChannelName> =
  ComposerIpcChannels[C]["result"];
