import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { extname, join, normalize, resolve } from "path";
import stringify from "json-stable-stringify";
import { normalizeClipAdjustments } from "../../src/composer/shared/clipAdjustments";
import type {
  Clip,
  ClipBlendMode,
  ComposerPlaybackQuality,
  ComposerSequencePreview,
  ComposerSequencePreviewInvalidationCause,
  ComposerSequencePreviewRequest,
  Track,
} from "../../src/composer/types/project";
import { getComposedClipRect } from "../../src/composer/shared/compositionGeometry";
import { loadAssetMetadata } from "./asset-metadata";
import { loadRegistry } from "./db/project-registry";
import { listClips } from "./db/clips.repo";
import { listTracks } from "./db/tracks.repo";
import {
  getStoredSequencePreview,
  saveStoredSequencePreview,
} from "./db/sequence-preview.repo";
import { getProjectDatabase } from "./db/connection";
import { ensureComposerFfmpegToolsAvailable } from "./ffmpeg";

export const SEQUENCE_PREVIEW_REQUEST_VERSION = 5;
const SEQUENCE_PREVIEW_EDIT_DEBOUNCE_MS = 600;
const SEQUENCE_PREVIEW_RECONCILE_INTERVAL_MS = 15_000;

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);
const SEQUENCE_PREVIEW_SCALE_BY_QUALITY: Record<ComposerPlaybackQuality, number> = {
  full: 1,
  high: 0.85,
  med: 0.7,
  low: 0.55,
};

const SEQUENCE_PREVIEW_ENCODE_PROFILES: Record<
  ComposerPlaybackQuality,
  {
    videoBitrate: string;
    maxRate: string;
    bufSize: string;
    crf: string;
    audioBitrate: string;
  }
> = {
  full: {
    videoBitrate: "5000k",
    maxRate: "6500k",
    bufSize: "13000k",
    crf: "20",
    audioBitrate: "192k",
  },
  high: {
    videoBitrate: "3200k",
    maxRate: "4200k",
    bufSize: "8400k",
    crf: "22",
    audioBitrate: "128k",
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

interface ProjectSequencePreviewSettings {
  duration: number;
  fps: number;
  width: number;
  height: number;
  playbackQuality: ComposerPlaybackQuality;
}

interface MediaProbeResult {
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  duration: number | null;
}

interface ResolvedPreviewMediaSource {
  path: string;
  probe: MediaProbeResult | null;
  inputKind: "image" | "media";
}

interface SequencePreviewRenderPlan {
  request: ComposerSequencePreviewRequest;
  requestSignature: string;
  outputPath: string;
}

interface ProjectSequencePreviewJobState {
  running: boolean;
  rerunRequested: boolean;
  scheduledTimer: ReturnType<typeof setTimeout> | null;
}

const activeSequencePreviewJobs = new Map<string, ProjectSequencePreviewJobState>();
const trackedSequencePreviewProjects = new Set<string>();
let sequencePreviewReconcileTimer: ReturnType<typeof setInterval> | null = null;

function computeHash(input: unknown): string {
  return createHash("sha256")
    .update(stringify(input) || "{}")
    .digest("hex");
}

function normalizeEvenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function clampClipDuration(value: number): number {
  return Math.max(0.04, value);
}

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(Math.max(value, 0), 1);
}

function clampFadeDuration(value: number, clipDuration: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(value, clipDuration);
}

function clampSignedPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, -100), 100);
}

function clampUnsignedPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 100);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

function getProjectLutsDir(projectId: string): string {
  return join(getProjectAssetsDir(projectId), "luts");
}

function resolveProjectLutPath(projectId: string, lutAssetId: string | null): string | null {
  if (!lutAssetId) {
    return null;
  }

  const lutDir = getProjectLutsDir(projectId);
  const resolvedPath = normalize(join(lutDir, lutAssetId));
  const normalizedDir = normalize(lutDir);
  const normalizedDirPrefix = normalizedDir.endsWith("\\")
    ? normalizedDir
    : `${normalizedDir}\\`;
  if (
    !resolvedPath.startsWith(normalizedDirPrefix) ||
    !existsSync(resolvedPath)
  ) {
    return null;
  }

  return resolvedPath;
}

function escapeFfmpegFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function getFfmpegBlendMode(mode: ClipBlendMode): string | null {
  switch (mode) {
    case "multiply":
      return "multiply";
    case "screen":
      return "screen";
    case "overlay":
      return "overlay";
    case "soft-light":
      return "softlight";
    case "darken":
      return "darken";
    case "lighten":
      return "lighten";
    default:
      return null;
  }
}

function buildClipCurvesFilter(shadows: number, highlights: number): string | null {
  if (shadows === 0 && highlights === 0) {
    return null;
  }

  const shadowFactor = clampSignedPercent(shadows) / 100;
  const highlightFactor = clampSignedPercent(highlights) / 100;
  const points = [
    `0/${formatFilterNumber(clampUnit(Math.max(0, shadowFactor * 0.08)))}`,
    `0.25/${formatFilterNumber(clampUnit(0.25 + shadowFactor * 0.18))}`,
    `0.75/${formatFilterNumber(clampUnit(0.75 + highlightFactor * 0.18))}`,
    `1/${formatFilterNumber(clampUnit(1 + highlightFactor * 0.08))}`,
  ];
  return `curves=all='${points.join(" ")}'`;
}

