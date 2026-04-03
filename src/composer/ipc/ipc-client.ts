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
  CreateProjectInput,
  OpenProjectInput,
  RenameProjectInput,
  DeleteProjectInput,
  SaveProjectInput,
  AddTrackInput,
  UpdateTrackInput,
  DeleteTrackInput,
  AddClipInput,
  UpdateClipInput,
  DeleteClipInput,
} from "@/composer/types/ipc";
import type {
  ComposerProject,
  ComposerProjectSummary,
  Track,
  Clip,
} from "@/composer/types/project";

// ─── API accessor ─────────────────────────────────────────────────────────────

function getApi() {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { composerAPI?: { invoke: (channel: string, args?: unknown) => Promise<unknown> } })
    .composerAPI;
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
  list: (): Promise<ComposerProjectSummary[]> =>
    invoke("composer:project-list", undefined as void),

  create: (input: CreateProjectInput): Promise<ComposerProject> =>
    invoke("composer:project-create", input),

  open: (input: OpenProjectInput): Promise<ComposerProject> =>
    invoke("composer:project-open", input),

  close: (id: string): Promise<void> =>
    invoke("composer:project-close", { id }),

  rename: (input: RenameProjectInput): Promise<void> =>
    invoke("composer:project-rename", input),

  delete: (input: DeleteProjectInput): Promise<void> =>
    invoke("composer:project-delete", input),

  save: (input: SaveProjectInput): Promise<void> =>
    invoke("composer:project-save", input),
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
