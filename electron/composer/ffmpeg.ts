import { spawn } from "child_process";
import { app, net, shell } from "electron";
import { createWriteStream, promises as fs } from "fs";
import { join } from "path";
import type { ComposerFfmpegStatus } from "../../src/composer/types/ipc";

const COMPOSER_FFMPEG_BLOCKED_REASON = "FFmpeg is required";
const COMPOSER_FFPROBE_BLOCKED_REASON = "FFprobe (part of FFmpeg) is required for video analysis";
const FFMPEG_INSTALLER_URL = "https://github.com/oop7/ffmpeg-install-guide/releases/latest/download/FFmpegInstaller.exe";

// Known installation paths (oop7 FFmpegInstaller uses %LOCALAPPDATA%\ffmpeg)
const KNOWN_FFMPEG_PATHS = [
  join(process.env.LOCALAPPDATA || "", "ffmpeg", "bin", "ffmpeg.exe"),
  join(process.env.LOCALAPPDATA || "", "ffmpeg", "bin", "ffprobe.exe"),
];

// Cache discovered binary paths
let cachedFfmpegPath = "ffmpeg";
let cachedFfprobePath = "ffprobe";

/**
 * Get path to ffmpeg binary.
 * Returns cached path from last successful check, or "ffmpeg" if on PATH.
 */
export function getFfmpegBinaryPath(): string {
  return cachedFfmpegPath;
}

/**
 * Get path to ffprobe binary.
 * Returns cached path from last successful check, or "ffprobe" if on PATH.
 */
export function getFfprobeBinaryPath(): string {
  return cachedFfprobePath;
}

async function checkBinaryAtPath(binaryPath: string): Promise<boolean> {
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

async function checkComposerFfmpegBinary(): Promise<boolean> {
  // First try PATH
  const pathCheck = await checkBinaryAtPath("ffmpeg");
  if (pathCheck) {
    cachedFfmpegPath = "ffmpeg";
    return true;
  }

  // Then try known installation paths (oop7 installer uses versioned subdirectories)
  const ffmpegBaseDir = join(process.env.LOCALAPPDATA || "", "ffmpeg");

  try {
    const entries = await fs.readdir(ffmpegBaseDir, { withFileTypes: true });

    // Look for any ffmpeg-*-*_build subdirectory
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("ffmpeg-")) {
        const candidatePath = join(ffmpegBaseDir, entry.name, "bin", "ffmpeg.exe");

        try {
          await fs.access(candidatePath);
          const result = await checkBinaryAtPath(candidatePath);
          if (result) {
            cachedFfmpegPath = candidatePath;
            return true;
          }
        } catch {
          // Try next candidate
        }
      }
    }
  } catch {
    // Base directory doesn't exist
  }

  return false;
}

async function checkComposerFfprobeBinary(): Promise<boolean> {
  // First try PATH
  const pathCheck = await checkBinaryAtPath("ffprobe");
  if (pathCheck) {
    cachedFfprobePath = "ffprobe";
    return true;
  }

  // Then try known installation paths (oop7 installer uses versioned subdirectories)
  const ffmpegBaseDir = join(process.env.LOCALAPPDATA || "", "ffmpeg");

  try {
    const entries = await fs.readdir(ffmpegBaseDir, { withFileTypes: true });

    // Look for any ffmpeg-*-*_build subdirectory
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("ffmpeg-")) {
        const candidatePath = join(ffmpegBaseDir, entry.name, "bin", "ffprobe.exe");

        try {
          await fs.access(candidatePath);
          const result = await checkBinaryAtPath(candidatePath);
          if (result) {
            cachedFfprobePath = candidatePath;
            return true;
          }
        } catch {
          // Try next candidate
        }
      }
    }
  } catch {
    // Base directory doesn't exist
  }

  return false;
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

/**
 * Download the FFmpeg installer from oop7's GitHub releases.
 * Returns the path to the downloaded installer.
 */
export async function downloadFFmpegInstaller(): Promise<string> {
  const tempPath = join(app.getPath("temp"), "FFmpegInstaller.exe");

  // Download using Electron's net module (respects proxy settings)
  const response = await net.fetch(FFMPEG_INSTALLER_URL);
  if (!response.ok) {
    throw new Error(`Failed to download installer: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  await fs.writeFile(tempPath, Buffer.from(buffer));

  return tempPath;
}

/**
 * Launch the FFmpeg installer GUI.
 * The installer will handle UAC elevation and PATH setup.
 */
export async function launchFFmpegInstaller(installerPath: string): Promise<void> {
  await shell.openPath(installerPath);
}
