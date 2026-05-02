/**
 * Video asset processor: validates and transcodes video files to safe editing formats.
 * Composer only: keeps video handling isolated to the project asset ingestion.
 */
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { existsSync, statSync } from "fs";
import type { ComposerPreviewProxyTier } from "../../src/composer/types/project";

interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  duration: number;
  frameRate?: string;
  pixelFormat?: string;
  sampleAspectRatio?: string;
}

interface AudioStreamInfo {
  codec: string;
  sampleRate?: number;
  channels?: number;
}

interface ProbeResult {
  video?: VideoStreamInfo;
  audio?: AudioStreamInfo[];
}

export interface PreviewProxyTarget {
  tier: ComposerPreviewProxyTier;
  width: number;
  height: number;
}

interface PreviewProxyEncodeProfile {
  videoBitrate: string;
  maxRate: string;
  bufSize: string;
  crf: string;
  audioBitrate: string;
}

/** Safe video codecs for Composer editing */
const SAFE_VIDEO_CODECS = new Set(["h264", "libx264"]);

/** Safe audio codecs; if missing or exotic, we'll mark unsupported but keep video */
const SAFE_AUDIO_CODECS = new Set([
  "aac",
  "libmp3lame",
  "mp3",
  "pcm_s16le",
  "flac",
]);

/** Safe container formats */
const SAFE_CONTAINERS = new Set(["mp4"]);

/** Pixel format accepted directly by Chromium + Composer editing surfaces */
const SAFE_PIXEL_FORMATS = new Set(["yuv420p"]);

/**
 * Preview-only proxy ladder tuned for Chromium playback:
 * - keep H.264/MP4/yuv420p compatibility
 * - constrain bitrate with VBV caps instead of loose CRF-only output
 * - bias toward easier local decoding
 */
const PREVIEW_PROXY_ENCODE_PROFILES: Record<
  ComposerPreviewProxyTier,
  PreviewProxyEncodeProfile
> = {
  high: {
    videoBitrate: "3200k",
    maxRate: "4200k",
    bufSize: "8400k",
    crf: "22",
    audioBitrate: "112k",
  },
  med: {
    videoBitrate: "2000k",
    maxRate: "2600k",
    bufSize: "5200k",
    crf: "23",
    audioBitrate: "96k",
  },
  low: {
    videoBitrate: "1200k",
    maxRate: "1600k",
    bufSize: "3200k",
    crf: "24",
    audioBitrate: "80k",
  },
};

function parseFrameRate(frameRate?: string): number | null {
  if (!frameRate) {
    return null;
  }

  const [numeratorRaw, denominatorRaw] = frameRate.split("/");
  const numerator = Number(numeratorRaw);
  const denominator = denominatorRaw != null ? Number(denominatorRaw) : 1;

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }

  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

function getPreviewProxyGopSize(frameRate?: string): { gop: number; minKeyint: number } {
  const fps = parseFrameRate(frameRate);
  if (!fps) {
    return {
      gop: 60,
      minKeyint: 30,
    };
  }

  const gop = Math.max(24, Math.min(240, Math.round(fps * 2)));
  const minKeyint = Math.max(12, Math.min(gop, Math.round(fps)));

  return { gop, minKeyint };
}

/**
 * Probe video file using FFmpeg to extract stream info.
 * Returns null if probe fails (file may not be video or ffprobe missing).
 * Logs a warning with details about the failure.
 */
