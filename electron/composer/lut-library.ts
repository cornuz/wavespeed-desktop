import { basename, extname, join, normalize } from "path";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "fs";
import type { ComposerLutAsset } from "../../src/composer/types/project";
import {
  parseCubeLut,
  type ResolvedComposerLut,
} from "../../src/composer/shared/luts";
import { loadRegistry } from "./db/project-registry";

const LUT_EXTS = new Set([".cube"]);

export const LUT_FILTER_EXTENSIONS = ["cube"];

interface CachedResolvedLut {
  cacheKey: string;
  resolved: ResolvedComposerLut;
}

const resolvedLutCache = new Map<string, CachedResolvedLut>();

export function getProjectLutsDir(projectId: string): string {
  const summary = loadRegistry().projects.find((project) => project.id === projectId);
  if (!summary) {
    throw new Error(`Project ${projectId} not found in registry`);
  }

  return join(summary.path, "assets", "luts");
}

export function ensureProjectLutsDir(projectId: string): string {
  const lutDir = getProjectLutsDir(projectId);
  if (!existsSync(lutDir)) {
    mkdirSync(lutDir, { recursive: true });
  }
  return lutDir;
}

export function isSupportedLutFile(fileName: string): boolean {
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

function toComposerLutAsset(filePath: string, fileName: string): ComposerLutAsset {
  const stats = statSync(filePath);
  return {
    id: normalize(fileName),
    fileName,
    filePath,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
  } satisfies ComposerLutAsset;
}

function buildResolvedLutCacheKey(filePath: string): string {
  const stats = statSync(filePath);
  return `${normalize(filePath)}:${stats.size}:${stats.mtimeMs}`;
}

export function listProjectLuts(projectId: string): ComposerLutAsset[] {
  const lutDir = ensureProjectLutsDir(projectId);

  return readdirSync(lutDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSupportedLutFile(entry.name))
    .map((entry) => toComposerLutAsset(join(lutDir, entry.name), entry.name))
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

export function importLutsFromSourcePaths(
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

export function resolveProjectLut(
  projectId: string,
  lutAssetId: string | null,
): ResolvedComposerLut | null {
  if (!lutAssetId) {
    return null;
  }

  const asset = listProjectLuts(projectId).find((entry) => entry.id === normalize(lutAssetId));
  if (!asset) {
    throw new Error(`LUT asset ${lutAssetId} not found in project ${projectId}`);
  }

  const filePath = asset.filePath;
  const cacheKey = buildResolvedLutCacheKey(filePath);
  const cached = resolvedLutCache.get(filePath);
  if (cached?.cacheKey === cacheKey) {
    return cached.resolved;
  }

  const source = readFileSync(filePath, "utf8");
  const stats = statSync(filePath);
  const resolved = {
    assetId: asset.id,
    fileName: asset.fileName,
    filePath,
    fileSize: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    cacheKey,
    lut: parseCubeLut(source, asset.fileName),
  } satisfies ResolvedComposerLut;

  resolvedLutCache.set(filePath, {
    cacheKey,
    resolved,
  });

  return resolved;
}
