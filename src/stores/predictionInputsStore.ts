import { create } from "zustand";

const STORAGE_KEY = "wavespeed_prediction_inputs";
const MAX_ENTRIES = 10000; // Keep last 10000 predictions
const ARCHIVE_AGE_DAYS = 7; // Entries older than 7 days are considered archived

interface PredictionInputEntry {
  predictionId: string;
  modelId: string;
  modelName: string;
  inputs: Record<string, unknown>;
  createdAt: string;
}

interface PredictionInputsState {
  entries: Map<string, PredictionInputEntry>;
  isLoaded: boolean;

  load: () => void;
  save: (
    predictionId: string,
    modelId: string,
    modelName: string,
    inputs: Record<string, unknown>,
  ) => void;
  get: (predictionId: string) => PredictionInputEntry | undefined;
  getArchived: () => PredictionInputEntry[];
  clear: () => void;
}

function isArchived(createdAt: string): boolean {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const archiveAge = ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000;
  return now - created > archiveAge;
}

function loadFromStorage(): Map<string, PredictionInputEntry> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const entries = JSON.parse(stored) as PredictionInputEntry[];
      return new Map(entries.map((e) => [e.predictionId, e]));
    }
  } catch (e) {
    console.error("Failed to load prediction inputs:", e);
  }
  return new Map();
}

function saveToStorage(entries: Map<string, PredictionInputEntry>) {
  try {
    const array = Array.from(entries.values())
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .slice(0, MAX_ENTRIES);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(array));
  } catch (e) {
    console.error("Failed to save prediction inputs:", e);
  }
}

export const usePredictionInputsStore = create<PredictionInputsState>(
  (set, get) => ({
    entries: new Map(),
    isLoaded: false,

    load: () => {
      const entries = loadFromStorage();
      set({ entries, isLoaded: true });
    },

    save: (
      predictionId: string,
      modelId: string,
      modelName: string,
      inputs: Record<string, unknown>,
    ) => {
      const entry: PredictionInputEntry = {
        predictionId,
        modelId,
        modelName,
        inputs,
        createdAt: new Date().toISOString(),
      };

      set((state) => {
        const newEntries = new Map(state.entries);
        newEntries.set(predictionId, entry);
        saveToStorage(newEntries);
        return { entries: newEntries };
      });
    },

    get: (predictionId: string) => {
      return get().entries.get(predictionId);
    },

    getArchived: () => {
      const entries = get().entries;
      return Array.from(entries.values())
        .filter((e) => isArchived(e.createdAt))
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
    },

    clear: () => {
      localStorage.removeItem(STORAGE_KEY);
      set({ entries: new Map() });
    },
  }),
);