export async function probeVideoFile(filePath: string): Promise<ProbeResult | null> {
  return new Promise<ProbeResult | null>((resolve) => {
    const proc = spawn("ffprobe", [
      "-v",
      "quiet",
      "-of",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);

    let stdout = "";
    let stderr = "";
    let spawnError: Error | null = null;

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (error) => {
      // ffprobe process failed to spawn
      spawnError = error;
    });

    proc.on("close", (code) => {
      if (spawnError) {
        console.warn(
          "[Video Processor] ffprobe not found or failed to execute. Video analysis is unavailable. " +
          "Make sure FFmpeg (which includes ffprobe) is installed and in your PATH.",
        );
        return resolve(null);
      }

      if (code !== 0) {
        console.warn(
          `[Video Processor] ffprobe failed with exit code ${code}:`,
          stderr || "(no stderr output)",
        );
        return resolve(null);
      }

      try {
        const probe = JSON.parse(stdout) as {
          streams?: Array<{ codec_type: string; codec_name: string }>;
          format?: { duration?: string };
        };

        const result: ProbeResult = {};
        const streams = probe.streams ?? [];

        for (const stream of streams) {
          if (stream.codec_type === "video") {
            const videoStream = stream as {
              codec_name: string;
              width?: number;
              height?: number;
              r_frame_rate?: string;
              pix_fmt?: string;
              sample_aspect_ratio?: string;
            };
            result.video = {
              codec: videoStream.codec_name,
              width: videoStream.width ?? 0,
              height: videoStream.height ?? 0,
              duration: probe.format?.duration ? parseFloat(probe.format.duration) : 0,
              frameRate: videoStream.r_frame_rate,
              pixelFormat: videoStream.pix_fmt,
              sampleAspectRatio: videoStream.sample_aspect_ratio,
            };
          } else if (stream.codec_type === "audio") {
            const audioStream = stream as {
              codec_name: string;
              sample_rate?: string;
              channels?: number;
            };
            if (!result.audio) result.audio = [];
            result.audio.push({
              codec: audioStream.codec_name,
              sampleRate: audioStream.sample_rate ? parseInt(audioStream.sample_rate, 10) : undefined,
              channels: audioStream.channels,
            });
          }
        }

        resolve(result);
      } catch (err) {
        console.warn(`[Video Processor] Failed to parse ffprobe output:`, err);
        resolve(null);
      }
    });
  });
}

/**
 * Determine if video is safe for editing without transcoding.
 * Returns:
 *  - "ready": video is safe, use original file
 *  - "needs-transcode": video needs H.264/MP4 conversion
 *  - "error": video is invalid
 */
export async function checkVideoSafety(filePath: string): Promise<
  | {
      status: "ready" | "needs-transcode";
      hasUnsupportedAudio: boolean;
    }
  | {
      status: "error";
      message: string;
    }
> {
  const probe = await probeVideoFile(filePath);

  if (!probe || !probe.video) {
    return {
      status: "error",
      message: "Not a valid video file or cannot read metadata",
    };
  }

  // Check container format
  const ext = filePath.split(".").pop()?.toLowerCase();
  const containerSafe = ext && SAFE_CONTAINERS.has(ext);

  // Check video codec
  const videoCodecSafe = SAFE_VIDEO_CODECS.has(probe.video.codec.toLowerCase());

  // Check pixel format / square pixels. Be strict here: if we are not confident,
  // we force the canonical transcode so the timeline and player always work from
  // a known-good editing format.
  const pixelFormatSafe =
    probe.video.pixelFormat != null &&
    SAFE_PIXEL_FORMATS.has(probe.video.pixelFormat.toLowerCase());
  const sar = probe.video.sampleAspectRatio?.toLowerCase();
  const squarePixels = !sar || sar === "1:1" || sar === "0:1";
  const evenDimensions = probe.video.width > 0 && probe.video.height > 0
    ? probe.video.width % 2 === 0 && probe.video.height % 2 === 0
    : false;

  // Check audio: mark unsupported but don't fail
  let hasUnsupportedAudio = false;
  if (probe.audio && probe.audio.length > 0) {
    hasUnsupportedAudio = !probe.audio.every(
      (a) => SAFE_AUDIO_CODECS.has(a.codec.toLowerCase()),
    );
  }

  // Only bypass transcode for media that already matches the canonical safe path.
  if (videoCodecSafe && containerSafe && pixelFormatSafe && squarePixels && evenDimensions) {
    return {
      status: "ready",
      hasUnsupportedAudio,
    };
  }

  // Otherwise, mark for transcoding
  return {
    status: "needs-transcode",
    hasUnsupportedAudio,
  };
}

/**
 * Transcode video to H.264/MP4 format safe for editing.
 * Copies audio as-is (even if unsupported codec), will be marked as unsupported.
 * Returns path to transcoded file or null on failure.
 * 
 * Callback reports progress: { phase: "transcoding", progress: 0-100 }
 */
