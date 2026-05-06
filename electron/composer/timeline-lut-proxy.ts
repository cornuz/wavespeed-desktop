import { createHash } from "crypto";
import { nativeImage } from "electron";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, extname, join } from "path";
import { applyCubeLutToRgbaBuffer } from "../../src/composer/shared/luts";
import type { Clip } from "../../src/composer/types/project";
import { loadAssetMetadata } from "./asset-metadata";
import {
  createDerivedMedia,
  getDerivedMediaByCacheKey,
  updateDerivedMedia,
} from "./db/derived-media.repo";
import { loadRegistry } from "./db/project-registry";
import { resolveProjectLut } from "./lut-library";
import { transcodeVideoToLutProxy } from "./video-processor";

const STILL_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"]);
const INSTANCE_LUT_PROXY_DIR = "instance-lut";
const LEGACY_TIMELINE_LUT_PROXY_DIR = "timeline-lut";
const activeLutDerivedJobs = new Map<string, Promise<TimelineLutProxyResolution>>();

export interface TimelineLutProxyResolution {
  derivedMediaId: string | null;
  path: string | null;
  status: "processing" | "ready" | "error" | null;
  operationLabel: string | null;
}

function getProjectSummary(projectId: string) {
  const summary = loadRegistry().projects.find((project) => project.id === projectId);
  if (!summary) {
    throw new Error(`Project ${projectId} not found in registry`);
  }
  return summary;
}

function getProjectCacheDir(projectId: string): string {
  return join(getProjectSummary(projectId).path, "cache");
}

function getProjectAssetsDir(projectId: string): string {
  return join(getProjectSummary(projectId).path, "assets");
}

function getTimelineLutProxyDir(projectId: string): string {
  const directory = join(getProjectCacheDir(projectId), INSTANCE_LUT_PROXY_DIR);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  return directory;
}

function getLegacyTimelineLutProxyDir(projectId: string): string {
  return join(getProjectCacheDir(projectId), LEGACY_TIMELINE_LUT_PROXY_DIR);
}

function canUseTimelineLutProxy(clip: Clip): clip is Clip & { sourcePath: string } {
  const extension = typeof clip.sourcePath === "string" ? extname(clip.sourcePath).toLowerCase() : "";
  return (
    typeof clip.sourcePath === "string" &&
    clip.sourcePath.length > 0 &&
    typeof clip.adjustments?.lutAssetId === "string" &&
    clip.adjustments.lutAssetId.length > 0 &&
    (STILL_EXTS.has(extension) || VIDEO_EXTS.has(extension))
  );
}

function isVideoProxySource(filePath: string): boolean {
  return VIDEO_EXTS.has(extname(filePath).toLowerCase());
}

function getSourceSignature(sourcePath: string): string {
  const sourceStat = statSync(sourcePath);
  return `${sourceStat.size}:${sourceStat.mtimeMs}`;
}

function getTimelineLutProxyKey(input: {
  upstreamAssetId: string;
  sourcePath: string;
  dependencyAssetId: string;
  lutCacheKey: string;
}): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        upstreamAssetId: input.upstreamAssetId,
        parentDerivedMediaId: null,
        operationType: "applied-lut",
        dependencyAssetId: input.dependencyAssetId,
        lutCacheKey: input.lutCacheKey,
        sourcePath: input.sourcePath,
        sourceSignature: getSourceSignature(input.sourcePath),
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function getTimelineLutProxyPath(
  projectId: string,
  sourcePath: string,
  proxyKey: string,
): string {
  const extension = isVideoProxySource(sourcePath) ? ".mp4" : ".png";
  const stem = basename(sourcePath, extname(sourcePath)).replace(/[^a-z0-9._-]+/gi, "_");
  return join(getTimelineLutProxyDir(projectId), `${stem}-${proxyKey}${extension}`);
}

function cleanupLegacyTimelineLutProxyFiles(projectId: string, clipId: string): void {
  const directories = [
    getTimelineLutProxyDir(projectId),
    getLegacyTimelineLutProxyDir(projectId),
  ];

  for (const directory of directories) {
    if (!existsSync(directory)) {
      continue;
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(`${clipId}-`)) {
        continue;
      }
      try {
        rmSync(join(directory, entry.name), { force: true });
      } catch (error) {
        console.warn(`[Composer] Failed to delete legacy LUT proxy ${entry.name}:`, error);
      }
    }
  }
}

function convertBgraToRgba(bitmap: Buffer): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(bitmap.length);
  for (let index = 0; index <= bitmap.length - 4; index += 4) {
    rgba[index] = bitmap[index + 2];
    rgba[index + 1] = bitmap[index + 1];
    rgba[index + 2] = bitmap[index];
    rgba[index + 3] = bitmap[index + 3];
  }
  return rgba;
}

function convertRgbaToBgra(rgba: Uint8ClampedArray): Buffer {
  const bitmap = Buffer.alloc(rgba.length);
  for (let index = 0; index <= rgba.length - 4; index += 4) {
    bitmap[index] = rgba[index + 2];
    bitmap[index + 1] = rgba[index + 1];
    bitmap[index + 2] = rgba[index];
    bitmap[index + 3] = rgba[index + 3];
  }
  return bitmap;
}

