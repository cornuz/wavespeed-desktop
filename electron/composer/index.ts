/**
 * Composer module entry point — initialises IPC handlers.
 * Called from electron/main.ts during app.whenReady().
 */
import { registerProjectIpc } from "./ipc/project.ipc";
import { registerAssetsIpc } from "./ipc/assets.ipc";
import { registerLutsIpc } from "./ipc/luts.ipc";
import { registerTimelineIpc } from "./ipc/timeline.ipc";
import { closeAllProjectDatabases } from "./db/connection";

export async function initComposerModule(): Promise<void> {
  console.log("[Composer] Initializing Composer module...");

  registerProjectIpc();
  registerAssetsIpc();
  registerLutsIpc();
  registerTimelineIpc();

  console.log("[Composer] Composer module ready.");
}

export function closeComposerDatabases(): void {
  closeAllProjectDatabases();
}
