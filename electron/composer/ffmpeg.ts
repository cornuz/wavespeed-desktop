import { spawn } from "child_process";
import { app } from "electron";
import { existsSync } from "fs";
import { join } from "path";
import type { ComposerFfmpegStatus } from "../../src/composer/types/ipc";

const COMPOSER_FFMPEG_BLOCKED_REASON = "FFmpeg is required";
const COMPOSER_FFPROBE_BLOCKED_REASON = "FFprobe (part of FFmpeg) is required for video analysis";

/**
 * Get path to bundled ffmpeg binary.
 * In production: uses app.getAppPath() + resources/bin/ffmpeg.exe
 * In development: checks local bin/ folder first, falls back to system PATH
 */
export function getFfmpegBinaryPath(): string {
  if (app.isPackaged) {
    // Production: bundled binary in resources/bin/
    const bundledPath = join(process.resourcesPath, "bin", "ffmpeg.exe");
    return existsSync(bundledPath) ? bundledPath : "ffmpeg";
  } else {
    // Development: check local bin/ folder first
    const localPath = join(app.getAppPath(), "bin", "ffmpeg.exe");
    if (existsSync(localPath)) {
      return localPath;
    }
    // Fall back to system PATH (return "ffmpeg" to use PATH lookup)
    return "ffmpeg";
  }
}

/**
 * Get path to bundled ffprobe binary.
 * In production: uses app.getAppPath() + resources/bin/ffprobe.exe
 * In development: checks local bin/ folder first, falls back to system PATH
 */
export function getFfprobeBinaryPath(): string {
  if (app.isPackaged) {
    // Production: bundled binary in resources/bin/
    const bundledPath = join(process.resourcesPath, "bin", "ffprobe.exe");
    return existsSync(bundledPath) ? bundledPath : "ffprobe";
  } else {
    // Development: check local bin/ folder first
    const localPath = join(app.getAppPath(), "bin", "ffprobe.exe");
    if (existsSync(localPath)) {
      return localPath;
    }
    // Fall back to system PATH (return "ffprobe" to use PATH lookup)
    return "ffprobe";
  }
}

async function checkComposerFfmpegBinary(): Promise<boolean> {
  const binaryPath = getFfmpegBinaryPath();

  return new Promise<boolean>((resolve) => {
    const proc = spawn(binaryPath, ["-version"], {
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
  const binaryPath = getFfprobeBinaryPath();

  return new Promise<boolean>((resolve) => {
    const proc = spawn(binaryPath, ["-version"], {
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