export async function transcodeVideoToSafeFormat(
  sourcePath: string,
  outputPath: string,
  options?: {
    includeAudio?: boolean;
  },
  onProgress?: (progress: { phase: string; progress: number }) => void,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;

    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      if (success && existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        resolve(null);
      }
    };

    void probeVideoFile(sourcePath)
      .then((probe) => {
        const probedDuration = probe?.video?.duration ?? 0;
        const ffmpegArgs = [
          "-i",
          sourcePath,
          "-vf",
          "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          "-g",
          "1",
          "-keyint_min",
          "1",
          "-sc_threshold",
          "0",
          "-movflags",
          "+faststart",
        ];

        if (options?.includeAudio === false) {
          ffmpegArgs.push("-an");
        } else {
          ffmpegArgs.push("-c:a", "aac", "-b:a", "192k");
        }

        ffmpegArgs.push("-y", outputPath);

        const proc = spawn("ffmpeg", ffmpegArgs, {
          windowsHide: true,
        });

        proc.stderr.on("data", (data) => {
          const chunk = data.toString();

          const allMatches = chunk.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
          if (allMatches && allMatches.length > 0 && onProgress && probedDuration > 0) {
            const lastMatch = allMatches[allMatches.length - 1];
            const timeRegex = /time=(\d+):(\d+):(\d+\.\d+)/.exec(lastMatch);
            if (timeRegex) {
              const [, hours, minutes, seconds] = timeRegex;
              const currentSeconds =
                parseInt(hours, 10) * 3600 +
                parseInt(minutes, 10) * 60 +
                parseFloat(seconds);

              const progress = Math.min(100, (currentSeconds / probedDuration) * 100);
              onProgress({
                phase: "transcoding",
                progress: Math.round(progress),
              });
            }
          }
        });

        proc.once("error", () => {
          finish(false);
        });

        proc.once("exit", (code) => {
          finish(code === 0);
        });
      })
      .catch(() => {
        finish(false);
      });
  });
}

/**
 * Transcode a preview-only playback proxy.
 * Uses compressed H.264/AAC output with continuous audio and faststart metadata.
 */
export async function transcodeVideoToPreviewProxy(
  sourcePath: string,
  outputPath: string,
  target: PreviewProxyTarget,
  onProgress?: (progress: { phase: string; progress: number }) => void,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;

    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      if (success && existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        resolve(null);
      }
    };

    void probeVideoFile(sourcePath)
      .then((probe) => {
        const probedDuration = probe?.video?.duration ?? 0;
        const maxWidth = Math.max(2, target.width);
        const maxHeight = Math.max(2, target.height);
        const encodeProfile = PREVIEW_PROXY_ENCODE_PROFILES[target.tier];
        const { gop, minKeyint } = getPreviewProxyGopSize(probe?.video?.frameRate);
        const ffmpegArgs = [
          "-i",
          sourcePath,
          "-vf",
          `scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2,setsar=1`,
          "-c:v",
          "libx264",
          "-preset",
          "faster",
          "-tune",
          "fastdecode",
          "-crf",
          encodeProfile.crf,
          "-b:v",
          encodeProfile.videoBitrate,
          "-maxrate",
          encodeProfile.maxRate,
          "-bufsize",
          encodeProfile.bufSize,
          "-pix_fmt",
          "yuv420p",
          "-g",
          String(gop),
          "-keyint_min",
          String(minKeyint),
          "-sc_threshold",
          "0",
          "-movflags",
          "+faststart",
        ];

        if (probe?.audio && probe.audio.length > 0) {
          ffmpegArgs.push("-c:a", "aac", "-b:a", encodeProfile.audioBitrate);
        } else {
          ffmpegArgs.push("-an");
        }

        ffmpegArgs.push("-y", outputPath);

        const proc = spawn("ffmpeg", ffmpegArgs, {
          windowsHide: true,
        });

        proc.stderr.on("data", (data) => {
          const chunk = data.toString();

          const allMatches = chunk.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
          if (allMatches && allMatches.length > 0 && onProgress && probedDuration > 0) {
            const lastMatch = allMatches[allMatches.length - 1];
            const timeRegex = /time=(\d+):(\d+):(\d+\.\d+)/.exec(lastMatch);
            if (timeRegex) {
              const [, hours, minutes, seconds] = timeRegex;
              const currentSeconds =
                parseInt(hours, 10) * 3600 +
                parseInt(minutes, 10) * 60 +
                parseFloat(seconds);

              const progress = Math.min(100, (currentSeconds / probedDuration) * 100);
              onProgress({
                phase: "proxy",
                progress: Math.round(progress),
              });
            }
          }
        });

        proc.once("error", () => {
          finish(false);
        });

        proc.once("exit", (code) => {
          finish(code === 0);
        });
      })
      .catch(() => {
        finish(false);
      });
  });
}
