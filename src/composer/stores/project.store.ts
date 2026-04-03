/**
 * Composer project store — Zustand state for the currently open project.
 * Backed by IPC calls to the Electron main process.
 */
import { create } from "zustand";
import { composerProjectIpc } from "@/composer/ipc/ipc-client";
import type {
  ComposerProject,
  ComposerProjectSummary,
  Track,
  Clip,
} from "@/composer/types/project";

interface ComposerProjectState {
  /** Projects visible in the selector (from composer.json registry) */
  projectList: ComposerProjectSummary[];
  /** Currently open project (null = no project open) */
  currentProject: ComposerProject | null;
  /** Whether an async operation is in progress */
  loading: boolean;
  /** Last error message, or null */
  error: string | null;
}

interface ComposerProjectActions {
  /** Load the project list from the registry */
  loadProjectList: () => Promise<void>;
  /** Create a new project and open it */
  createProject: (name: string) => Promise<ComposerProject>;
  /** Open an existing project by ID */
  openProject: (id: string) => Promise<ComposerProject>;
  /** Close the currently open project */
  closeProject: () => Promise<void>;
  /** Rename a project */
  renameProject: (id: string, name: string) => Promise<void>;
  /** Delete a project (closes it first if open) */
  deleteProject: (id: string) => Promise<void>;
  /** Update tracks on the current project (after IPC mutation) */
  setTracks: (tracks: Track[]) => void;
  /** Update clips on the current project (after IPC mutation) */
  setClips: (clips: Clip[]) => void;
  /** Clear error state */
  clearError: () => void;
}

export type ComposerProjectStore = ComposerProjectState & ComposerProjectActions;

export const useComposerProjectStore = create<ComposerProjectStore>(
  (set, get) => ({
    projectList: [],
    currentProject: null,
    loading: false,
    error: null,

    loadProjectList: async () => {
      set({ loading: true, error: null });
      try {
        const projects = await composerProjectIpc.list();
        set({ projectList: projects, loading: false });
      } catch (err) {
        set({
          loading: false,
          error: (err as Error).message ?? "Failed to load projects",
        });
      }
    },

    createProject: async (name: string) => {
      set({ loading: true, error: null });
      try {
        const project = await composerProjectIpc.create({ name });
        set((state) => ({
          currentProject: project,
          projectList: [
            ...state.projectList.filter((p) => p.id !== project.id),
            {
              id: project.id,
              name: project.name,
              path: project.path,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              lastOpenedAt: project.lastOpenedAt,
            },
          ],
          loading: false,
        }));
        return project;
      } catch (err) {
        set({
          loading: false,
          error: (err as Error).message ?? "Failed to create project",
        });
        throw err;
      }
    },

    openProject: async (id: string) => {
      set({ loading: true, error: null });
      try {
        const project = await composerProjectIpc.open({ id });
        set({ currentProject: project, loading: false });
        return project;
      } catch (err) {
        set({
          loading: false,
          error: (err as Error).message ?? "Failed to open project",
        });
        throw err;
      }
    },

    closeProject: async () => {
      const { currentProject } = get();
      if (!currentProject) return;
      set({ loading: true, error: null });
      try {
        await composerProjectIpc.close(currentProject.id);
        set({ currentProject: null, loading: false });
      } catch (err) {
        set({
          loading: false,
          error: (err as Error).message ?? "Failed to close project",
        });
      }
    },

    renameProject: async (id: string, name: string) => {
      set({ loading: true, error: null });
      try {
        await composerProjectIpc.rename({ id, name });
        set((state) => ({
          loading: false,
          projectList: state.projectList.map((p) =>
            p.id === id ? { ...p, name } : p,
          ),
          currentProject:
            state.currentProject?.id === id
              ? { ...state.currentProject, name }
              : state.currentProject,
        }));
      } catch (err) {
        set({
          loading: false,
          error: (err as Error).message ?? "Failed to rename project",
        });
        throw err;
      }
    },

    deleteProject: async (id: string) => {
      const { currentProject, closeProject } = get();
      if (currentProject?.id === id) {
        await closeProject();
      }
      set({ loading: true, error: null });
      try {
        await composerProjectIpc.delete({ id });
        set((state) => ({
          loading: false,
          projectList: state.projectList.filter((p) => p.id !== id),
        }));
      } catch (err) {
        set({
          loading: false,
          error: (err as Error).message ?? "Failed to delete project",
        });
        throw err;
      }
    },

    setTracks: (tracks: Track[]) => {
      set((state) => ({
        currentProject: state.currentProject
          ? { ...state.currentProject, tracks }
          : null,
      }));
    },

    setClips: (clips: Clip[]) => {
      set((state) => ({
        currentProject: state.currentProject
          ? { ...state.currentProject, clips }
          : null,
      }));
    },

    clearError: () => set({ error: null }),
  }),
);
