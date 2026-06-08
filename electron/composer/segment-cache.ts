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
import { getFfmpegBinaryPath, getFfprobeBinaryPath } from "./ffmpeg";

const SEGMENT_CACHE_SUBDIR = "seqseg";
const SEGMENT_MANIFEST_FILE = "manifest.json";
const SEGMENT_DURATION_SECONDS = 5;

export interface RenderOptions {
  codec?: "libx264" | "libx265" | string;
  profile?: string;
  maxBitrate?: number; // in bits per second
  bufsize?: number; // in bits
  pixFmt?: string;
  gopSize?: number; // frames
  audio?: {
    codec?: string;
    bitrate?: number; // bps
    sampleRate?: number; // Hz
  } | null;
}

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
    const ffmpegExe = getFfmpegBinaryPath();
    const ffmpegArgs = [
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
    ];
    console.info(`[Composer Spawn] ffmpeg exec=${ffmpegExe} args=${JSON.stringify(ffmpegArgs)}`);
    const proc = spawn(ffmpegExe, ffmpegArgs, { windowsHide: true });

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
  options?: { targetWidth?: number; targetHeight?: number; renderOptions?: RenderOptions },
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

  const outputDir = getSegmentCacheDirFromOutput(outputPath);

  // Helper: probe video size (width x height) using ffprobe
  async function probeVideoSize(filePath: string): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      try {
        const ffprobeExe = getFfprobeBinaryPath();
        const args = [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height",
          "-of",
          "csv=p=0:s=x",
          filePath,
        ];
        const proc = spawn(ffprobeExe, args, { windowsHide: true });
        let out = "";
        proc.stdout.on("data", (chunk) => (out += String(chunk)));
        proc.once("error", () => resolve(null));
        proc.once("exit", (code) => {
          if (code !== 0) return resolve(null);
          const parts = out.trim().split("x");
          if (parts.length === 2) {
            const w = Number(parts[0]) || 0;
            const h = Number(parts[1]) || 0;
            if (w > 0 && h > 0) return resolve({ width: w, height: h });
          }
          return resolve(null);
        });
      } catch {
        return resolve(null);
      }
    });
  }

  // Helper: re-encode a segment to target size with letterbox/pad to preserve aspect
  async function reencodeToSize(
    input: string,
    target: string,
    width: number,
    height: number,
    renderOptions?: RenderOptions,
    sourceFps?: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
      const ffmpegExe = getFfmpegBinaryPath();
      const ro = renderOptions ?? {};
      const videoCodec = ro.codec ?? "libx264";
      const profile = ro.profile ?? "high";
      const pixFmt = ro.pixFmt ?? "yuv420p";
      const maxBitrate = ro.maxBitrate ?? 50000000;
      const bufsize = ro.bufsize ?? Math.max(maxBitrate * 2, 100000000);
      const gop = ro.gopSize ?? Math.max(1, Math.round(sourceFps ?? 30));

      const bStr = maxBitrate >= 1000000 ? `${Math.round(maxBitrate / 1000000)}M` : String(maxBitrate);
      const bufStr = bufsize >= 1000000 ? `${Math.round(bufsize / 1000000)}M` : String(bufsize);

      const args: string[] = ["-i", input, "-vf", vf];

      // Map video codec/settings
      args.push("-c:v", videoCodec);
      if (videoCodec.includes("x264") || videoCodec === "libx264") {
        args.push("-profile:v", profile);
      }
      args.push("-b:v", bStr, "-maxrate", bStr, "-bufsize", bufStr);
      args.push("-pix_fmt", pixFmt);
      args.push("-g", String(gop));

      // Audio settings
      const audio = ro.audio ?? { codec: "aac", bitrate: 320000, sampleRate: 48000 };
      if (audio) {
        args.push("-c:a", audio.codec ?? "aac");
        if (audio.bitrate) args.push("-b:a", audio.bitrate >= 1000000 ? `${Math.round((audio.bitrate || 0) / 1000000)}M` : String(audio.bitrate));
        if (audio.sampleRate) args.push("-ar", String(audio.sampleRate));
      } else {
        args.push("-an");
      }

      args.push("-movflags", "+faststart", "-y", target);
      console.info(`[Composer Spawn] ffmpeg reencode exec=${ffmpegExe} args=${JSON.stringify(args)}`);
      const proc = spawn(ffmpegExe, args, { windowsHide: true });
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.once("error", (err) => reject(err));
      proc.once("exit", (code) => {
        if (code === 0) return resolve();
        reject(new Error(stderr || `FFmpeg exited with code ${code}`));
      });
    });
  }

  // Probe all segment sizes
  const probed = await Promise.all(segmentPaths.map((p) => probeVideoSize(p)));
  const sizes = probed.map((r) => (r ? `${r.width}x${r.height}` : "unknown"));

  // Determine target size
  let targetW: number | undefined = options?.targetWidth;
  let targetH: number | undefined = options?.targetHeight;
  const renderOptions = options?.renderOptions;
  if (typeof targetW !== "number" || typeof targetH !== "number") {
    // pick first successfully probed size
    for (const p of probed) {
      if (p) {
        targetW = p.width;
        targetH = p.height;
        break;
      }
    }
  }

  // If any size mismatches target or unknowns present, re-encode each segment to target
  const needReencode = probed.some((p) => !p || p.width !== targetW || p.height !== targetH) || false;

  let workingPaths = segmentPaths.slice();
  const reencodedPaths: string[] = [];

  if (needReencode) {
    if (!targetW || !targetH) {
      throw new Error("Unable to determine target video size for concat");
    }
    try {
      for (let i = 0; i < segmentPaths.length; i += 1) {
        const src = segmentPaths[i];
        const rePath = join(outputDir, `reencoded-${i.toString().padStart(4, "0")}-${basename(src)}`);
        // try to probe fps from original; if unavailable, default to 30
        const fpsProbe = await (async () => {
          try {
            const ffprobeExe = getFfprobeBinaryPath();
            const args = ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "default=nw=1:nk=1", src];
            return await new Promise<number>((resolve) => {
              const p = spawn(ffprobeExe, args, { windowsHide: true });
              let out = "";
              p.stdout.on("data", (c) => (out += String(c)));
              p.once("exit", (code) => {
                if (code !== 0) return resolve(30);
                try {
                  const frac = out.trim();
                  if (!frac) return resolve(30);
                  const [num, den] = frac.split("/").map((v) => Number(v));
                  if (!den || !num) return resolve(30);
                  return resolve(num / den);
                } catch {
                  return resolve(30);
                }
              });
            });
          } catch {
            return 30;
          }
        })();

        await reencodeToSize(src, rePath, targetW, targetH, renderOptions, Math.max(1, Math.round(fpsProbe || 30)));
        reencodedPaths.push(rePath);
      }
      workingPaths = reencodedPaths.slice();
    } catch (err) {
      // cleanup any reencoded files on error
      for (const f of reencodedPaths) {
        try {
          rmSync(f, { force: true });
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
  }

  const listPath = join(
    outputDir,
    `concat-${createHash("sha1").update(workingPaths.join("|")).digest("hex").slice(0, 8)}.txt`,
  );

  writeFileSync(listPath, workingPaths.map((filePath) => `file '${escapeConcatPath(filePath)}'`).join("\n"), "utf-8");

  try {
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      const ffmpegExe = getFfmpegBinaryPath();
      const ffmpegArgs = ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", "-y", outputPath];
      console.info(`[Composer Spawn] ffmpeg exec=${ffmpegExe} args=${JSON.stringify(ffmpegArgs)}`);
      const proc = spawn(ffmpegExe, ffmpegArgs, { windowsHide: true });

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
    // cleanup reencoded files
    for (const f of reencodedPaths) {
      try {
        rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
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
