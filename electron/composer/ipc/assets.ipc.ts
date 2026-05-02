import { BrowserWindow, dialog, ipcMain } from "electron";
import { basename, dirname, extname, join } from "path";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "fs";
import type {
  ComposerAsset,
  ComposerAssetImportProgress,
  ComposerAssetImportStage,
  ComposerAssetType,
} from "../../../src/composer/types/project";
import type {
  DeleteAssetInput,
  ImportAssetsByPathsInput,
  ImportAssetsInput,
  ListAssetsInput,
} from "../../../src/composer/types/ipc";
import { loadRegistry } from "../db/project-registry";
import {
  cleanupAssetMetadata,
  deleteAssetMetadata,
  loadAssetMetadata,
  saveAssetMetadata,
  setAssetMetadata,
  type AssetMetadata,
} from "../asset-metadata";
import {
  checkVideoSafety,
  transcodeVideoToSafeFormat,
} from "../video-processor";
import { ensureComposerFfmpegToolsAvailable } from "../ffmpeg";
import { getProjectDatabase } from "../db/connection";

const IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"]);
const AUDIO_EXTS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".aac",
  ".m4a",
  ".wma",
]);
const MEDIA_FILTER_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "svg",
  "mp4",
  "webm",
  "mov",
  "avi",
  "mkv",
  "m4v",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "aac",
  "m4a",
  "wma",
];
const activeCanonicalJobs = new Set<string>();

function getProjectAssetsDir(projectId: string): string {
  const summary = loadRegistry().projects.find(
    (project) => project.id === projectId,
  );
  if (!summary) {
    throw new Error(`Project ${projectId} not found in registry`);
  }
  return join(summary.path, "assets");
}

function detectAssetType(fileName: string): ComposerAssetType | null {
  const ext = extname(fileName).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return null;
}

function isInternalAssetFile(entryName: string): boolean {
  return (
    entryName === ".metadata.json" ||
    /\.working\.[^.]+$/i.test(entryName) ||
    /\.proxy-(high|hi|med|low)\.mp4$/i.test(entryName)
  );
}

function getCanonicalAssetPath(
  assetPath: string,
  workingPath?: string,
): string {
  return workingPath ?? assetPath;
}

function getPreviewProxyPath(
  canonicalPath: string,
  tier: "high" | "med" | "low",
): string {
  const canonicalExtension = extname(canonicalPath);
  const canonicalStem = basename(canonicalPath, canonicalExtension);
  return join(dirname(canonicalPath), `${canonicalStem}.proxy-${tier}.mp4`);
}

function getLegacyPreviewProxyPaths(
  canonicalPath: string,
  tier: "high" | "med" | "low",
): string[] {
  if (tier !== "high") {
    return [];
  }

  const canonicalExtension = extname(canonicalPath);
  const canonicalStem = basename(canonicalPath, canonicalExtension);
  return [join(dirname(canonicalPath), `${canonicalStem}.proxy-hi.mp4`)];
}

