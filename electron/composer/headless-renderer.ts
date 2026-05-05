import { app, BrowserWindow, ipcMain } from "electron";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import type {
  RenderSegmentProgress,
  RenderSegmentRequest,
} from "./sequence-preview-contract";

interface PendingSegmentResult {
  resolve: (buffer: Buffer) => void;
  reject: (error: Error) => void;
}

let headlessRendererWindow: BrowserWindow | null = null;
let createRendererPromise: Promise<BrowserWindow> | null = null;
let headlessTempHtmlPath: string | null = null;
let requestCounter = 0;
let ipcRegistered = false;
const pendingSegmentResults = new Map<string, PendingSegmentResult>();
let progressListener: ((progress: RenderSegmentProgress) => void) | null = null;

function buildHeadlessRendererHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Composer Headless Renderer</title>
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: #000;
        overflow: hidden;
      }
      canvas {
        display: block;
      }
    </style>
  </head>
  <body>
    <canvas id="composer-headless-canvas"></canvas>
    <script>
      const { ipcRenderer } = require('electron');
      const { pathToFileURL } = require('node:url');

      const canvas = document.getElementById('composer-headless-canvas');
      const imageCache = new Map();
      const videoCache = new Map();
      const audioCache = new Map();

      function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
      }

      function fileUrlFromPath(filePath) {
        return pathToFileURL(filePath).toString();
      }

      function waitForEvent(target, eventName) {
        return new Promise((resolve, reject) => {
          const handleEvent = () => {
            cleanup();
            resolve();
          };
          const handleError = () => {
            cleanup();
            reject(new Error('Failed while waiting for ' + eventName));
          };
          const cleanup = () => {
            target.removeEventListener(eventName, handleEvent);
            target.removeEventListener('error', handleError);
          };
          target.addEventListener(eventName, handleEvent, { once: true });
          target.addEventListener('error', handleError, { once: true });
        });
      }

      async function loadImage(sourcePath) {
        if (!imageCache.has(sourcePath)) {
          imageCache.set(sourcePath, new Promise((resolve, reject) => {
            const image = new Image();
            image.decoding = 'async';
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('Failed to load image: ' + sourcePath));
            image.src = fileUrlFromPath(sourcePath);
          }));
        }
        return imageCache.get(sourcePath);
      }

      async function loadVideo(sourcePath) {
        if (!videoCache.has(sourcePath)) {
          videoCache.set(sourcePath, new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.muted = true;
            video.preload = 'auto';
            video.playsInline = true;
            video.autoplay = false;
            video.src = fileUrlFromPath(sourcePath);

            const cleanup = () => {
              video.removeEventListener('loadedmetadata', handleReady);
              video.removeEventListener('canplay', handleReady);
              video.removeEventListener('error', handleError);
            };
            const handleReady = () => {
              cleanup();
              resolve(video);
            };
            const handleError = () => {
              cleanup();
              reject(new Error('Failed to load video: ' + sourcePath));
            };

            video.addEventListener('loadedmetadata', handleReady, { once: true });
            video.addEventListener('canplay', handleReady, { once: true });
            video.addEventListener('error', handleError, { once: true });
          }));
        }
        return videoCache.get(sourcePath);
      }

      async function loadAudioBuffer(sourcePath) {
        if (!audioCache.has(sourcePath)) {
          audioCache.set(sourcePath, (async () => {
            const response = await fetch(fileUrlFromPath(sourcePath));
            if (!response.ok) {
              throw new Error('Failed to read audio source: ' + sourcePath);
            }
            const data = await response.arrayBuffer();
            const context = new AudioContext();
            try {
              return await context.decodeAudioData(data.slice(0));
            } finally {
              await context.close();
            }
          })());
        }

        try {
          return await audioCache.get(sourcePath);
        } catch {
          return null;
        }
      }

      async function seekVideo(video, targetTime) {
        const boundedTime = Math.max(0, targetTime);
        if (Math.abs(video.currentTime - boundedTime) < 0.001) {
          return;
        }
        const seekPromise = waitForEvent(video, 'seeked');
        video.currentTime = boundedTime;
        await seekPromise;
      }

      function computeClipAlpha(clip, globalTime) {
        let alpha = clamp(Number.isFinite(clip.opacity) ? clip.opacity : 1, 0, 1);
        const clipLocalTime = globalTime - clip.startTime;

        if (clip.fadeInDuration > 0 && clipLocalTime < clip.fadeInDuration) {
          alpha *= clamp(clipLocalTime / clip.fadeInDuration, 0, 1);
        }

        const fadeOutStart = clip.renderedDuration - clip.fadeOutDuration;
        if (clip.fadeOutDuration > 0 && clipLocalTime > fadeOutStart) {
          alpha *= clamp(
            (clip.renderedDuration - clipLocalTime) / clip.fadeOutDuration,
            0,
            1,
          );
        }

        return alpha;
      }

      function getActiveVisualClips(clips, globalTime) {
        return clips.filter((clip) => {
          if (!clip.hasVisual || !clip.rect) {
            return false;
          }
          return (
            globalTime >= clip.startTime &&
            globalTime < clip.startTime + clip.renderedDuration
          );
        });
      }

      async function renderFrame(ctx, request, globalTime) {
        ctx.clearRect(0, 0, request.outputWidth, request.outputHeight);
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, request.outputWidth, request.outputHeight);

        const clips = getActiveVisualClips(request.clips, globalTime);

        for (const clip of clips) {
          const rect = clip.rect;
          const alpha = computeClipAlpha(clip, globalTime);
          if (!rect || alpha <= 0) {
            continue;
          }

          ctx.save();
          ctx.globalCompositeOperation = clip.blendMode || 'source-over';
          ctx.globalAlpha = alpha;
          ctx.filter = clip.filter || 'none';

          const centerX = rect.x + rect.width / 2;
          const centerY = rect.y + rect.height / 2;
          ctx.translate(centerX, centerY);
          if (clip.rotation) {
            ctx.rotate((clip.rotation * Math.PI) / 180);
          }

          if (clip.inputKind === 'image') {
            const image = await loadImage(clip.sourcePath);
            ctx.drawImage(
              image,
              -rect.width / 2,
              -rect.height / 2,
              rect.width,
              rect.height,
            );
          } else {
            const video = await loadVideo(clip.sourcePath);
            const clipLocalTime = Math.max(0, globalTime - clip.startTime);
            const rawSourceTime = clip.trimStart + clipLocalTime * Math.max(clip.speed, 0.01);
            const maxSeekTime =
              typeof clip.sourceDuration === 'number' && clip.sourceDuration > 0
                ? Math.max(0, clip.sourceDuration - 0.001)
                : rawSourceTime;
            await seekVideo(video, Math.min(rawSourceTime, maxSeekTime));
            ctx.drawImage(
              video,
              -rect.width / 2,
              -rect.height / 2,
              rect.width,
              rect.height,
            );
          }

          ctx.restore();
        }
      }

      function setGainAutomation(gainNode, clip, segmentStartTime, segmentDuration, overlapStart, overlapEnd) {
        const segmentLocalStart = overlapStart - segmentStartTime;
        const segmentLocalEnd = overlapEnd - segmentStartTime;
        const clipLocalStart = overlapStart - clip.startTime;
        const clipLocalEnd = overlapEnd - clip.startTime;
        const fadeOutStart = clip.renderedDuration - clip.fadeOutDuration;

        const gainAt = (clipLocalTime) => {
          let value = 1;
          if (clip.fadeInDuration > 0 && clipLocalTime < clip.fadeInDuration) {
            value *= clamp(clipLocalTime / clip.fadeInDuration, 0, 1);
          }
          if (clip.fadeOutDuration > 0 && clipLocalTime > fadeOutStart) {
            value *= clamp((clip.renderedDuration - clipLocalTime) / clip.fadeOutDuration, 0, 1);
          }
          return clamp(value, 0, 1);
        };

        gainNode.gain.setValueAtTime(gainAt(clipLocalStart), segmentLocalStart);
        gainNode.gain.setValueAtTime(gainAt(clipLocalStart), segmentLocalStart);

        if (
          clip.fadeInDuration > 0 &&
          clipLocalStart < clip.fadeInDuration &&
          clipLocalEnd > clipLocalStart
        ) {
          const fadeInEnd = Math.min(segmentLocalEnd, segmentLocalStart + (clip.fadeInDuration - clipLocalStart));
          gainNode.gain.linearRampToValueAtTime(gainAt(clip.fadeInDuration), fadeInEnd);
        }

        if (
          clip.fadeOutDuration > 0 &&
          clipLocalEnd > fadeOutStart &&
          clipLocalEnd > clipLocalStart
        ) {
          const fadeOutSegmentStart = Math.max(segmentLocalStart, clip.startTime + fadeOutStart - segmentStartTime);
          gainNode.gain.setValueAtTime(gainAt(fadeOutStart), fadeOutSegmentStart);
          gainNode.gain.linearRampToValueAtTime(0, Math.min(segmentDuration, segmentLocalEnd));
        } else {
          gainNode.gain.setValueAtTime(gainAt(clipLocalEnd), segmentLocalEnd);
        }
      }

      async function renderAudioBuffer(request, segmentDuration) {
        const audioClips = request.clips.filter((clip) => clip.hasAudio);
        if (audioClips.length === 0) {
          return null;
        }

        const sampleRate = 48000;
        const frameCount = Math.max(1, Math.ceil(segmentDuration * sampleRate));
        const offline = new OfflineAudioContext({
          numberOfChannels: 2,
          length: frameCount,
          sampleRate,
        });

        let hasScheduledAudio = false;

        for (const clip of audioClips) {
          const overlapStart = Math.max(request.startTime, clip.startTime);
          const overlapEnd = Math.min(
            request.endTime,
            clip.startTime + clip.renderedDuration,
          );

          if (overlapEnd <= overlapStart) {
            continue;
          }

          const decoded = await loadAudioBuffer(clip.sourcePath);
          if (!decoded) {
            continue;
          }

          const source = offline.createBufferSource();
          source.buffer = decoded;
          source.playbackRate.value = Math.max(clip.speed, 0.01);

          const gainNode = offline.createGain();
          source.connect(gainNode);
          gainNode.connect(offline.destination);

          const offset = clip.trimStart + Math.max(0, overlapStart - clip.startTime) * Math.max(clip.speed, 0.01);
          const duration = overlapEnd - overlapStart;
          setGainAutomation(
            gainNode,
            clip,
            request.startTime,
            segmentDuration,
            overlapStart,
            overlapEnd,
          );
          source.start(overlapStart - request.startTime, offset, duration);
          hasScheduledAudio = true;
        }

        if (!hasScheduledAudio) {
          return null;
        }

        return offline.startRendering();
      }

      function getVideoQuality(playbackQuality, mediabunny) {
        switch (playbackQuality) {
          case 'full':
            return mediabunny.QUALITY_HIGH;
          case 'high':
            return mediabunny.QUALITY_HIGH;
          case 'low':
            return mediabunny.QUALITY_LOW;
          case 'med':
          default:
            return mediabunny.QUALITY_MEDIUM;
        }
      }

      function getAudioQuality(playbackQuality, mediabunny) {
        switch (playbackQuality) {
          case 'full':
            return mediabunny.QUALITY_HIGH;
          case 'high':
            return mediabunny.QUALITY_MEDIUM;
          case 'low':
            return mediabunny.QUALITY_LOW;
          case 'med':
          default:
            return mediabunny.QUALITY_MEDIUM;
        }
      }

      async function encodeSegment(request) {
        const segmentDuration = Math.max(0.04, request.endTime - request.startTime);
        const totalFrames = Math.max(1, Math.ceil(segmentDuration * request.fps));
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) {
          throw new Error('Failed to create 2D canvas context');
        }

        console.info('[Composer Preview][renderer] encodeSegment:start ' + JSON.stringify({
          projectId: request.projectId,
          requestSignature: request.requestSignature,
          segmentId: request.segmentId,
          segmentIndex: request.segmentIndex + 1,
          startTime: request.startTime,
          endTime: request.endTime,
          fps: request.fps,
          totalFrames,
          hasVideoEncoder: typeof VideoEncoder !== 'undefined',
        }));

        canvas.width = request.outputWidth;
        canvas.height = request.outputHeight;

        const mediabunny = require('mediabunny');
        const target = new mediabunny.BufferTarget();
        const output = new mediabunny.Output({
          format: new mediabunny.Mp4OutputFormat(),
          target,
        });

        const videoSource = new mediabunny.CanvasSource(canvas, {
          codec: 'avc',
          bitrate: getVideoQuality(request.playbackQuality, mediabunny),
          frameRate: request.fps,
          hardwareAcceleration: 'prefer-hardware',
        });
        output.addVideoTrack(videoSource, {
          frameRate: request.fps,
          maximumPacketCount: totalFrames + 1,
        });

        const mixedAudio = await renderAudioBuffer(request, segmentDuration);
        let audioSource = null;
        if (mixedAudio) {
          audioSource = new mediabunny.AudioBufferSource({
            codec: 'aac',
            bitrate: getAudioQuality(request.playbackQuality, mediabunny),
          });
          output.addAudioTrack(audioSource);
        }

        await output.start();

        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
          const localTime = frameIndex / request.fps;
          const globalTime = Math.min(
            request.endTime - 0.0001,
            request.startTime + localTime,
          );
          const frameDuration = Math.max(
            0.001,
            Math.min(1 / request.fps, segmentDuration - localTime),
          );
          await renderFrame(ctx, request, globalTime);
          await videoSource.add(localTime, frameDuration);
          ipcRenderer.send('composer:segment-progress', {
            projectId: request.projectId,
            requestSignature: request.requestSignature,
            segmentId: request.segmentId,
            segmentIndex: request.segmentIndex,
            frameIndex: frameIndex + 1,
            totalFrames,
            percent: ((frameIndex + 1) / totalFrames) * 100,
          });
        }

        if (audioSource && mixedAudio) {
          await audioSource.add(mixedAudio);
        }

        await output.finalize();

        if (!target.buffer) {
          throw new Error('Headless renderer did not produce an output buffer');
        }

        console.info('[Composer Preview][renderer] encodeSegment:done ' + JSON.stringify({
          projectId: request.projectId,
          requestSignature: request.requestSignature,
          segmentId: request.segmentId,
          segmentIndex: request.segmentIndex + 1,
          totalFrames,
        }));

        return {
          bufferBase64: Buffer.from(target.buffer).toString('base64'),
        };
      }

      ipcRenderer.on('composer:render-segment', async (_event, payload) => {
        try {
          const result = await encodeSegment(payload.request);
          ipcRenderer.send('composer:render-segment-result', {
            requestId: payload.requestId,
            ok: true,
            bufferBase64: result.bufferBase64,
          });
        } catch (error) {
          console.error('[Composer Preview][renderer] encodeSegment:error ' + (error instanceof Error ? error.message : 'Headless render failed'));
          ipcRenderer.send('composer:render-segment-result', {
            requestId: payload.requestId,
            ok: false,
            errorMessage: error instanceof Error ? error.message : 'Headless render failed',
          });
        }
      });
    </script>
  </body>
