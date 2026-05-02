import { BrowserWindow, dialog, ipcMain } from "electron";
import { basename, extname, join, normalize } from "path";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "fs";
import type { ComposerLutAsset } from "../../../src/composer/types/project";
import type {
  ImportLutsByPathsInput,
  ImportLutsInput,
  ListLutsInput,
} from "../../../src/composer/types/ipc";
import { loadRegistry } from "../db/project-registry";

const LUT_EXTS = new Set([".cube", ".3dl", ".csp", ".dat", ".m3d"]);
const LUT_FILTER_EXTENSIONS = ["cube", "3dl", "csp", "dat", "m3d"];

function getProjectLutsDir(projectId: string): string {
  const summary = loadRegistry().projects.find((project) => project.id === projectId);
  if (!summary) {
    throw new Error(`Project ${projectId} not found in registry`);
  }

  return join(summary.path, "assets", "luts");
}

function ensureProjectLutsDir(projectId: string): string {
  const lutDir = getProjectLutsDir(projectId);
  if (!existsSync(lutDir)) {
    mkdirSync(lutDir, { recursive: true });
  }
  return lutDir;
}

function isSupportedLutFile(fileName: string): boolean {
  return LUT_EXTS.has(extname(fileName).toLowerCase());
}

function getUniqueTargetPath(dirPath: string, fileName: string): string {
  const extension = extname(fileName);
  const stem = basename(fileName, extension);
  let candidate = join(dirPath, fileName);
  let suffix = 1;

  while (existsSync(candidate)) {
    candidate = join(dirPath, `${stem}-${suffix}${extension}`);
    suffix += 1;
  }

  return candidate;
}

function listProjectLuts(projectId: string): ComposerLutAsset[] {
  const lutDir = ensureProjectLutsDir(projectId);

  return readdirSync(lutDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSupportedLutFile(entry.name))
    .map((entry) => {
      const filePath = join(lutDir, entry.name);
      const stats = statSync(filePath);
      return {
        id: normalize(entry.name),
        fileName: entry.name,
        filePath,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
      } satisfies ComposerLutAsset;
    })
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

function importLutsFromSourcePaths(
  projectId: string,
  sourcePaths: string[],
): ComposerLutAsset[] {
  const lutDir = ensureProjectLutsDir(projectId);

  for (const sourcePath of sourcePaths) {
    const fileName = basename(sourcePath);
    if (!isSupportedLutFile(fileName)) {
      continue;
    }

    copyFileSync(sourcePath, getUniqueTargetPath(lutDir, fileName));
  }

  return listProjectLuts(projectId);
}

export function registerLutsIpc(): void {
  ipcMain.handle(
    "composer:lut-list",
    async (_event, input: ListLutsInput): Promise<ComposerLutAsset[]> =>
      listProjectLuts(input.projectId),
  );

  ipcMain.handle(
    "composer:lut-import",
    async (_event, input: ImportLutsInput): Promise<ComposerLutAsset[]> => {
      const focusedWindow = BrowserWindow.getFocusedWindow();
      if (!focusedWindow) {
        throw new Error("No focused window");
      }

      const result = await dialog.showOpenDialog(focusedWindow, {
        properties: ["openFile", "multiSelections"],
        title: "Import LUT into Composer project",
        filters: [
          {
            name: "LUT",
            extensions: LUT_FILTER_EXTENSIONS,
          },
        ],
      });

      if (result.canceled) {
        return listProjectLuts(input.projectId);
      }

      return importLutsFromSourcePaths(input.projectId, result.filePaths);
    },
  );

  ipcMain.handle(
    "composer:lut-import-from-paths",
    async (
      _event,
      input: ImportLutsByPathsInput,
    ): Promise<ComposerLutAsset[]> =>
      importLutsFromSourcePaths(input.projectId, input.sourcePaths),
  );
}