function getAllExpectedPreviewProxyPaths(canonicalPath: string): string[] {
  return (["high", "med", "low"] as const).flatMap((tier) => [
    getPreviewProxyPath(canonicalPath, tier),
    ...getLegacyPreviewProxyPaths(canonicalPath, tier),
  ]);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function createImportProgress(
  stage: ComposerAssetImportStage,
  options: {
    stageProgress?: number;
    progress?: number;
    stageLabel?: string;
  } = {},
): ComposerAssetImportProgress {
  const stageProgress = clampPercent(options.stageProgress ?? 0);
  const totalSteps = 2;
  const defaultLabels: Record<ComposerAssetImportStage, string> = {
    discovered: "Media discovered",
    canonical: "Generating canonical media",
    proxy: "Finalizing import",
    complete: "Import complete",
    error: "Import failed",
  };

  let progress = options.progress;
  let currentStep = 1;

  switch (stage) {
    case "discovered":
      progress ??= 5;
      currentStep = 1;
      break;
    case "canonical":
      progress ??= 15 + Math.round(stageProgress * 0.84);
      currentStep = 2;
      break;
    case "proxy":
      progress ??= 95 + Math.round(stageProgress * 0.05);
      currentStep = totalSteps;
      break;
    case "complete":
      progress = 100;
      currentStep = totalSteps;
      break;
    case "error":
      progress ??= 100;
      currentStep = totalSteps;
      break;
  }

  return {
    stage,
    progress: clampPercent(progress),
    stageProgress:
      stage === "complete" || stage === "error" ? 100 : stageProgress,
    currentStep,
    totalSteps,
    stageLabel: options.stageLabel ?? defaultLabels[stage],
    updatedAt: new Date().toISOString(),
  };
}

function createErrorImportProgress(
  metadata: AssetMetadata | undefined,
  stageLabel: string,
): ComposerAssetImportProgress {
  return createImportProgress("error", {
    progress: metadata?.importProgress?.progress ?? 100,
    stageLabel,
  });
}

function deleteFileIfExists(filePath: string): void {
  if (!filePath || !existsSync(filePath)) {
    return;
  }

  try {
    rmSync(filePath, { force: true });
  } catch (error) {
    console.warn(`[Assets] Failed to delete obsolete file ${filePath}:`, error);
  }
}

function cleanupObsoletePreviewProxies(
  assetPath: string,
  assetMetadata: AssetMetadata,
): boolean {
  const canonicalPath = getCanonicalAssetPath(
    assetPath,
    assetMetadata.workingPath,
  );
  let changed = false;
  const previewProxies = assetMetadata.previewProxies;

  for (const tier of ["high", "med", "low"] as const) {
    const currentPath = getPreviewProxyPath(canonicalPath, tier);
    const legacyPaths = getLegacyPreviewProxyPaths(canonicalPath, tier);
    const storedPath = previewProxies?.[tier]?.filePath;
    deleteFileIfExists(currentPath);
    for (const legacyPath of legacyPaths) {
      deleteFileIfExists(legacyPath);
    }
    if (storedPath) {
      deleteFileIfExists(storedPath);
    }
    if (previewProxies?.[tier]) {
      delete previewProxies[tier];
      changed = true;
    }
  }

  if (previewProxies && Object.keys(previewProxies).length === 0) {
    delete assetMetadata.previewProxies;
    changed = true;
  }

  return changed;
}

async function processImportedVideoAsset(
  projectId: string,
  assetsDir: string,
  assetPath: string,
): Promise<void> {
  if (activeCanonicalJobs.has(assetPath)) {
    return;
  }

  activeCanonicalJobs.add(assetPath);

  try {
    setAssetMetadata(assetsDir, assetPath, {
      status: "processing",
      statusMessage: "Analyzing media...",
      importProgress: createImportProgress("discovered"),
    });

    const safety = await checkVideoSafety(assetPath);

    if (safety.status === "error") {
      try {
        unlinkSync(assetPath);
      } catch {
        /* ignore cleanup failure */
      }

      const updated = loadAssetMetadata(assetsDir);
      updated[assetPath] = {
        status: "error",
        statusMessage: safety.message,
        importProgress: createErrorImportProgress(
          updated[assetPath],
          safety.message,
        ),
      };
      saveAssetMetadata(assetsDir, updated);
      return;
    }

    if (safety.status === "needs-transcode") {
      const workingFileName = `${basename(assetPath, extname(assetPath))}.working.mp4`;
      const workingPath = join(assetsDir, workingFileName);

      const metadata = loadAssetMetadata(assetsDir);
      metadata[assetPath] = {
        ...(metadata[assetPath] ?? {}),
        status: "processing",
        statusMessage: "Generating canonical media...",
        hasUnsupportedAudio: safety.hasUnsupportedAudio,
        workingPath,
        importProgress: createImportProgress("canonical", { stageProgress: 0 }),
      };
      saveAssetMetadata(assetsDir, metadata);

      const result = await transcodeVideoToSafeFormat(
        assetPath,
        workingPath,
        {
          includeAudio: !safety.hasUnsupportedAudio,
        },
        ({ progress }) => {
          const updated = loadAssetMetadata(assetsDir);
          const currentMetadata = updated[assetPath];
          if (!currentMetadata) {
            return;
          }

          currentMetadata.status = "processing";
          currentMetadata.statusMessage = "Generating canonical media...";
          currentMetadata.hasUnsupportedAudio = safety.hasUnsupportedAudio;
          currentMetadata.workingPath = workingPath;
          currentMetadata.importProgress = createImportProgress("canonical", {
            stageProgress: progress,
          });
          updated[assetPath] = currentMetadata;
          saveAssetMetadata(assetsDir, updated);
        },
      );

      const updated = loadAssetMetadata(assetsDir);
      const currentMetadata = updated[assetPath] ?? {};

      if (!result) {
        updated[assetPath] = {
          ...currentMetadata,
          status: "error",
          statusMessage: "Failed to generate canonical media",
          hasUnsupportedAudio: safety.hasUnsupportedAudio,
          workingPath,
          importProgress: createErrorImportProgress(
            updated[assetPath],
            "Failed to generate canonical media",
          ),
        };
        saveAssetMetadata(assetsDir, updated);
        return;
      }

      updated[assetPath] = {
        ...currentMetadata,
        status: "ready",
        statusMessage: undefined,
        hasUnsupportedAudio: safety.hasUnsupportedAudio,
        workingPath: result,
        importProgress: createImportProgress("complete"),
      };
      cleanupObsoletePreviewProxies(assetPath, updated[assetPath]);
      saveAssetMetadata(assetsDir, updated);
      return;
    }

    const metadata = loadAssetMetadata(assetsDir);
    metadata[assetPath] = {
      ...(metadata[assetPath] ?? {}),
      status: "ready",
      statusMessage: undefined,
      hasUnsupportedAudio: safety.hasUnsupportedAudio,
      importProgress: createImportProgress("complete"),
    };
    cleanupObsoletePreviewProxies(assetPath, metadata[assetPath]);
    saveAssetMetadata(assetsDir, metadata);
  } catch (error) {
    const updated = loadAssetMetadata(assetsDir);
    updated[assetPath] = {
      ...(updated[assetPath] ?? {}),
      status: "error",
      statusMessage: `Import error: ${(error as Error).message}`,
      importProgress: createErrorImportProgress(
        updated[assetPath],
        `Import error: ${(error as Error).message}`,
      ),
    };
    saveAssetMetadata(assetsDir, updated);
  } finally {
    activeCanonicalJobs.delete(assetPath);
  }
}

function listProjectAssets(projectId: string): ComposerAsset[] {
  const assetsDir = getProjectAssetsDir(projectId);
  if (!existsSync(assetsDir)) {
    mkdirSync(assetsDir, { recursive: true });
    return [];
  }

  cleanupAssetMetadata(assetsDir);

  const metadata = loadAssetMetadata(assetsDir);
  let metadataChanged = false;

  for (const [assetPath, assetMetadata] of Object.entries(metadata)) {
    if (!assetMetadata || !existsSync(assetPath)) {
      continue;
    }

    if (detectAssetType(basename(assetPath)) !== "video") {
      continue;
    }

    if (cleanupObsoletePreviewProxies(assetPath, assetMetadata)) {
      metadataChanged = true;
    }
    if (
      assetMetadata.status === "processing" &&
      assetMetadata.importProgress?.stage === "proxy"
    ) {
      assetMetadata.status = "ready";
      assetMetadata.statusMessage = undefined;
      assetMetadata.importProgress = createImportProgress("complete");
      metadataChanged = true;
    }
  }

  if (metadataChanged) {
    saveAssetMetadata(assetsDir, metadata);
  }

  const assets = readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !isInternalAssetFile(entry.name))
    .map((entry) => {
      const type = detectAssetType(entry.name);
      if (!type) return null;

      const filePath = join(assetsDir, entry.name);
      const stats = statSync(filePath);
      const meta = metadata[filePath];
      return {
        id: filePath,
        fileName: entry.name,
        filePath,
        type,
        fileSize: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        status: meta?.status ?? "ready",
        statusMessage: meta?.statusMessage,
        hasUnsupportedAudio: meta?.hasUnsupportedAudio,
        workingPath: meta?.workingPath,
        importProgress: meta?.importProgress,
        locked: (meta?.status ?? "ready") !== "ready",
      } satisfies ComposerAsset;
    })
    .filter((asset): asset is ComposerAsset => asset !== null)
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));

  return assets;
}