function buildClipAdjustmentFilters(projectId: string, clip: Clip): string[] {
  const adjustments = normalizeClipAdjustments(clip.adjustments);
  const filters: string[] = [];
  const temperature = clampSignedPercent(adjustments.colorCorrection.temperature) / 100;
  const tint = clampSignedPercent(adjustments.colorCorrection.tint) / 100;
  const hue = clampSignedPercent(adjustments.colorCorrection.hue) * 1.8;
  const saturation =
    1 + clampSignedPercent(adjustments.colorCorrection.saturation) / 100;
  const exposure =
    clampSignedPercent(adjustments.lightnessCorrection.exposure) / 200;
  const contrast =
    1 + clampSignedPercent(adjustments.lightnessCorrection.contrast) / 100;
  const curvesFilter = buildClipCurvesFilter(
    adjustments.lightnessCorrection.shadows,
    adjustments.lightnessCorrection.highlights,
  );
  const sharpen = clampUnsignedPercent(adjustments.effects.sharpen);
  const noise = clampUnsignedPercent(adjustments.effects.noise);
  const vignette = clampUnsignedPercent(adjustments.effects.vignette);
  const lutPath = resolveProjectLutPath(projectId, adjustments.lutAssetId);

  if (temperature !== 0 || tint !== 0) {
    filters.push(
      `colorbalance=rm=${formatFilterNumber(temperature * 0.35 + tint * 0.2)}:gm=${formatFilterNumber(-tint * 0.2)}:bm=${formatFilterNumber(-temperature * 0.35)}`,
    );
  }
  if (hue !== 0 || saturation !== 1) {
    filters.push(
      `hue=h=${formatFilterNumber(hue)}:s=${formatFilterNumber(Math.max(0, saturation))}`,
    );
  }
  if (exposure !== 0 || contrast !== 1) {
    filters.push(
      `eq=brightness=${formatFilterNumber(exposure)}:contrast=${formatFilterNumber(Math.max(0, contrast))}`,
    );
  }
  if (curvesFilter) {
    filters.push(curvesFilter);
  }
  if (lutPath) {
    filters.push("format=rgb24");
    filters.push(`lut3d=file='${escapeFfmpegFilterPath(lutPath)}':interp=tetrahedral`);
  }
  if (sharpen > 0) {
    filters.push(
      `unsharp=5:5:${formatFilterNumber(sharpen / 20)}:5:5:0`,
    );
  }
  if (noise > 0) {
    filters.push(`noise=alls=${formatFilterNumber(noise * 0.25)}:allf=t+u`);
  }
  if (vignette > 0) {
    const vignetteAngle = Math.max(0.35, 1.35 - vignette * 0.008);
    filters.push(
      `vignette=angle=${formatFilterNumber(vignetteAngle)}:x0=W/2:y0=H/2:mode=forward`,
    );
  }

  return filters;
}

function computeClipRenderedDuration(
  clip: Clip,
  clipSourceDuration: number,
  clipVisibleDuration: number,
  inputKind: ResolvedPreviewMediaSource["inputKind"],
): number {
  if (inputKind === "image") {
    return clipVisibleDuration;
  }

  return clampClipDuration(
    Math.min(
      clipVisibleDuration,
      clipSourceDuration / Math.max(clip.speed, 0.01),
    ),
  );
}

function getSequencePreviewOutputDimensions(
  request: ComposerSequencePreviewRequest,
): { width: number; height: number } {
  const scale = SEQUENCE_PREVIEW_SCALE_BY_QUALITY[request.playbackQuality];
  return {
    width: normalizeEvenDimension(request.projectWidth * scale),
    height: normalizeEvenDimension(request.projectHeight * scale),
  };
}

function getProjectSequencePreviewSettings(
  projectId: string,
): ProjectSequencePreviewSettings {
  const db = getProjectDatabase(projectId);
  if (!db) {
    throw new Error(`Project ${projectId} is not open`);
  }

  const result = db.exec(
    `SELECT duration, fps, width, height, playback_quality FROM meta LIMIT 1`,
  );
  const row = result[0]?.values?.[0];
  if (!row) {
    throw new Error(`Project ${projectId} meta row missing`);
  }

  return {
    duration: row[0] as number,
    fps: row[1] as number,
    width: row[2] as number,
    height: row[3] as number,
    playbackQuality: ((row[4] as string) || "med") as ComposerPlaybackQuality,
  };
}

function getProjectSummary(projectId: string) {
  const summary = loadRegistry().projects.find((project) => project.id === projectId);
  if (!summary) {
    throw new Error(`Project ${projectId} not found in registry`);
  }
  return summary;
}

function getProjectAssetsDir(projectId: string): string {
  return join(getProjectSummary(projectId).path, "assets");
}

function getProjectCacheDir(projectId: string): string {
  return join(getProjectSummary(projectId).path, "cache");
}

function getLegacyProjectSequencePreviewCacheDir(projectId: string): string {
  return join(getProjectCacheDir(projectId), "sequence-preview");
}

function getProjectSequencePreviewFilePath(
  projectId: string,
  requestSignature: string,
): string {
  const cacheDir = getProjectCacheDir(projectId);
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  return join(cacheDir, `seqprev-${requestSignature}.mp4`);
}

