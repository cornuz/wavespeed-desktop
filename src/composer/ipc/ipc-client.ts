/**
 * Type-safe IPC client for the Composer renderer process.
 * In Electron: uses window.composerAPI (preload).
 * In browser (npx vite dev mode): falls back to a stub that rejects all calls
 * since Composer requires Electron for file system access.
 *
 * Pattern mirrors src/workflow/ipc/ipc-client.ts.
 */
import type {
  ComposerIpcChannelName,
  ComposerIpcArgs,
  ComposerIpcResult,
  ComposerFfmpegStatus,
  CreateProjectInput,
  OpenProjectInput,
  OpenProjectLocationInput,
  RenameProjectInput,
  DeleteProjectInput,
  SetProjectFavoriteInput,
  DuplicateProjectInput,
  GetSequencePreviewInput,
  InvalidateSequencePreviewInput,
  SaveProjectInput,
  AddTrackInput,
  UpdateTrackInput,
  DeleteTrackInput,
  AddClipInput,
  UpdateClipInput,
  DeleteClipInput,
  ListAssetsInput,
  ImportAssetsInput,
  ImportAssetsByPathsInput,
  DeleteAssetInput,
  ListLutsInput,
  ImportLutsInput,
  ImportLutsByPathsInput,
} from "@/composer/types/ipc";
import type {
  ComposerProject,
  ComposerProjectSummary,
  ComposerAsset,
  ComposerLutAsset,
  ComposerSequencePreview,
  Track,
  Clip,
} from "@/composer/types/project";

// ─── API accessor ─────────────────────────────────────────────────────────────

function getApi() {
  if (typeof window === "undefined") return undefined;
  return (
    window as Window & {
      composerAPI?: {
        invoke: (channel: string, args?: unknown) => Promise<unknown>;
      };
    }
  ).composerAPI;
}

export function invoke<C extends ComposerIpcChannelName>(
  channel: C,
  args: ComposerIpcArgs<C>,
): Promise<ComposerIpcResult<C>> {
  const api = getApi();
  if (!api) {
    return Promise.reject(
      new Error(
        "Composer IPC is only available in the Electron environment. " +
          "Run the app with `npm run dev` (not `npx vite`).",
      ),
    );
  }
  return api.invoke(channel, args) as Promise<ComposerIpcResult<C>>;
}

// ─── Project IPC ─────────────────────────────────────────────────────────────

export const composerProjectIpc = {
  checkFfmpeg: (): Promise<ComposerFfmpegStatus> =>
    invoke("composer:ffmpeg-check", undefined as void),

  list: (): Promise<ComposerProjectSummary[]> =>
    invoke("composer:project-list", undefined as void),

  create: (input: CreateProjectInput): Promise<ComposerProject> =>
    invoke("composer:project-create", input),

  open: (input: OpenProjectInput): Promise<ComposerProject> =>
    invoke("composer:project-open", input),

  openLocation: (input: OpenProjectLocationInput): Promise<void> =>
    invoke("composer:project-open-location", input),

  close: (id: string): Promise<void> =>
    invoke("composer:project-close", { id }),

  rename: (input: RenameProjectInput): Promise<void> =>
    invoke("composer:project-rename", input),

  setFavorite: (
    input: SetProjectFavoriteInput,
  ): Promise<ComposerProjectSummary> =>
    invoke("composer:project-set-favorite", input),

  duplicate: (input: DuplicateProjectInput): Promise<ComposerProjectSummary> =>
    invoke("composer:project-duplicate", input),

  delete: (input: DeleteProjectInput): Promise<void> =>
    invoke("composer:project-delete", input),

  save: (input: SaveProjectInput): Promise<void> =>
    invoke("composer:project-save", input),
};

export const composerSequencePreviewIpc = {
  get: (input: GetSequencePreviewInput): Promise<ComposerSequencePreview> =>
    invoke("composer:sequence-preview-get", input),

  invalidate: (
    input: InvalidateSequencePreviewInput,
  ): Promise<ComposerSequencePreview> =>
    invoke("composer:sequence-preview-invalidate", input),
};

// ─── Track IPC ────────────────────────────────────────────────────────────────

export const composerTrackIpc = {
  add: (input: AddTrackInput): Promise<Track> =>
    invoke("composer:track-add", input),

  update: (input: UpdateTrackInput): Promise<Track> =>
    invoke("composer:track-update", input),

  delete: (input: DeleteTrackInput): Promise<void> =>
    invoke("composer:track-delete", input),
};

// ─── Clip IPC ────────────────────────────────────────────────────────────────

export const composerClipIpc = {
  add: (input: AddClipInput): Promise<Clip> =>
    invoke("composer:clip-add", input),

  update: (input: UpdateClipInput): Promise<Clip> =>
    invoke("composer:clip-update", input),

  delete: (input: DeleteClipInput): Promise<void> =>
    invoke("composer:clip-delete", input),
};

// ─── Asset IPC ───────────────────────────────────────────────────────────────

export const composerAssetIpc = {
  list: (input: ListAssetsInput): Promise<ComposerAsset[]> =>
    invoke("composer:asset-list", input),

  import: (input: ImportAssetsInput): Promise<ComposerAsset[]> =>
    invoke("composer:asset-import", input),

  importFromPaths: (
    input: ImportAssetsByPathsInput,
  ): Promise<ComposerAsset[]> =>
    invoke("composer:asset-import-from-paths", input),

  delete: (input: DeleteAssetInput): Promise<ComposerAsset[]> =>
    invoke("composer:asset-delete", input),
};

export const composerLutIpc = {
  list: (input: ListLutsInput): Promise<ComposerLutAsset[]> =>
    invoke("composer:lut-list", input),

  import: (input: ImportLutsInput): Promise<ComposerLutAsset[]> =>
    invoke("composer:lut-import", input),

  importFromPaths: (
    input: ImportLutsByPathsInput,
  ): Promise<ComposerLutAsset[]> => invoke("composer:lut-import-from-paths", input),
};