</html>`;
}

function registerHeadlessRendererIpc(): void {
  if (ipcRegistered) {
    return;
  }

  ipcRegistered = true;

  ipcMain.on("composer:render-segment-result", (_event, payload) => {
    const requestId =
      typeof payload?.requestId === "string" ? payload.requestId : null;
    if (!requestId) {
      return;
    }

    const pending = pendingSegmentResults.get(requestId);
    if (!pending) {
      return;
    }
    pendingSegmentResults.delete(requestId);

    if (payload.ok !== true || typeof payload.bufferBase64 !== "string") {
      console.error("[Composer Preview] headless segment failed", {
        requestId,
        errorMessage:
          typeof payload?.errorMessage === "string"
            ? payload.errorMessage
            : "Headless renderer failed",
      });
      pending.reject(
        new Error(
          typeof payload?.errorMessage === "string"
            ? payload.errorMessage
            : "Headless renderer failed",
        ),
      );
      return;
    }

    const buffer = Buffer.from(payload.bufferBase64, "base64");
    console.info("[Composer Preview] headless segment completed", {
      requestId,
      byteLength: buffer.byteLength,
    });
    pending.resolve(buffer);
  });

  ipcMain.on("composer:segment-progress", (_event, payload: RenderSegmentProgress) => {
    progressListener?.(payload);
  });
}

function rejectPendingSegments(error: Error): void {
  for (const [requestId, pending] of pendingSegmentResults) {
    pendingSegmentResults.delete(requestId);
    pending.reject(error);
  }
}

export function setHeadlessRendererProgressListener(
  listener: ((progress: RenderSegmentProgress) => void) | null,
): void {
  progressListener = listener;
}

export async function createHeadlessRenderer(): Promise<BrowserWindow> {
  if (headlessRendererWindow && !headlessRendererWindow.isDestroyed()) {
    return headlessRendererWindow;
  }

  if (createRendererPromise) {
    return createRendererPromise;
  }

  registerHeadlessRendererIpc();

  createRendererPromise = new Promise<BrowserWindow>((resolve, reject) => {
    const window = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      transparent: false,
      frame: false,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
        webSecurity: false,
      },
    });

    headlessRendererWindow = window;
    window.webContents.on(
      "console-message",
      (_event, _level, message, _line, _sourceId) => {
        console.info(message);
      },
    );

    const finishWithError = (error: Error) => {
      if (createRendererPromise) {
        createRendererPromise = null;
      }
      reject(error);
    };

    window.once("closed", () => {
      if (headlessRendererWindow === window) {
        headlessRendererWindow = null;
      }
      cleanupTempHtml();
      rejectPendingSegments(new Error("Composer headless renderer closed"));
    });

    window.webContents.once("did-finish-load", () => {
      createRendererPromise = null;
      resolve(window);
    });

    window.webContents.once("did-fail-load", (_event, _code, description) => {
      finishWithError(new Error(description || "Failed to load headless renderer"));
    });

    try {
      const appPath = app.getAppPath();
      headlessTempHtmlPath = join(appPath, `.composer-headless-${Date.now()}.html`);
      writeFileSync(headlessTempHtmlPath, buildHeadlessRendererHtml(), "utf-8");
      void window.loadURL(pathToFileURL(headlessTempHtmlPath).href).catch((error) => {
        finishWithError(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      finishWithError(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return createRendererPromise;
}

export function getHeadlessRenderer(): BrowserWindow | null {
  return headlessRendererWindow && !headlessRendererWindow.isDestroyed()
    ? headlessRendererWindow
    : null;
}

export function destroyHeadlessRenderer(): void {
  const renderer = getHeadlessRenderer();
  if (renderer) {
    renderer.destroy();
  }
  headlessRendererWindow = null;
  createRendererPromise = null;
  cleanupTempHtml();
  rejectPendingSegments(new Error("Composer headless renderer destroyed"));
}

function cleanupTempHtml(): void {
  if (headlessTempHtmlPath) {
    try {
      unlinkSync(headlessTempHtmlPath);
    } catch {
      /* ignore cleanup failure */
    }
    headlessTempHtmlPath = null;
  }
}

export async function renderSegmentInHeadlessRenderer(
  request: RenderSegmentRequest,
): Promise<Buffer> {
  if (!app.isReady()) {
    throw new Error("Electron app is not ready");
  }

  const renderer = await createHeadlessRenderer();
  const requestId = `segment-${Date.now()}-${requestCounter += 1}`;
  console.info("[Composer Preview] dispatching headless segment", {
    projectId: request.projectId,
    requestSignature: request.requestSignature,
    requestId,
    segmentId: request.segmentId,
    segmentIndex: request.segmentIndex + 1,
  });

  return new Promise<Buffer>((resolve, reject) => {
    pendingSegmentResults.set(requestId, { resolve, reject });
    renderer.webContents.send("composer:render-segment", { requestId, request });
  });
}
