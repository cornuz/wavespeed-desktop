import { spawn } from "child_process";
import { createHash } from "crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import type {
  CachedSegment,
  SegmentManifest,
} from "./sequence-preview-contract";
import { loadRegistry } from "./db/project-registry";
import { getFfmpegBinaryPath } from "./ffmpeg";

const SEGMENT_CACHE_SUBDIR = "seqseg";
const SEGMENT_MANIFEST_FILE = "manifest.json";
const SEGMENT_DURATION_SECONDS = 5;

interface BlankSegmentOptions {
  duration: number;
  outputWidth: number;
  outputHeight: number;
  fps: number;
  backgroundColor: string;
}

function getProjectPath(projectId: string): string {
  const project = loadRegistry().projects.find(
    (entry) => entry.id === projectId,
  );
  if (!project) {
    throw new Error(`Project ${projectId} not found in registry`);
  }
  return project.path;
}

function ensureDir(dirPath: string): string {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function formatSegmentNumber(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function buildSegmentId(startTime: number, endTime: number): string {
  return createHash("sha1")
    .update(`${formatSegmentNumber(startTime)}:${formatSegmentNumber(endTime)}`)
    .digest("hex")
    .slice(0, 12);
}

function buildSegmentFileName(segment: CachedSegment): string {
  return `segment-${segment.index.toString().padStart(4, "0")}-${segment.id}.mp4`;
}

function getManifestPath(projectId: string): string {
  return join(getSegmentCacheDir(projectId), SEGMENT_MANIFEST_FILE);
}

export function getSegmentCacheDir(projectId: string): string {
  return ensureDir(
    join(getProjectPath(projectId), "cache", SEGMENT_CACHE_SUBDIR),
  );
}

export function createInitialManifest(
  duration: number,
  outputWidth: number,
  outputHeight: number,
  fps: number,
  requestSignature: string,
): SegmentManifest {
  const normalizedDuration = Math.max(0.04, duration);
  const segments: CachedSegment[] = [];
  let startTime = 0;
  let index = 0;

  while (startTime < normalizedDuration || segments.length === 0) {
    const endTime = Math.min(
      normalizedDuration,
      startTime + SEGMENT_DURATION_SECONDS,
    );
    segments.push({
      id: buildSegmentId(startTime, endTime),
      index,
      startTime,
      endTime,
      file: null,
      dirty: true,
    });
    index += 1;
    startTime = endTime;
    if (endTime >= normalizedDuration) {
      break;
    }
  }

  return {
    requestSignature,
    duration: normalizedDuration,
    outputWidth,
    outputHeight,
    fps,
    segments,
  };
}

export function loadSegmentManifest(projectId: string): SegmentManifest | null {
  const manifestPath = getManifestPath(projectId);
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    ) as SegmentManifest;
    if (!Array.isArray(parsed.segments)) {
      return null;
    }
    return {
      requestSignature: parsed.requestSignature ?? "",
      duration: Number(parsed.duration) || 0,
      outputWidth: Number(parsed.outputWidth) || 0,
      outputHeight: Number(parsed.outputHeight) || 0,
      fps: Number(parsed.fps) || 0,
      segments: parsed.segments.map((segment, index) => ({
        id:
          typeof segment.id === "string" && segment.id.length > 0
            ? segment.id
            : buildSegmentId(segment.startTime, segment.endTime),
        index,
        startTime: Number(segment.startTime) || 0,
        endTime: Number(segment.endTime) || 0,
        file:
          typeof segment.file === "string" && segment.file.length > 0
            ? segment.file
            : null,
        dirty: Boolean(segment.dirty),
      })),
    };
  } catch {
    return null;
  }
}