function normalizeSequencePreviewPath(filePath: string): string {
  return resolve(filePath).toLowerCase();
}

function pruneProjectSequencePreviewCache(
  projectId: string,
  keepFilePath: string,
): void {
  const keptPath = normalizeSequencePreviewPath(keepFilePath);
  const cacheDir = getProjectCacheDir(projectId);
  if (existsSync(cacheDir)) {
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
      const entryPath = join(cacheDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "sequence-preview") {
          rmSync(entryPath, { force: true, recursive: true });
        }
        continue;
      }

      if (
        !/^seqprev-[0-9a-f]+\.mp4$/i.test(entry.name) ||
        normalizeSequencePreviewPath(entryPath) === keptPath
      ) {
        continue;
      }
      rmSync(entryPath, { force: true, recursive: true });
    }
  }

  const legacyCacheDir = getLegacyProjectSequencePreviewCacheDir(projectId);
  if (existsSync(legacyCacheDir)) {
    rmSync(legacyCacheDir, { force: true, recursive: true });
  }
}

function pruneProjectSequencePreviewCacheForCurrent(
  projectId: string,
  preview: ComposerSequencePreview,
): void {
  if (
    preview.status !== "ready" ||
    !preview.filePath ||
    !existsSync(preview.filePath)
  ) {
    return;
  }

  try {
    pruneProjectSequencePreviewCache(projectId, preview.filePath);
  } catch (error) {
    console.warn(
      `[Composer] Failed to prune sequence preview cache for project ${projectId}:`,
      error,
    );
  }
}

export function computeProjectTimelineSignature(projectId: string): string {
  const tracks = listTracks(projectId).map((track) => ({
    id: track.id,
    type: track.type,
    order: track.order,
    muted: track.muted,
    visible: track.visible,
    isComposite: track.isComposite,
  }));
  const clips = listClips(projectId).map((clip) => ({
    id: clip.id,
    trackId: clip.trackId,
    sourceType: clip.sourceType,
    sourcePath: clip.sourcePath,
    sourceAssetId: clip.sourceAssetId,
    startTime: clip.startTime,
    duration: clip.duration,
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd,
    speed: clip.speed,
    transformOffsetX: clip.transformOffsetX,
    transformOffsetY: clip.transformOffsetY,
    transformScale: clip.transformScale,
    rotationZ: clip.rotationZ,
    opacity: clip.opacity,
    brightness: clip.brightness,
    contrast: clip.contrast,
    saturation: clip.saturation,
    adjustments: normalizeClipAdjustments(clip.adjustments),
    fadeInDuration: clip.fadeInDuration,
    fadeOutDuration: clip.fadeOutDuration,
  }));

  return computeHash({ tracks, clips });
}

export function buildCurrentSequencePreviewRequest(
  projectId: string,
): ComposerSequencePreviewRequest {
  const settings = getProjectSequencePreviewSettings(projectId);
  return {
    version: SEQUENCE_PREVIEW_REQUEST_VERSION,
    timelineSignature: computeProjectTimelineSignature(projectId),
    duration: settings.duration,
    fps: settings.fps,
    projectWidth: settings.width,
    projectHeight: settings.height,
    playbackQuality: settings.playbackQuality,
  };
}

function buildCurrentSequencePreviewPlan(projectId: string): SequencePreviewRenderPlan {
  const request = buildCurrentSequencePreviewRequest(projectId);
  const requestSignature = computeHash(request);
  return {
    request,
    requestSignature,
    outputPath: getProjectSequencePreviewFilePath(projectId, requestSignature),
  };
}

function buildBaseSequencePreviewRecord(
  projectId: string,
  status: ComposerSequencePreview["status"],
  invalidationReasons: ComposerSequencePreviewInvalidationCause[],
  current?: ComposerSequencePreview,
  errorMessage?: string,
): ComposerSequencePreview {
  const now = new Date().toISOString();
  const plan = buildCurrentSequencePreviewPlan(projectId);
  const shouldPreserveRequestTimestamps =
    current?.requestSignature === plan.requestSignature;

  return {
    status,
    requestSignature: plan.requestSignature,
    request: plan.request,
    filePath: plan.outputPath,
    playbackQuality: plan.request.playbackQuality,
    invalidationReasons,
    errorMessage,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    lastRequestedAt: shouldPreserveRequestTimestamps
      ? current?.lastRequestedAt
      : undefined,
    startedAt: shouldPreserveRequestTimestamps ? current?.startedAt : undefined,
    completedAt: shouldPreserveRequestTimestamps
      ? current?.completedAt
      : undefined,
    invalidatedAt:
      invalidationReasons.length > 0 || status === "stale"
        ? now
        : current?.invalidatedAt,
  };
}

function areRequestsEqual(
  left: ComposerSequencePreviewRequest,
  right: ComposerSequencePreviewRequest,
): boolean {
  return (
    left.version === right.version &&
    left.timelineSignature === right.timelineSignature &&
    left.duration === right.duration &&
    left.fps === right.fps &&
    left.projectWidth === right.projectWidth &&
    left.projectHeight === right.projectHeight &&
    left.playbackQuality === right.playbackQuality
  );
}

