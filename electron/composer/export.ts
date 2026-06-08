import { mkdirSync, existsSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";
import stringify from "json-stable-stringify";
import { spawn } from "child_process";
import { loadRegistry } from "./db/project-registry";
import { ensureComposerFfmpegAvailable, getFfmpegBinaryPath } from "./ffmpeg";
import { createHeadlessRenderer, renderSegmentInHeadlessRenderer, addHeadlessRendererProgressListener } from "./headless-renderer";
import { createInitialManifest, buildConcatList, concatSegments, computeOverallProgress } from "./segment-cache";
import { buildHeadlessRenderClips } from "./sequence-preview";
import { BrowserWindow } from "electron";

interface ExportJobState {
  running: boolean;
  cancelRequested: boolean;
  tempDir: string | null;
  requestSignature: string | null;
}

const activeExportJobs = new Map<string, ExportJobState>();

class ExportJobCancelledError extends Error {
  constructor(projectId: string, requestSignature: string | null) {
    super(`Export job cancelled for project ${projectId} (${requestSignature ?? ""})`);
    this.name = "ExportJobCancelledError";
  }
}

function getProjectPath(projectId: string): string {
  const project = loadRegistry().projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`Project ${projectId} not found in registry`);
  return project.path;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function buildSegmentFileName(index: number, id: string): string {
  return `segment-${index.toString().padStart(4, "0")}-${id}.mp4`;
}

function broadcastExportProgress(event: Record<string, unknown>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send("composer:export-progress", event);
  }
}

export function cancelProjectExportJob(projectId: string): void {
  const state = activeExportJobs.get(projectId);
  if (!state) return;
  state.cancelRequested = true;
}