export function saveSegmentManifest(
  projectId: string,
  manifest: SegmentManifest,
): SegmentManifest {
  writeFileSync(
    getManifestPath(projectId),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
  return manifest;
}

export function isManifestReusable(
  manifest: SegmentManifest | null,
  next: Pick<
    SegmentManifest,
    "duration" | "outputWidth" | "outputHeight" | "fps"
  >,
): boolean {
  if (!manifest) {
    return false;
  }

  return (
    Math.abs(manifest.duration - next.duration) < 0.001 &&
    manifest.outputWidth === next.outputWidth &&
    manifest.outputHeight === next.outputHeight &&
    manifest.fps === next.fps
  );
}

export function markDirty(
  manifest: SegmentManifest,
  startTime: number,
  endTime: number,
): SegmentManifest {
  const normalizedStart = Math.max(0, Math.min(startTime, endTime));
  const normalizedEnd = Math.min(
    manifest.duration,
    Math.max(normalizedStart, Math.max(startTime, endTime)),
  );

  return {
    ...manifest,
    segments: manifest.segments.map((segment) => {
      const overlaps =
        segment.startTime < normalizedEnd && segment.endTime > normalizedStart;
      return overlaps ? { ...segment, dirty: true } : segment;
    }),
  };
}

export function markAllDirty(manifest: SegmentManifest): SegmentManifest {
  return {
    ...manifest,
    segments: manifest.segments.map((segment) => ({ ...segment, dirty: true })),
  };
}

export function getNextDirtySegment(
  manifest: SegmentManifest,
): CachedSegment | null {
  return manifest.segments.find((segment) => segment.dirty) ?? null;
}

export function markRendered(
  manifest: SegmentManifest,
  segmentId: string,
  file: string,
): SegmentManifest {
  return {
    ...manifest,
    segments: manifest.segments.map((segment) =>
      segment.id === segmentId ? { ...segment, file, dirty: false } : segment,
    ),
  };
}

export function buildConcatList(manifest: SegmentManifest): string[] {
  return manifest.segments
    .sort((left, right) => left.index - right.index)
    .map((segment) => segment.file)
    .filter((filePath): filePath is string => typeof filePath === "string");
}

export function computeOverallProgress(
  manifest: SegmentManifest,
  activeSegmentId?: string,
  activeSegmentPercent?: number,
): number {
  if (manifest.duration <= 0) {
    return 100;
  }

  const completedDuration = manifest.segments.reduce((total, segment) => {
    const duration = Math.max(0, segment.endTime - segment.startTime);
    if (!segment.dirty && segment.file) {
      return total + duration;
    }
    if (segment.id === activeSegmentId && activeSegmentPercent != null) {
      return (
        total +
        (duration * Math.min(Math.max(activeSegmentPercent, 0), 100)) / 100
      );
    }
    return total;
  }, 0);

  return Math.min(
    100,
    Math.max(0, (completedDuration / manifest.duration) * 100),
  );
}

export function writeSegment(
  projectId: string,
  segment: CachedSegment,
  buffer: Buffer,
): string {
  const dir = getSegmentCacheDir(projectId);
  const filePath = join(dir, buildSegmentFileName(segment));
  writeFileSync(filePath, buffer);
  return filePath;
}

function normalizeFfmpegColor(backgroundColor: string): string {
  const normalized = backgroundColor.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized)
    ? `0x${normalized.slice(1)}`
    : "0x000000";
}

export async function renderBlankSegment(
  projectId: string,
  segment: CachedSegment,
  options: BlankSegmentOptions,
): Promise<string> {
  const dir = getSegmentCacheDir(projectId);
  const filePath = join(dir, buildSegmentFileName(segment));
  const duration = Math.max(0.04, options.duration);
  const color = normalizeFfmpegColor(options.backgroundColor);

  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }

  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const proc = spawn(
      getFfmpegBinaryPath(),
      [
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=${options.outputWidth}x${options.outputHeight}:r=${options.fps}:d=${duration.toFixed(3)}`,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-y",
        filePath,
      ],
      { windowsHide: true },
    );

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `FFmpeg exited with code ${code}`));
    });
  });

  return filePath;
}

export function readSegment(
  projectId: string,
  segment: CachedSegment,
): Buffer | null {
  const expectedPath = join(
    getSegmentCacheDir(projectId),
    buildSegmentFileName(segment),
  );
  if (!existsSync(expectedPath)) {
    return null;
  }
  return readFileSync(expectedPath);
}

export function deleteSegments(
  projectId: string,
  exceptFiles: string[] = [],
): void {
  const cacheDir = getSegmentCacheDir(projectId);
  const allowed = new Set(
    exceptFiles.map((filePath) => filePath.toLowerCase()),
  );

  for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name === SEGMENT_MANIFEST_FILE) {
      continue;
    }
    const filePath = join(cacheDir, entry.name);
    if (allowed.has(filePath.toLowerCase())) {
      continue;
    }
    rmSync(filePath, { force: true });
  }
}

function escapeConcatPath(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

export async function concatSegments(
  segmentPaths: string[],
  outputPath: string,
): Promise<void> {
  if (segmentPaths.length === 0) {
    throw new Error(
      "No sequence preview segments are available to concatenate",
    );
  }

  if (segmentPaths.length === 1) {
    if (existsSync(outputPath)) {
      rmSync(outputPath, { force: true });
    }
    copyFileSync(segmentPaths[0], outputPath);
    return;
  }

  const listPath = join(
    getSegmentCacheDirFromOutput(outputPath),
    `concat-${createHash("sha1")
      .update(segmentPaths.join("|"))
      .digest("hex")
      .slice(0, 8)}.txt`,
  );

  writeFileSync(
    listPath,
    segmentPaths
      .map((filePath) => `file '${escapeConcatPath(filePath)}'`)
      .join("\n"),
    "utf-8",
  );

  try {
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      const proc = spawn(
        getFfmpegBinaryPath(),
        [
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          "-y",
          outputPath,
        ],
        { windowsHide: true },
      );

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      proc.once("error", reject);
      proc.once("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(stderr || `FFmpeg exited with code ${code}`));
      });
    });
  } finally {
    rmSync(listPath, { force: true });
  }
}

function getSegmentCacheDirFromOutput(outputPath: string): string {
  return ensureDir(dirname(outputPath));
}

export function getSegmentBasenames(manifest: SegmentManifest): string[] {
  return manifest.segments
    .map((segment) => segment.file)
    .filter((filePath): filePath is string => Boolean(filePath))
    .map((filePath) => basename(filePath));
}
