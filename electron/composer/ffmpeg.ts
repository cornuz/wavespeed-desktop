import { spawn } from "child_process";
import type { ComposerFfmpegStatus } from "../../src/composer/types/ipc";

const COMPOSER_FFMPEG_BLOCKED_REASON = "FFmpeg is required";
const COMPOSER_FFPROBE_BLOCKED_REASON = "FFprobe (part of FFmpeg) is required for video analysis";

async function checkComposerFfmpegBinary(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn("ffmpeg", ["-version"], {
      stdio: "ignore",
      windowsHide: true,
    });

    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(available);
    };

    proc.once("error", () => finish(false));
    proc.once("exit", (code) => finish(code === 0));
  });
}

async function checkComposerFfprobeBinary(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn("ffprobe", ["-version"], {
      stdio: "ignore",
      windowsHide: true,
    });

    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(available);
    };

    proc.once("error", () => finish(false));
    proc.once("exit", (code) => finish(code === 0));
  });
}

export async function getComposerFfmpegStatus(): Promise<ComposerFfmpegStatus> {
  const available = await checkComposerFfmpegBinary();
  return {
    available,
    blockedReason: available ? null : COMPOSER_FFMPEG_BLOCKED_REASON,
  };
}

export async function ensureComposerFfmpegAvailable(): Promise<void> {
  const status = await getComposerFfmpegStatus();
  if (!status.available) {
    throw new Error(COMPOSER_FFMPEG_BLOCKED_REASON);
  }
}

/**
 * Ensure both FFmpeg and FFprobe are available.
 * Throws a descriptive error if either is missing.
 */
export async function ensureComposerFfmpegToolsAvailable(): Promise<void> {
  const ffmpegAvailable = await checkComposerFfmpegBinary();
  const ffprobeAvailable = await checkComposerFfprobeBinary();

  if (!ffmpegAvailable) {
    throw new Error(COMPOSER_FFMPEG_BLOCKED_REASON);
  }

  if (!ffprobeAvailable) {
    throw new Error(COMPOSER_FFPROBE_BLOCKED_REASON);
  }
}