function toResolution(result: {
  derivedMediaId: string;
  status: "processing" | "ready" | "error";
  path: string | null;
  operationLabel: string;
}): TimelineLutProxyResolution {
  return {
    derivedMediaId: result.derivedMediaId,
    status: result.status,
    path: result.path,
    operationLabel: result.operationLabel,
  };
}

export async function ensureTimelineLutProxy(
  projectId: string,
  clip: Clip,
): Promise<TimelineLutProxyResolution> {
  cleanupLegacyTimelineLutProxyFiles(projectId, clip.id);

  if (!canUseTimelineLutProxy(clip)) {
    return {
      derivedMediaId: null,
      path: null,
      status: null,
      operationLabel: null,
    };
  }

  const assetsMetadata = loadAssetMetadata(getProjectAssetsDir(projectId));
  const metadata = assetsMetadata[clip.sourcePath];
  const canonicalSourcePath =
    typeof metadata?.workingPath === "string" && existsSync(metadata.workingPath)
      ? metadata.workingPath
      : clip.sourcePath;
  const resolvedLut = resolveProjectLut(projectId, clip.adjustments.lutAssetId);
  if (!resolvedLut) {
    return {
      derivedMediaId: null,
      path: null,
      status: null,
      operationLabel: null,
    };
  }

  const upstreamAssetId = clip.sourceAssetId ?? clip.sourcePath ?? canonicalSourcePath;
  const proxyKey = getTimelineLutProxyKey({
    upstreamAssetId,
    sourcePath: canonicalSourcePath,
    dependencyAssetId: resolvedLut.assetId,
    lutCacheKey: resolvedLut.cacheKey,
  });
  const proxyPath = getTimelineLutProxyPath(projectId, canonicalSourcePath, proxyKey);
  const operationLabel = `applied LUT ${resolvedLut.fileName}`;
  const specJson = JSON.stringify({
    lutAssetId: resolvedLut.assetId,
    lutCacheKey: resolvedLut.cacheKey,
    sourcePath: canonicalSourcePath,
    sourceSignature: getSourceSignature(canonicalSourcePath),
  });

  let derivedMedia = getDerivedMediaByCacheKey(projectId, proxyKey);
  if (!derivedMedia) {
    derivedMedia = createDerivedMedia(projectId, {
      upstreamAssetId,
      parentDerivedMediaId: null,
      dependencyAssetId: resolvedLut.assetId,
      operationType: "applied-lut",
      operationLabel,
      specJson,
      cacheKey: proxyKey,
      outputPath: proxyPath,
      status: "processing",
      errorMessage: null,
    });
  }

  if (
    derivedMedia.status === "ready" &&
    derivedMedia.outputPath &&
    existsSync(derivedMedia.outputPath)
  ) {
    return toResolution({
      derivedMediaId: derivedMedia.id,
      status: "ready",
      path: derivedMedia.outputPath,
      operationLabel: derivedMedia.operationLabel,
    });
  }

  const activeJob = activeLutDerivedJobs.get(proxyKey);
  if (activeJob) {
    return activeJob;
  }

  const job = (async (): Promise<TimelineLutProxyResolution> => {
    try {
      derivedMedia = updateDerivedMedia(projectId, derivedMedia.id, {
        operationLabel,
        specJson,
        outputPath: proxyPath,
        status: "processing",
        errorMessage: null,
      });

      if (isVideoProxySource(canonicalSourcePath)) {
        const result = await transcodeVideoToLutProxy(
          canonicalSourcePath,
          resolvedLut.filePath,
          proxyPath,
        );
        if (!result) {
          throw new Error("Failed to generate LUT video proxy.");
        }
      } else {
        const baseImage = nativeImage.createFromPath(canonicalSourcePath);
        if (baseImage.isEmpty()) {
          throw new Error(`Failed to load LUT proxy source: ${canonicalSourcePath}`);
        }

        const { width, height } = baseImage.getSize();
        if (width <= 0 || height <= 0) {
          throw new Error(`Invalid LUT proxy size for ${canonicalSourcePath}`);
        }

        const rgba = convertBgraToRgba(baseImage.toBitmap());
        applyCubeLutToRgbaBuffer(resolvedLut.lut, rgba);
        const encoded = nativeImage.createFromBitmap(convertRgbaToBgra(rgba), {
          width,
          height,
          scaleFactor: 1,
        });
        writeFileSync(proxyPath, encoded.toPNG());
      }

      derivedMedia = updateDerivedMedia(projectId, derivedMedia.id, {
        outputPath: proxyPath,
        status: "ready",
        errorMessage: null,
      });
      return toResolution({
        derivedMediaId: derivedMedia.id,
        status: "ready",
        path: derivedMedia.outputPath ?? proxyPath,
        operationLabel: derivedMedia.operationLabel,
      });
    } catch (error) {
      derivedMedia = updateDerivedMedia(projectId, derivedMedia.id, {
        outputPath: proxyPath,
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return toResolution({
        derivedMediaId: derivedMedia.id,
        status: "error",
        path: null,
        operationLabel: derivedMedia.operationLabel,
      });
    } finally {
      activeLutDerivedJobs.delete(proxyKey);
    }
  })();

  activeLutDerivedJobs.set(proxyKey, job);
  return job;
}

export function clearTimelineLutProxy(projectId: string, clipId: string): void {
  cleanupLegacyTimelineLutProxyFiles(projectId, clipId);
}