function ensureAssetsDir(projectId: string): string {
  const assetsDir = getProjectAssetsDir(projectId);
  if (!existsSync(assetsDir)) {
    mkdirSync(assetsDir, { recursive: true });
  }
  return assetsDir;
}

async function deleteAssetFile(filePath: string): Promise<void> {
  const MAX_ATTEMPTS = 8;
  const INITIAL_DELAY_MS = 100;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      rmSync(filePath, { force: true });
      return;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      const retryable =
        nodeError.code === "EBUSY" || nodeError.code === "EPERM";

      if (!retryable || attempt === MAX_ATTEMPTS - 1) {
        if (nodeError.code === "EBUSY" || nodeError.code === "EPERM") {
          throw new Error(
            `Asset file is in use or locked (${nodeError.code}). Please ensure the asset is not currently playing or used in clips, then try again.`,
          );
        }
        throw error;
      }

      const delayMs = INITIAL_DELAY_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
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

function collectAssetSidecarPaths(
  assetPath: string,
  metadata: AssetMetadata | undefined,
): string[] {
  const workingPath = metadata?.workingPath;
  const canonicalPath = getCanonicalAssetPath(assetPath, workingPath);
  const sidecarPaths = new Set<string>();

  if (workingPath) {
    sidecarPaths.add(workingPath);
  }

  for (const proxyPath of getAllExpectedPreviewProxyPaths(canonicalPath)) {
    sidecarPaths.add(proxyPath);
  }

  for (const proxyMetadata of Object.values(metadata?.previewProxies ?? {})) {
    const storedPath = proxyMetadata?.filePath;
    if (storedPath) {
      sidecarPaths.add(storedPath);
    }
  }

  return [...sidecarPaths];
}

async function importAssetsFromSourcePaths(
  projectId: string,
  sourcePaths: string[],
): Promise<ComposerAsset[]> {
  if (sourcePaths.length === 0) {
    return listProjectAssets(projectId);
  }

  const hasVideoFiles = sourcePaths.some((filePath) => {
    const fileName = basename(filePath);
    return detectAssetType(fileName) === "video";
  });

  if (hasVideoFiles) {
    await ensureComposerFfmpegToolsAvailable();
  }

  const assetsDir = ensureAssetsDir(projectId);

  for (const sourcePath of sourcePaths) {
    const fileName = basename(sourcePath);
    const type = detectAssetType(fileName);
    if (!type) continue;

    const targetPath = getUniqueTargetPath(assetsDir, fileName);

    try {
      copyFileSync(sourcePath, targetPath);

      if (type === "video") {
        setAssetMetadata(assetsDir, targetPath, {
          status: "processing",
          statusMessage: "Analyzing media...",
          importProgress: createImportProgress("discovered"),
        });

        void processImportedVideoAsset(projectId, assetsDir, targetPath).catch(
          (error) => {
            console.error(
              `[Assets] Failed to process imported video ${targetPath}:`,
              error,
            );
          },
        );
      } else {
        setAssetMetadata(assetsDir, targetPath, {
          status: "ready",
          importProgress: createImportProgress("complete"),
        });
      }
    } catch (error) {
      console.error(`[Assets] Failed to import ${fileName}:`, error);
      setAssetMetadata(assetsDir, targetPath, {
        status: "error",
        statusMessage: `Import error: ${(error as Error).message}`,
        importProgress: createImportProgress("error", {
          stageLabel: `Import error: ${(error as Error).message}`,
        }),
      });
    }
  }

  return listProjectAssets(projectId);
}

export function registerAssetsIpc(): void {
  ipcMain.handle(
    "composer:asset-list",
    async (_event, input: ListAssetsInput): Promise<ComposerAsset[]> => {
      return listProjectAssets(input.projectId);
    },
  );

  ipcMain.handle(
    "composer:asset-import",
    async (_event, input: ImportAssetsInput): Promise<ComposerAsset[]> => {
      const focusedWindow = BrowserWindow.getFocusedWindow();
      if (!focusedWindow) {
        throw new Error("No focused window");
      }

      const result = await dialog.showOpenDialog(focusedWindow, {
        properties: ["openFile", "multiSelections"],
        title: "Import media into Composer",
        filters: [
          {
            name: "Media",
            extensions: MEDIA_FILTER_EXTENSIONS,
          },
        ],
      });

      if (!result.canceled) {
        return importAssetsFromSourcePaths(input.projectId, result.filePaths);
      }

      return listProjectAssets(input.projectId);
    },
  );

  ipcMain.handle(
    "composer:asset-import-from-paths",
    async (
      _event,
      input: ImportAssetsByPathsInput,
    ): Promise<ComposerAsset[]> => {
      return importAssetsFromSourcePaths(input.projectId, input.sourcePaths);
    },
  );

  ipcMain.handle(
    "composer:asset-delete",
    async (_event, input: DeleteAssetInput): Promise<ComposerAsset[]> => {
      const assetsDir = ensureAssetsDir(input.projectId);
      const assetPath = input.assetId;

      if (assetPath.startsWith(assetsDir) && existsSync(assetPath)) {
        const metadata = loadAssetMetadata(assetsDir);
        const sidecarPaths = collectAssetSidecarPaths(
          assetPath,
          metadata[assetPath],
        );

        await deleteAssetFile(assetPath);

        for (const sidecarPath of sidecarPaths) {
          if (existsSync(sidecarPath)) {
            await deleteAssetFile(sidecarPath);
          }
        }

        activeCanonicalJobs.delete(assetPath);

        deleteAssetMetadata(assetsDir, assetPath);
      }

      cleanupAssetMetadata(assetsDir);

      return listProjectAssets(input.projectId);
    },
  );
}
