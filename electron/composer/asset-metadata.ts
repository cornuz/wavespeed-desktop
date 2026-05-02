/**
 * Asset metadata storage: persists status, errors, and processing info for project assets.
 * Stored as JSON file in the project assets folder for simplicity and portability.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  ComposerAssetImportProgress,
  ComposerPreviewProxyRequest,
  ComposerPreviewProxyTier,
} from "../../src/composer/types/project";

export interface AssetPreviewProxyMetadata {
  status: "processing" | "ready" | "error";
  filePath: string;
  request: ComposerPreviewProxyRequest;
  statusMessage?: string;
  updatedAt?: string;
}

export interface AssetMetadata {
  status: "ready" | "processing" | "error";
  statusMessage?: string;
  hasUnsupportedAudio?: boolean;
  workingPath?: string;
  importProgress?: ComposerAssetImportProgress;
  previewProxies?: Partial<Record<ComposerPreviewProxyTier, AssetPreviewProxyMetadata>>;
}

const METADATA_FILE = ".metadata.json";

export interface AssetMetadataStore {
  [assetFilePath: string]: AssetMetadata;
}

function getMetadataFilePath(assetsDir: string): string {
  return join(assetsDir, METADATA_FILE);
}

/**
 * Load asset metadata store for a project.
 * Returns empty object if file doesn't exist.
 */
export function loadAssetMetadata(assetsDir: string): AssetMetadataStore {
  const metadataPath = getMetadataFilePath(assetsDir);
  
  if (!existsSync(metadataPath)) {
    return {};
  }

  try {
    const raw = readFileSync(metadataPath, "utf-8");
    return JSON.parse(raw) as AssetMetadataStore;
  } catch (err) {
    console.warn("[Asset Metadata] Failed to load metadata:", err);
    return {};
  }
}

/**
 * Save asset metadata store for a project.
 */
export function saveAssetMetadata(
  assetsDir: string,
  metadata: AssetMetadataStore,
): void {
  if (!existsSync(assetsDir)) {
    mkdirSync(assetsDir, { recursive: true });
  }

  const metadataPath = getMetadataFilePath(assetsDir);
  try {
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  } catch (err) {
    console.error("[Asset Metadata] Failed to save metadata:", err);
  }
}

/**
 * Get metadata for a specific asset file.
 */
export function getAssetMetadata(
  assetsDir: string,
  filePath: string,
): AssetMetadata | undefined {
  const store = loadAssetMetadata(assetsDir);
  return store[filePath];
}

/**
 * Set or update metadata for a specific asset file.
 */
export function setAssetMetadata(
  assetsDir: string,
  filePath: string,
  metadata: AssetMetadata,
): void {
  const store = loadAssetMetadata(assetsDir);
  store[filePath] = metadata;
  saveAssetMetadata(assetsDir, store);
}

/**
 * Delete metadata for a specific asset file.
 */
export function deleteAssetMetadata(
  assetsDir: string,
  filePath: string,
): void {
  const store = loadAssetMetadata(assetsDir);
  delete store[filePath];
  saveAssetMetadata(assetsDir, store);
}

/**
 * Clean up metadata for files that no longer exist.
 * Called after asset deletion.
 */
export function cleanupAssetMetadata(assetsDir: string): void {
  const store = loadAssetMetadata(assetsDir);
  const toDelete: string[] = [];

  for (const filePath of Object.keys(store)) {
    if (!existsSync(filePath)) {
      toDelete.push(filePath);
    }
  }

  if (toDelete.length > 0) {
    for (const filePath of toDelete) {
      delete store[filePath];
    }
    saveAssetMetadata(assetsDir, store);
  }
}
