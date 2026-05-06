import { BrowserWindow, dialog, ipcMain } from "electron";
import type { ResolvedComposerLut } from "../../../src/composer/shared/luts";
import type {
  ImportLutsByPathsInput,
  ImportLutsInput,
  ListLutsInput,
  ResolveLutInput,
} from "../../../src/composer/types/ipc";
import type { ComposerLutAsset } from "../../../src/composer/types/project";
import {
  LUT_FILTER_EXTENSIONS,
  importLutsFromSourcePaths,
  listProjectLuts,
  resolveProjectLut,
} from "../lut-library";

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

  ipcMain.handle(
    "composer:lut-resolve",
    async (
      _event,
      input: ResolveLutInput,
    ): Promise<ResolvedComposerLut | null> =>
      resolveProjectLut(input.projectId, input.lutAssetId),
  );
}