export async function renderProjectExport(
  projectId: string,
  request: any,
  outputPath: string,
): Promise<string> {
  await ensureComposerFfmpegAvailable();

  const projectPath = getProjectPath(projectId);
  const exportDir = join(projectPath, "exports");
  ensureDir(exportDir);

  const requestSignature = createHash("sha256").update(stringify(request)).digest("hex");
  const jobState: ExportJobState = {
    running: true,
    cancelRequested: false,
    tempDir: null,
    requestSignature,
  };
  activeExportJobs.set(projectId, jobState);

  const tempDir = join(exportDir, `.export_tmp-${requestSignature}-${Date.now()}`);
  ensureDir(tempDir);
  jobState.tempDir = tempDir;

  // Build manifest and clips
  const manifest = createInitialManifest(request.duration, request.projectWidth, request.projectHeight, request.fps, requestSignature);
  const renderClips = await buildHeadlessRenderClips(
    projectId,
    { request, requestSignature, outputPath },
    { explicitOutputWidth: manifest.outputWidth, explicitOutputHeight: manifest.outputHeight },
  );
  const hasRenderableClips = renderClips.length > 0;

  if (hasRenderableClips) {
    await createHeadlessRenderer();
  }

  const emitSegmentProgress = (progress: any) => {
    try {
      const totalSegments = manifest.segments.length;
      const overallPercent = computeOverallProgress(manifest, progress.segmentId, progress.percent);
      broadcastExportProgress({
        projectId,
        requestSignature,
        status: "processing",
        overallPercent,
        segmentIndex: progress.segmentIndex,
        totalSegments,
        segmentPercent: progress.percent,
        frameIndex: progress.frameIndex,
        totalFrames: progress.totalFrames,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // ignore progress errors
    }
  };

  const removeHeadlessProgressListener = addHeadlessRendererProgressListener(emitSegmentProgress);

  try {
    for (const segment of manifest.segments) {
      if (jobState.cancelRequested) throw new ExportJobCancelledError(projectId, requestSignature);

      const segIndex = segment.index;
      const fileName = buildSegmentFileName(segIndex, segment.id);
      const outPath = join(tempDir, fileName);

      if (hasRenderableClips) {
        const segRequest = {
          ...request,
          segmentId: segment.id,
          segmentIndex: segment.index,
          startTime: segment.startTime,
          endTime: segment.endTime,
          outputWidth: manifest.outputWidth,
          outputHeight: manifest.outputHeight,
          fps: manifest.fps,
          clips: renderClips,
        };
        const renderedBuffer = await renderSegmentInHeadlessRenderer(segRequest);
        writeFileSync(outPath, renderedBuffer);
        // Update manifest in-memory to mark this segment as rendered
        segment.file = outPath as any;
      } else {
        // Render blank segment via ffmpeg directly into temp dir
        const duration = Math.max(0.04, segment.endTime - segment.startTime);
        const color = (() => {
          try {
            const c = String(request.backgroundColor || "#000000").trim().toLowerCase();
            return /^#[0-9a-f]{6}$/.test(c) ? `0x${c.slice(1)}` : "0x000000";
          } catch {
            return "0x000000";
          }
        })();

        // Build render options (defaults) if not provided by the request
        const defaultRenderOptions = {
          codec: "libx264",
          profile: "high",
          maxBitrate: 50000000,
          bufsize: 100000000,
          pixFmt: "yuv420p",
          gopSize: Math.max(1, Math.round(manifest.fps || 30)),
          audio: { codec: "aac", bitrate: 320000, sampleRate: 48000 },
        };
        const renderOptions = request.renderOptions ?? defaultRenderOptions;

        await new Promise<void>((resolve, reject) => {
          const ffmpegExe = getFfmpegBinaryPath();
          // color filter for video, plus a silent audio input to ensure consistent streams
          const colorFilter = `color=c=${(() => {
            try {
              const c = String(request.backgroundColor || "#000000").trim().toLowerCase();
              return /^#[0-9a-f]{6}$/.test(c) ? `0x${c.slice(1)}` : "0x000000";
            } catch {
              return "0x000000";
            }
          })()}:s=${manifest.outputWidth}x${manifest.outputHeight}:r=${manifest.fps}:d=${duration.toFixed(3)}`;

          const maxB = renderOptions.maxBitrate ?? 50000000;
          const bStr = maxB >= 1000000 ? `${Math.round(maxB / 1000000)}M` : String(maxB);
          const buf = renderOptions.bufsize ?? Math.max(maxB * 2, 100000000);
          const bufStr = buf >= 1000000 ? `${Math.round(buf / 1000000)}M` : String(buf);

          const ffmpegArgs = [
            "-f",
            "lavfi",
            "-i",
            colorFilter,
            "-f",
            "lavfi",
            "-i",
            `anullsrc=channel_layout=stereo:sample_rate=${(renderOptions.audio?.sampleRate ?? 48000)}`,
            // map and encode
            "-c:v",
            renderOptions.codec ?? "libx264",
            "-profile:v",
            renderOptions.profile ?? "high",
            "-b:v",
            bStr,
            "-maxrate",
            bStr,
            "-bufsize",
            bufStr,
            "-pix_fmt",
            renderOptions.pixFmt ?? "yuv420p",
            "-g",
            String(renderOptions.gopSize ?? Math.max(1, Math.round(manifest.fps || 30))),
            "-c:a",
            renderOptions.audio?.codec ?? "aac",
            "-b:a",
            String(renderOptions.audio?.bitrate ?? 320000),
            "-ar",
            String(renderOptions.audio?.sampleRate ?? 48000),
            "-shortest",
            "-movflags",
            "+faststart",
            "-y",
            outPath,
          ];
          console.info(`[Composer Spawn] ffmpeg exec=${ffmpegExe} args=${JSON.stringify(ffmpegArgs)}`);
          const proc = spawn(ffmpegExe, ffmpegArgs, { windowsHide: true });
          let stderr = "";
          proc.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
          });
          proc.once("error", reject);
          proc.once("exit", (code) => {
            if (code === 0) return resolve();
            reject(new Error(stderr || `FFmpeg exited with code ${code}`));
          });
        });
        // Update manifest in-memory
        segment.file = outPath as any;
      }
    }

    const segmentPaths = buildConcatList(manifest);
    if (jobState.cancelRequested) throw new ExportJobCancelledError(projectId, requestSignature);

    broadcastExportProgress({ projectId, requestSignature, status: "processing", overallPercent: 95, updatedAt: new Date().toISOString() });
      // Pass renderOptions and target size to concatSegments so re-encode uses correct codec args
      const defaultRenderOptions = {
        codec: "libx264",
        profile: "high",
        maxBitrate: 50000000,
        bufsize: 100000000,
        pixFmt: "yuv420p",
        gopSize: Math.max(1, Math.round(manifest.fps || 30)),
        audio: { codec: "aac", bitrate: 320000, sampleRate: 48000 },
      };
      const renderOptions = request.renderOptions ?? defaultRenderOptions;

      await concatSegments(segmentPaths, outputPath, { targetWidth: manifest.outputWidth, targetHeight: manifest.outputHeight, renderOptions });

    // Final progress
    broadcastExportProgress({ projectId, requestSignature, status: "ready", overallPercent: 100, updatedAt: new Date().toISOString() });

    return outputPath;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcastExportProgress({ projectId, requestSignature, status: "error", overallPercent: 0, errorMessage: message, updatedAt: new Date().toISOString() });
    throw err;
  } finally {
    try {
      removeHeadlessProgressListener?.();
    } catch {}
    // cleanup temp dir
    try {
      if (jobState.tempDir && existsSync(jobState.tempDir)) {
        rmSync(jobState.tempDir, { recursive: true, force: true });
      }
    } catch {
      /* ignore cleanup failures */
    }
    jobState.running = false;
    jobState.cancelRequested = false;
    activeExportJobs.delete(projectId);
  }
}