function deriveInvalidationReasons(
  previous: ComposerSequencePreview | null,
  currentRequest: ComposerSequencePreviewRequest,
): ComposerSequencePreviewInvalidationCause[] {
  if (!previous) {
    return [];
  }

  const reasons = new Set<ComposerSequencePreviewInvalidationCause>();
  const previousRequest = previous.request;

  if (
    !previousRequest ||
    previousRequest.timelineSignature !== currentRequest.timelineSignature ||
    previousRequest.duration !== currentRequest.duration ||
    previousRequest.fps !== currentRequest.fps
  ) {
    reasons.add("timeline");
  }
  if (
    !previousRequest ||
    previousRequest.projectWidth !== currentRequest.projectWidth ||
    previousRequest.projectHeight !== currentRequest.projectHeight
  ) {
    reasons.add("dimensions");
  }
  if (
    !previousRequest ||
    previousRequest.playbackQuality !== currentRequest.playbackQuality
  ) {
    reasons.add("playback-quality");
  }

  return [...reasons];
}

function getOrCreateJobState(projectId: string): ProjectSequencePreviewJobState {
  const current = activeSequencePreviewJobs.get(projectId);
  if (current) {
    return current;
  }
  const created: ProjectSequencePreviewJobState = {
    running: false,
    rerunRequested: false,
    scheduledTimer: null,
  };
  activeSequencePreviewJobs.set(projectId, created);
  return created;
}

function isSequencePreviewJobActive(projectId: string): boolean {
  return activeSequencePreviewJobs.get(projectId)?.running === true;
}

function clearScheduledSequencePreviewRefresh(projectId: string): void {
  const jobState = activeSequencePreviewJobs.get(projectId);
  if (!jobState?.scheduledTimer) {
    return;
  }

  clearTimeout(jobState.scheduledTimer);
  jobState.scheduledTimer = null;
}

function shouldRefreshProjectSequencePreview(
  projectId: string,
  current: ComposerSequencePreview,
): boolean {
  return (
    current.status === "missing" ||
    current.status === "stale" ||
    (current.status === "processing" && !isSequencePreviewJobActive(projectId))
  );
}

function maybeStopSequencePreviewReconcileLoop(): void {
  if (
    trackedSequencePreviewProjects.size > 0 ||
    sequencePreviewReconcileTimer == null
  ) {
    return;
  }

  clearInterval(sequencePreviewReconcileTimer);
  sequencePreviewReconcileTimer = null;
}

function reconcileProjectSequencePreview(projectId: string): void {
  const current = getProjectSequencePreview(projectId);
  if (!shouldRefreshProjectSequencePreview(projectId, current)) {
    return;
  }

  scheduleProjectSequencePreviewRefresh(projectId, { debounceMs: 0 });
}

function ensureSequencePreviewReconcileLoop(): void {
  if (sequencePreviewReconcileTimer != null) {
    return;
  }

  sequencePreviewReconcileTimer = setInterval(() => {
    for (const projectId of [...trackedSequencePreviewProjects]) {
      try {
        reconcileProjectSequencePreview(projectId);
      } catch {
        disposeProjectSequencePreview(projectId);
      }
    }
  }, SEQUENCE_PREVIEW_RECONCILE_INTERVAL_MS);

  sequencePreviewReconcileTimer.unref?.();
}

function trackProjectSequencePreview(projectId: string): void {
  trackedSequencePreviewProjects.add(projectId);
  ensureSequencePreviewReconcileLoop();
}

export function disposeProjectSequencePreview(projectId: string): void {
  clearScheduledSequencePreviewRefresh(projectId);
  activeSequencePreviewJobs.delete(projectId);
  trackedSequencePreviewProjects.delete(projectId);
  maybeStopSequencePreviewReconcileLoop();
}

export function getProjectSequencePreview(
  projectId: string,
): ComposerSequencePreview {
  trackProjectSequencePreview(projectId);
  const stored = getStoredSequencePreview(projectId);
  const currentPlan = buildCurrentSequencePreviewPlan(projectId);

  if (!stored) {
    const created = buildBaseSequencePreviewRecord(projectId, "missing", []);
    return saveStoredSequencePreview(projectId, created);
  }

  const currentMatchesStored =
    stored.requestSignature.length > 0 &&
    areRequestsEqual(stored.request, currentPlan.request) &&
    stored.requestSignature === currentPlan.requestSignature;

  if (!currentMatchesStored) {
    if (stored.requestSignature.length === 0 && stored.status === "missing") {
      const initialized = buildBaseSequencePreviewRecord(
        projectId,
        "missing",
        [],
        stored,
      );
      return saveStoredSequencePreview(projectId, initialized);
    }

    const invalidationReasons = deriveInvalidationReasons(
      stored,
      currentPlan.request,
    );
    const nextStatus =
      stored.status === "missing" && !stored.filePath && !stored.completedAt
        ? "missing"
        : "stale";
    const reconciled = buildBaseSequencePreviewRecord(
      projectId,
      nextStatus,
      invalidationReasons,
      stored,
    );
    return saveStoredSequencePreview(projectId, reconciled);
  }

  if (
    stored.status === "ready" &&
    stored.filePath &&
    !existsSync(stored.filePath)
  ) {
    const missing = buildBaseSequencePreviewRecord(
      projectId,
      "missing",
      [],
      stored,
    );
    return saveStoredSequencePreview(projectId, missing);
  }

  if (
    stored.filePath !==
    getProjectSequencePreviewFilePath(projectId, stored.requestSignature)
  ) {
    const normalized = {
      ...stored,
      filePath: getProjectSequencePreviewFilePath(projectId, stored.requestSignature),
    };
    const saved = saveStoredSequencePreview(projectId, normalized);
    pruneProjectSequencePreviewCacheForCurrent(projectId, saved);
    return saved;
  }

  pruneProjectSequencePreviewCacheForCurrent(projectId, stored);
  return stored;
}

export function invalidateProjectSequencePreview(
  projectId: string,
  causes: ComposerSequencePreviewInvalidationCause[],
): ComposerSequencePreview {
  const current = getProjectSequencePreview(projectId);
  const dedupedCauses = Array.from(
    new Set([...current.invalidationReasons, ...causes]),
  );
  const nextStatus =
    current.status === "missing" && !current.completedAt && !current.startedAt
      ? "missing"
      : "stale";
  const invalidated = buildBaseSequencePreviewRecord(
    projectId,
    nextStatus,
    dedupedCauses,
    current,
  );
  return saveStoredSequencePreview(projectId, invalidated);
}

function markProjectSequencePreviewProcessing(
  projectId: string,
  current: ComposerSequencePreview,
): ComposerSequencePreview {
  const now = new Date().toISOString();
  return saveStoredSequencePreview(projectId, {
    ...current,
    status: "processing",
    errorMessage: undefined,
    invalidationReasons: [],
    updatedAt: now,
    lastRequestedAt: now,
    startedAt: now,
    filePath:
      current.filePath ??
      getProjectSequencePreviewFilePath(projectId, current.requestSignature),
  });
}

function markProjectSequencePreviewReadyForSignature(
  projectId: string,
  requestSignature: string,
  filePath: string,
): ComposerSequencePreview {
  const current = getProjectSequencePreview(projectId);
  if (current.requestSignature !== requestSignature) {
    return current;
  }
  const now = new Date().toISOString();
  return saveStoredSequencePreview(projectId, {
    ...current,
    status: "ready",
    filePath,
    errorMessage: undefined,
    invalidationReasons: [],
    updatedAt: now,
    completedAt: now,
  });
}

function markProjectSequencePreviewErrorForSignature(
  projectId: string,
  requestSignature: string,
  errorMessage: string,
): ComposerSequencePreview {
  const current = getProjectSequencePreview(projectId);
  if (current.requestSignature !== requestSignature) {
    return current;
  }
  const now = new Date().toISOString();
  return saveStoredSequencePreview(projectId, {
    ...current,
    status: "error",
    errorMessage,
    invalidationReasons: [],
    updatedAt: now,
    completedAt: now,
    lastRequestedAt: current.lastRequestedAt ?? now,
  });
}

function runFfprobe(filePath: string): Promise<MediaProbeResult | null> {
  return new Promise<MediaProbeResult | null>((resolve) => {
    const proc = spawn("ffprobe", [
      "-v",
      "quiet",
      "-of",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ], {
      windowsHide: true,
    });

    let stdout = "";
    let settled = false;

    const finish = (value: MediaProbeResult | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.once("error", () => finish(null));
    proc.once("exit", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as {
          streams?: Array<{
            codec_type?: string;
            width?: number;
            height?: number;
            duration?: string;
          }>;
          format?: { duration?: string };
        };
        const streams = parsed.streams ?? [];
        const videoStream = streams.find((stream) => stream.codec_type === "video");
        const audioStream = streams.find((stream) => stream.codec_type === "audio");
        const durationCandidates = [
          parsed.format?.duration,
          videoStream?.duration,
          audioStream?.duration,
        ]
          .map((value) => (value != null ? Number(value) : null))
          .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);

        finish({
          hasVideo: videoStream != null,
          hasAudio: audioStream != null,
          width: videoStream?.width ?? null,
          height: videoStream?.height ?? null,
          duration: durationCandidates[0] ?? null,
        });
      } catch {
        finish(null);
      }
    });
  });
}

function buildAtempoFilter(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0) {
    return "atempo=1";
  }

  const filters: string[] = [];
  let remaining = speed;

  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }

  filters.push(`atempo=${remaining.toFixed(5)}`);
  return filters.join(",");
}

function buildClipSourceDuration(clip: Clip, probe: MediaProbeResult | null): number {
  const desiredSourceDuration = clip.duration * Math.max(clip.speed, 0.01);
  if (!probe?.duration || clip.trimEnd == null) {
    return clampClipDuration(desiredSourceDuration);
  }

  const availableDuration = Math.max(
    0,
    probe.duration - clip.trimStart - Math.max(clip.trimEnd, 0),
  );
  return clampClipDuration(Math.min(desiredSourceDuration, availableDuration));
}

function computeRenderedVideoPlacement(
  probe: MediaProbeResult | null,
  outputWidth: number,
  outputHeight: number,
  projectWidth: number,
  projectHeight: number,
  clip: Clip,
): { width: number; height: number; x: number; y: number } {
  const sourceWidth = probe?.width && probe.width > 0 ? probe.width : projectWidth;
  const sourceHeight = probe?.height && probe.height > 0 ? probe.height : projectHeight;
  return getComposedClipRect(
    { width: sourceWidth, height: sourceHeight },
    { width: outputWidth, height: outputHeight },
    { width: projectWidth, height: projectHeight },
    clip,
  );
}

function formatFilterNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return value.toFixed(4).replace(/\.?0+$/, "");
}

async function resolveClipMediaSource(
  clip: Clip,
  assetsMetadata: ReturnType<typeof loadAssetMetadata>,
  probeCache: Map<string, Promise<MediaProbeResult | null>>,
): Promise<ResolvedPreviewMediaSource | null> {
  const sourcePath = clip.sourcePath;
  if (!sourcePath) {
    return null;
  }

  const assetMetadata = assetsMetadata[sourcePath];
  const candidatePaths = [
    assetMetadata?.workingPath,
    sourcePath,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const selectedPath = candidatePaths.find((value) => existsSync(value));
  if (!selectedPath) {
    return null;
  }

  const extension = extname(selectedPath).toLowerCase();
  const inputKind = IMAGE_EXTS.has(extension) ? "image" : "media";
  const cachedProbe = probeCache.get(selectedPath) ?? runFfprobe(selectedPath);
  probeCache.set(selectedPath, cachedProbe);

  return {
    path: selectedPath,
    probe: await cachedProbe,
    inputKind,
  };
}

async function renderProjectSequencePreview(
  projectId: string,
  plan: SequencePreviewRenderPlan,
): Promise<void> {
  await ensureComposerFfmpegToolsAvailable();

  const tracks = listTracks(projectId);
  const clips = listClips(projectId);
  const trackMap = new Map(tracks.map((track) => [track.id, track]));
  const assetsMetadata = loadAssetMetadata(getProjectAssetsDir(projectId));
  const probeCache = new Map<string, Promise<MediaProbeResult | null>>();
  const outputDimensions = getSequencePreviewOutputDimensions(plan.request);
  const outputDuration = clampClipDuration(plan.request.duration);
  const ffmpegArgs: string[] = [
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${outputDimensions.width}x${outputDimensions.height}:r=${plan.request.fps}:d=${outputDuration}`,
  ];
  const filterLines: string[] = ["[0:v]format=rgba[v0]"];
  const audioLabels: string[] = [];
  let videoCompositeLabel = "v0";
  let inputIndex = 1;

  const orderedClips = clips
    .map((clip) => ({ clip, track: trackMap.get(clip.trackId) }))
    .filter((entry): entry is { clip: Clip; track: Track } => entry.track != null)
    .sort((left, right) => {
      if (left.track.order !== right.track.order) {
        return right.track.order - left.track.order;
      }
      if (left.clip.startTime !== right.clip.startTime) {
        return left.clip.startTime - right.clip.startTime;
      }
      return left.clip.createdAt.localeCompare(right.clip.createdAt);
    });

  for (const { clip, track } of orderedClips) {
    if (!clip.sourcePath || clip.duration <= 0 || clip.startTime >= plan.request.duration) {
      continue;
    }

      const resolvedSource = await resolveClipMediaSource(
        clip,
        assetsMetadata,
        probeCache,
      );
    if (!resolvedSource) {
      continue;
    }

    const clipVisibleDuration = clampClipDuration(
      Math.min(clip.duration, Math.max(0.04, plan.request.duration - clip.startTime)),
    );
    const clipSourceDuration =
      resolvedSource.inputKind === "image"
        ? clipVisibleDuration
        : buildClipSourceDuration(clip, resolvedSource.probe);
    const clipRenderedDuration = computeClipRenderedDuration(
      clip,
      clipSourceDuration,
      clipVisibleDuration,
      resolvedSource.inputKind,
    );
    const inputPath = resolvedSource.path;

    if (resolvedSource.inputKind === "image") {
      ffmpegArgs.push("-loop", "1", "-t", String(clipVisibleDuration), "-i", inputPath);
    } else {
      if (clip.trimStart > 0) {
        ffmpegArgs.push("-ss", String(clip.trimStart));
      }
      ffmpegArgs.push("-t", String(clipSourceDuration), "-i", inputPath);
    }

    const currentInputIndex = inputIndex;
    inputIndex += 1;

    if (track.type === "video" && track.visible && resolvedSource.probe?.hasVideo !== false) {
      const clipAdjustments = normalizeClipAdjustments(clip.adjustments);
      const placement = computeRenderedVideoPlacement(
        resolvedSource.probe,
        outputDimensions.width,
        outputDimensions.height,
        plan.request.projectWidth,
        plan.request.projectHeight,
        clip,
      );
      const sourceVideoLabel = `srcv${currentInputIndex}`;
      const nextCompositeLabel = `v${currentInputIndex}`;
      const visualOpacity = clampOpacity(clip.opacity);
      const fadeInDuration = clampFadeDuration(
        clip.fadeInDuration,
        clipRenderedDuration,
      );
      const fadeOutDuration = clampFadeDuration(
        clip.fadeOutDuration,
        Math.max(0, clipRenderedDuration - fadeInDuration),
      );
      const overlayCenterX = placement.x + placement.width / 2;
      const overlayCenterY = placement.y + placement.height / 2;
      const setPtsExpr =
        clip.speed !== 1
          ? `(PTS-STARTPTS)/${Math.max(clip.speed, 0.01)}+${clip.startTime}/TB`
          : `PTS-STARTPTS+${clip.startTime}/TB`;
      const videoFilters = [
        `setpts=${setPtsExpr}`,
        `scale=${formatFilterNumber(placement.width)}:${formatFilterNumber(placement.height)}:flags=lanczos`,
        "setsar=1",
        ...buildClipAdjustmentFilters(projectId, clip),
        "format=rgba",
      ];
      if (fadeInDuration > 0) {
        videoFilters.push(
          `fade=t=in:st=${formatFilterNumber(clip.startTime)}:d=${formatFilterNumber(fadeInDuration)}:alpha=1`,
        );
      }
      if (fadeOutDuration > 0) {
        videoFilters.push(
          `fade=t=out:st=${formatFilterNumber(clip.startTime + clipRenderedDuration - fadeOutDuration)}:d=${formatFilterNumber(fadeOutDuration)}:alpha=1`,
        );
      }
      if (visualOpacity !== 1) {
        videoFilters.push(`colorchannelmixer=aa=${formatFilterNumber(visualOpacity)}`);
      }
      if (clip.rotationZ !== 0) {
        videoFilters.push(
          `rotate=${formatFilterNumber((clip.rotationZ * Math.PI) / 180)}:ow='rotw(iw)':oh='roth(ih)':c=none`,
        );
      }
      filterLines.push(
        `[${currentInputIndex}:v]${videoFilters.join(",")}[${sourceVideoLabel}]`,
      );
      const blendMode = getFfmpegBlendMode(clipAdjustments.blendMode);
      if (blendMode) {
        const clipCanvasLabel = `layer${currentInputIndex}`;
        const blendLabel = `blend${currentInputIndex}`;
        const maskedLabel = `masked${currentInputIndex}`;
        const maskLabel = `mask${currentInputIndex}`;
        filterLines.push(
          `color=c=black@0.0:s=${outputDimensions.width}x${outputDimensions.height}:r=${plan.request.fps}:d=${outputDuration},format=rgba[blank${currentInputIndex}]`,
        );
        filterLines.push(
          `[blank${currentInputIndex}][${sourceVideoLabel}]overlay=${formatFilterNumber(overlayCenterX)}-w/2:${formatFilterNumber(overlayCenterY)}-h/2:eof_action=pass:repeatlast=0[${clipCanvasLabel}]`,
        );
        filterLines.push(`[${clipCanvasLabel}]alphaextract[${maskLabel}]`);
        filterLines.push(
          `[${clipCanvasLabel}][${videoCompositeLabel}]blend=all_mode=${blendMode}:c3_mode=normal[${blendLabel}]`,
        );
        filterLines.push(
          `[${videoCompositeLabel}][${blendLabel}][${maskLabel}]maskedmerge[${maskedLabel}]`,
        );
        videoCompositeLabel = maskedLabel;
      } else {
        filterLines.push(
          `[${videoCompositeLabel}][${sourceVideoLabel}]overlay=${formatFilterNumber(overlayCenterX)}-w/2:${formatFilterNumber(overlayCenterY)}-h/2:eof_action=pass:repeatlast=0[${nextCompositeLabel}]`,
        );
        videoCompositeLabel = nextCompositeLabel;
      }
    }

    if (!track.muted && resolvedSource.probe?.hasAudio) {
      const baseAudioLabel = `srca${currentInputIndex}`;
      const delayedAudioLabel = `a${currentInputIndex}`;
      const audioFilters = [`atrim=duration=${clipSourceDuration}`, "asetpts=PTS-STARTPTS"];
      if (clip.speed !== 1) {
        audioFilters.push(buildAtempoFilter(Math.max(clip.speed, 0.01)));
      }
      const audioFadeInDuration = clampFadeDuration(
        clip.fadeInDuration,
        clipRenderedDuration,
      );
      const audioFadeOutDuration = clampFadeDuration(
        clip.fadeOutDuration,
        Math.max(0, clipRenderedDuration - audioFadeInDuration),
      );
      if (audioFadeInDuration > 0) {
        audioFilters.push(
          `afade=t=in:st=0:d=${formatFilterNumber(audioFadeInDuration)}`,
        );
      }
      if (audioFadeOutDuration > 0) {
        audioFilters.push(
          `afade=t=out:st=${formatFilterNumber(clipRenderedDuration - audioFadeOutDuration)}:d=${formatFilterNumber(audioFadeOutDuration)}`,
        );
      }
      audioFilters.push(`adelay=${Math.max(0, Math.round(clip.startTime * 1000))}:all=1`);
      filterLines.push(
        `[${currentInputIndex}:a]${audioFilters.join(",")}[${baseAudioLabel}]`,
      );
      filterLines.push(`[${baseAudioLabel}]anull[${delayedAudioLabel}]`);
      audioLabels.push(delayedAudioLabel);
    }
  }

  if (audioLabels.length === 1) {
    filterLines.push(`[${audioLabels[0]}]anull[aout]`);
  } else if (audioLabels.length > 1) {
    filterLines.push(
      `${audioLabels.map((label) => `[${label}]`).join("")}amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0,aresample=async=1:first_pts=0[aout]`,
    );
  }

  const encodeProfile = SEQUENCE_PREVIEW_ENCODE_PROFILES[plan.request.playbackQuality];
  if (existsSync(plan.outputPath)) {
    try {
      rmSync(plan.outputPath, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }

  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const proc = spawn(
      "ffmpeg",
      [
        ...ffmpegArgs,
        "-filter_complex",
        filterLines.join(";"),
        "-map",
        `[${videoCompositeLabel}]`,
        ...(audioLabels.length > 0 ? ["-map", "[aout]"] : ["-an"]),
        "-r",
        String(plan.request.fps),
        "-t",
        String(outputDuration),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
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
        "-movflags",
        "+faststart",
        ...(audioLabels.length > 0
          ? ["-c:a", "aac", "-b:a", encodeProfile.audioBitrate]
          : []),
        "-y",
        plan.outputPath,
      ],
      {
        windowsHide: true,
      },
    );

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.once("error", (error) => {
      reject(error);
    });

    proc.once("exit", (code) => {
      if (code === 0 && existsSync(plan.outputPath)) {
        resolve();
        return;
      }
      reject(new Error(stderr || `FFmpeg exited with code ${code}`));
    });
  });
}

async function runProjectSequencePreviewJob(
  projectId: string,
  plan: SequencePreviewRenderPlan,
): Promise<void> {
  try {
    await renderProjectSequencePreview(projectId, plan);
    const readyPreview = markProjectSequencePreviewReadyForSignature(
      projectId,
      plan.requestSignature,
      plan.outputPath,
    );
    if (
      readyPreview.status === "ready" &&
      readyPreview.requestSignature === plan.requestSignature &&
      readyPreview.filePath === plan.outputPath
    ) {
      pruneProjectSequencePreviewCache(projectId, plan.outputPath);
    } else if (existsSync(plan.outputPath)) {
      rmSync(plan.outputPath, { force: true });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to generate sequence preview";
    try {
      if (existsSync(plan.outputPath)) {
        rmSync(plan.outputPath, { force: true });
      }
    } catch {
      /* ignore cleanup failure */
    }
    markProjectSequencePreviewErrorForSignature(
      projectId,
      plan.requestSignature,
      message,
    );
  }
}

function startProjectSequencePreviewJob(projectId: string): ComposerSequencePreview {
  const current = getProjectSequencePreview(projectId);
  const processing = markProjectSequencePreviewProcessing(projectId, current);
  const plan: SequencePreviewRenderPlan = {
    request: processing.request,
    requestSignature: processing.requestSignature,
    outputPath:
      processing.filePath ??
      getProjectSequencePreviewFilePath(projectId, processing.requestSignature),
  };
  const jobState = getOrCreateJobState(projectId);
  clearScheduledSequencePreviewRefresh(projectId);
  jobState.running = true;
  jobState.rerunRequested = false;

  void runProjectSequencePreviewJob(projectId, plan)
    .catch((error) => {
      console.error(
        `[Composer] Sequence preview job failed for project ${projectId}:`,
        error,
      );
    })
    .finally(() => {
      const latestState = getOrCreateJobState(projectId);
      latestState.running = false;
      if (!trackedSequencePreviewProjects.has(projectId)) {
        activeSequencePreviewJobs.delete(projectId);
        return;
      }
      const needsRerun =
        latestState.rerunRequested ||
        (() => {
          try {
            const latestPreview = getProjectSequencePreview(projectId);
            return latestPreview.status === "missing" || latestPreview.status === "stale";
          } catch {
            return false;
          }
        })();
      latestState.rerunRequested = false;

      if (needsRerun) {
        try {
          scheduleProjectSequencePreviewRefresh(projectId);
        } catch (error) {
          console.error(
            `[Composer] Failed to restart sequence preview job for project ${projectId}:`,
            error,
          );
        }
      }
    });

  return processing;
}

export function scheduleProjectSequencePreviewRefresh(
  projectId: string,
  options: {
    debounceMs?: number;
  } = {},
): ComposerSequencePreview {
  trackProjectSequencePreview(projectId);
  const current = getProjectSequencePreview(projectId);
  const needsWork = shouldRefreshProjectSequencePreview(projectId, current);

  if (!needsWork) {
    clearScheduledSequencePreviewRefresh(projectId);
    return current;
  }

  const jobState = getOrCreateJobState(projectId);
  if (jobState.running) {
    jobState.rerunRequested = true;
    return current;
  }

  const debounceMs =
    current.status === "processing"
      ? 0
      : Math.max(0, options.debounceMs ?? SEQUENCE_PREVIEW_EDIT_DEBOUNCE_MS);

  if (debounceMs === 0) {
    clearScheduledSequencePreviewRefresh(projectId);
    return startProjectSequencePreviewJob(projectId);
  }

  clearScheduledSequencePreviewRefresh(projectId);
  jobState.scheduledTimer = setTimeout(() => {
    jobState.scheduledTimer = null;

    try {
      const latest = getProjectSequencePreview(projectId);
      if (!shouldRefreshProjectSequencePreview(projectId, latest)) {
        return;
      }
      if (jobState.running) {
        jobState.rerunRequested = true;
        return;
      }
      startProjectSequencePreviewJob(projectId);
    } catch (error) {
      console.error(
        `[Composer] Failed to schedule sequence preview job for project ${projectId}:`,
        error,
      );
    }
  }, debounceMs);
  jobState.scheduledTimer.unref?.();

  return current;
}

export function ensureProjectSequencePreview(
  projectId: string,
): ComposerSequencePreview {
  return scheduleProjectSequencePreviewRefresh(projectId, { debounceMs: 0 });
}
