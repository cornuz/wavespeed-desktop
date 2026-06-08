import { app, BrowserWindow, ipcMain } from "electron";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { DEFAULT_COMPOSER_PROJECT_BACKGROUND_COLOR } from "../../src/composer/types/project";
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
const progressListeners = new Set<(progress: RenderSegmentProgress) => void>();

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
          background: ${DEFAULT_COMPOSER_PROJECT_BACKGROUND_COLOR};
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
      const processedImageCache = new Map();
      const sharpenedImageCache = new Map();
      const videoCache = new Map();
      const audioCache = new Map();
      const SHARPEN_EPSILON = 0.0001;
      const BLUR_EPSILON = 0.0001;
      const NOISE_EPSILON = 0.0001;

      function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
      }

      function clamp01(value) {
        return clamp(value, 0, 1);
      }

      function clampByte(value) {
        return Math.round(clamp(value, 0, 255));
      }

      function normalizeSharpenAmount(value) {
        if (!Number.isFinite(value)) {
          return 0;
        }
        return clamp(value, 0, 200);
      }

      function normalizeNoiseAmount(value) {
        if (!Number.isFinite(value)) {
          return 0;
        }
        return clamp(value, 0, 100);
      }

      function normalizeBlurAmount(value) {
        if (!Number.isFinite(value)) {
          return 0;
        }
        return clamp(value, 0, 50);
      }

      function hashUint32(value) {
        let hash = value >>> 0;
        hash ^= hash >>> 16;
        hash = Math.imul(hash, 0x7feb352d);
        hash ^= hash >>> 15;
        hash = Math.imul(hash, 0x846ca68b);
        hash ^= hash >>> 16;
        return hash >>> 0;
      }

      function getNoiseSeed(source) {
        let hash = 2166136261;
        for (let index = 0; index < source.length; index += 1) {
          hash ^= source.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
      }

      function getNoiseByte(seed, frameIndex, x, y) {
        const frameSeed = hashUint32(
          seed ^
          Math.imul((Math.max(0, Math.round(frameIndex)) + 1) >>> 0, 0x9e3779b1),
        );
        const mixed =
          frameSeed ^
          Math.imul((x + 1) >>> 0, 374761393) ^
          Math.imul((y + 1) >>> 0, 668265263);
        return hashUint32(mixed) & 255;
      }

      function overlayBlendChannel(base, blend) {
        return base < 0.5
          ? 2 * base * blend
          : 1 - 2 * (1 - base) * (1 - blend);
      }

      function createProcessingCanvas(width, height) {
        const offscreen = document.createElement('canvas');
        offscreen.width = Math.max(1, Math.round(width));
        offscreen.height = Math.max(1, Math.round(height));
        return offscreen;
      }

      function getProcessingContext(target, errorMessage) {
        const context = target.getContext('2d', { willReadFrequently: true });
        if (!context) {
          throw new Error(errorMessage);
        }
        return context;
      }

      function getCubeLutOffset(size, redIndex, greenIndex, blueIndex) {
        return ((blueIndex * size + greenIndex) * size + redIndex) * 3;
      }

      function normalizeLutInput(value, min, max) {
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
          return clamp01(value);
        }
        return clamp01((value - min) / (max - min));
      }

      function lerp(a, b, amount) {
        return a + (b - a) * amount;
      }

      function sampleCubeLut(lut, red, green, blue) {
        const size = Number.isInteger(lut?.size) ? lut.size : 0;
        if (size < 2 || !lut?.values) {
          return [red, green, blue];
        }

        const domainMin = Array.isArray(lut.domainMin) ? lut.domainMin : [0, 0, 0];
        const domainMax = Array.isArray(lut.domainMax) ? lut.domainMax : [1, 1, 1];
        const values = lut.values;
        const maxIndex = size - 1;

        const normalizedRed = normalizeLutInput(red, domainMin[0], domainMax[0]) * maxIndex;
        const normalizedGreen = normalizeLutInput(green, domainMin[1], domainMax[1]) * maxIndex;
        const normalizedBlue = normalizeLutInput(blue, domainMin[2], domainMax[2]) * maxIndex;

        const redLow = Math.floor(normalizedRed);
        const greenLow = Math.floor(normalizedGreen);
        const blueLow = Math.floor(normalizedBlue);
        const redHigh = Math.min(maxIndex, redLow + 1);
        const greenHigh = Math.min(maxIndex, greenLow + 1);
        const blueHigh = Math.min(maxIndex, blueLow + 1);

        const redMix = normalizedRed - redLow;
        const greenMix = normalizedGreen - greenLow;
        const blueMix = normalizedBlue - blueLow;

        const sample = (redIndex, greenIndex, blueIndex) => {
          const offset = getCubeLutOffset(size, redIndex, greenIndex, blueIndex);
          return [
            values[offset] ?? red,
            values[offset + 1] ?? green,
            values[offset + 2] ?? blue,
          ];
        };

        const c000 = sample(redLow, greenLow, blueLow);
        const c100 = sample(redHigh, greenLow, blueLow);
        const c010 = sample(redLow, greenHigh, blueLow);
        const c110 = sample(redHigh, greenHigh, blueLow);
        const c001 = sample(redLow, greenLow, blueHigh);
        const c101 = sample(redHigh, greenLow, blueHigh);
        const c011 = sample(redLow, greenHigh, blueHigh);
        const c111 = sample(redHigh, greenHigh, blueHigh);

        const redPlane0 = [
          lerp(c000[0], c100[0], redMix),
          lerp(c000[1], c100[1], redMix),
          lerp(c000[2], c100[2], redMix),
        ];
        const redPlane1 = [
          lerp(c010[0], c110[0], redMix),
          lerp(c010[1], c110[1], redMix),
          lerp(c010[2], c110[2], redMix),
        ];
        const redPlane2 = [
          lerp(c001[0], c101[0], redMix),
          lerp(c001[1], c101[1], redMix),
          lerp(c001[2], c101[2], redMix),
        ];
        const redPlane3 = [
          lerp(c011[0], c111[0], redMix),
          lerp(c011[1], c111[1], redMix),
          lerp(c011[2], c111[2], redMix),
        ];

        const greenPlane0 = [
          lerp(redPlane0[0], redPlane1[0], greenMix),
          lerp(redPlane0[1], redPlane1[1], greenMix),
          lerp(redPlane0[2], redPlane1[2], greenMix),
        ];
        const greenPlane1 = [
          lerp(redPlane2[0], redPlane3[0], greenMix),
          lerp(redPlane2[1], redPlane3[1], greenMix),
          lerp(redPlane2[2], redPlane3[2], greenMix),
        ];

        return [
          clamp01(lerp(greenPlane0[0], greenPlane1[0], blueMix)),
          clamp01(lerp(greenPlane0[1], greenPlane1[1], blueMix)),
          clamp01(lerp(greenPlane0[2], greenPlane1[2], blueMix)),
        ];
      }

      function applyCubeLutToImageData(imageData, lut) {
        const data = imageData.data;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index + 3] === 0) {
            continue;
          }

          const [red, green, blue] = sampleCubeLut(
            lut,
            data[index] / 255,
            data[index + 1] / 255,
            data[index + 2] / 255,
          );
          data[index] = Math.round(red * 255);
          data[index + 1] = Math.round(green * 255);
          data[index + 2] = Math.round(blue * 255);
        }
      }

      function applySharpenToImageData(imageData, sharpenAmount) {
        const strength = clamp(normalizeSharpenAmount(sharpenAmount) / 100, 0, 2);
        if (strength <= SHARPEN_EPSILON) {
          return;
        }

        const { data, width, height } = imageData;
        const source = new Uint8ClampedArray(data);
        const edgeWeight = -strength;
        const centerWeight = 1 + strength * 4;
        const getPixelOffset = (x, y) =>
          (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;

        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 4;
            const top = getPixelOffset(x, y - 1);
            const bottom = getPixelOffset(x, y + 1);
            const left = getPixelOffset(x - 1, y);
            const right = getPixelOffset(x + 1, y);

            data[index] = clampByte(
              source[index] * centerWeight +
                edgeWeight *
                  (source[top] + source[bottom] + source[left] + source[right]),
            );
            data[index + 1] = clampByte(
              source[index + 1] * centerWeight +
                edgeWeight *
                  (source[top + 1] +
                    source[bottom + 1] +
                    source[left + 1] +
                    source[right + 1]),
            );
            data[index + 2] = clampByte(
              source[index + 2] * centerWeight +
                edgeWeight *
                  (source[top + 2] +
                    source[bottom + 2] +
                    source[left + 2] +
                    source[right + 2]),
            );
            data[index + 3] = source[index + 3];
          }
        }
      }

      function applyNoiseToImageData(imageData, noiseAmount, noiseSeed, frameIndex) {
        const amount = normalizeNoiseAmount(noiseAmount) / 100;
        if (amount <= NOISE_EPSILON) {
          return;
        }

        const { data, width, height } = imageData;

        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 4;
            const blend = getNoiseByte(noiseSeed, frameIndex, x, y) / 255;
            const red = data[index] / 255;
            const green = data[index + 1] / 255;
            const blue = data[index + 2] / 255;

            data[index] = clampByte(
              (red + (overlayBlendChannel(red, blend) - red) * amount) * 255,
            );
            data[index + 1] = clampByte(
              (green + (overlayBlendChannel(green, blend) - green) * amount) * 255,
            );
            data[index + 2] = clampByte(
              (blue + (overlayBlendChannel(blue, blend) - blue) * amount) * 255,
            );
          }
        }
      }

      function renderProcessedVisualSource(source, rect, sharpenAmount, blurAmount, noiseAmount, noiseSeed, frameIndex) {
        const baseCanvas = createProcessingCanvas(rect.width, rect.height);
        const baseCtx = getProcessingContext(
          baseCanvas,
          'Failed to create effect processing context',
        );

        baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
        baseCtx.drawImage(source, 0, 0, baseCanvas.width, baseCanvas.height);

        const normalizedSharpenAmount = normalizeSharpenAmount(sharpenAmount);
        const normalizedBlurAmount = normalizeBlurAmount(blurAmount);
        const normalizedNoiseAmount = normalizeNoiseAmount(noiseAmount);
        if (normalizedSharpenAmount > SHARPEN_EPSILON) {
          const imageData = baseCtx.getImageData(
            0,
            0,
            baseCanvas.width,
            baseCanvas.height,
          );
          applySharpenToImageData(imageData, normalizedSharpenAmount);
          baseCtx.putImageData(imageData, 0, 0);
        }

        let processedCanvas = baseCanvas;
        if (normalizedBlurAmount > BLUR_EPSILON) {
          const blurredCanvas = createProcessingCanvas(rect.width, rect.height);
          const blurredCtx = getProcessingContext(
            blurredCanvas,
            'Failed to create blur processing context',
          );
          blurredCtx.filter = 'blur(' + normalizedBlurAmount + 'px)';
          blurredCtx.drawImage(
            processedCanvas,
            0,
            0,
            blurredCanvas.width,
            blurredCanvas.height,
          );
          blurredCtx.filter = 'none';
          processedCanvas = blurredCanvas;
        }

        if (normalizedNoiseAmount > NOISE_EPSILON) {
          const processedCtx = getProcessingContext(
            processedCanvas,
            'Failed to create noise processing context',
          );
          const imageData = processedCtx.getImageData(
            0,
            0,
            processedCanvas.width,
            processedCanvas.height,
          );
          applyNoiseToImageData(
            imageData,
            normalizedNoiseAmount,
            noiseSeed,
            frameIndex,
          );
          processedCtx.putImageData(imageData, 0, 0);
        }

        return processedCanvas;
      }

      function getProcessedImageCacheKey(clip, width, height) {
        return [
          clip.sourcePath,
          width,
          height,
          clip.lut?.cacheKey || '',
        ].join('|');
      }

      function getSharpenedImageCacheKey(clip, width, height, sourceKey) {
        return [
          clip.sourcePath,
          width,
          height,
          sourceKey,
          normalizeSharpenAmount(clip.sharpen),
        ].join('|');
      }

      async function loadProcessedImage(clip, rect) {
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        const cacheKey = getProcessedImageCacheKey(clip, width, height);

        if (!processedImageCache.has(cacheKey)) {
          processedImageCache.set(cacheKey, (async () => {
            const image = await loadImage(clip.sourcePath);
            const offscreen = createProcessingCanvas(width, height);
            const offscreenCtx = getProcessingContext(
              offscreen,
              'Failed to create LUT processing context',
            );

            offscreenCtx.clearRect(0, 0, width, height);
            offscreenCtx.drawImage(image, 0, 0, width, height);

            const imageData = offscreenCtx.getImageData(0, 0, width, height);
            applyCubeLutToImageData(imageData, clip.lut.lut);
            offscreenCtx.putImageData(imageData, 0, 0);
            return offscreen;
          })());
        }

        try {
          return await processedImageCache.get(cacheKey);
        } catch (error) {
          processedImageCache.delete(cacheKey);
          throw error;
        }
      }

      async function loadSharpenedImage(clip, rect, sourceKey, sourceLoader) {
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        const cacheKey = getSharpenedImageCacheKey(clip, width, height, sourceKey);

        if (!sharpenedImageCache.has(cacheKey)) {
          sharpenedImageCache.set(cacheKey, (async () => {
            const source = await sourceLoader();
            return renderProcessedVisualSource(
              source,
              rect,
              clip.sharpen,
              0,
              getNoiseSeed(clip.id || clip.sourcePath || ''),
              0,
            );
          })());
        }

        try {
          return await sharpenedImageCache.get(cacheKey);
        } catch (error) {
          sharpenedImageCache.delete(cacheKey);
          throw error;
        }
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
        } catch (error) {
          try {
            console.warn('[Composer Preview][renderer] loadAudioBuffer:error', {
              sourcePath,
              errorMessage: error instanceof Error ? error.message : String(error),
            });
          } catch {
            /* ignore logging failure */
          }
          // remove the cached failing entry so future attempts may retry
          try {
            audioCache.delete(sourcePath);
          } catch {
            /* ignore */
          }
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

      async function renderFrame(ctx, request, globalTime, frameIndex) {
        const backgroundColor =
          typeof request.backgroundColor === 'string' && request.backgroundColor.length > 0
            ? request.backgroundColor
            : '${DEFAULT_COMPOSER_PROJECT_BACKGROUND_COLOR}';
        document.documentElement.style.backgroundColor = backgroundColor;
        document.body.style.backgroundColor = backgroundColor;
        ctx.clearRect(0, 0, request.outputWidth, request.outputHeight);
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, request.outputWidth, request.outputHeight);

        const clips = getActiveVisualClips(request.clips, globalTime);

        for (const clip of clips) {
          const rect = clip.rect;
          const alpha = computeClipAlpha(clip, globalTime);
          if (!rect || alpha <= 0) {
            continue;
          }

          const shouldApplyImageLut =
            clip.inputKind === 'image' &&
            clip.lutApplication === 'cube-image' &&
            clip.lut;
          const sharpenAmount = normalizeSharpenAmount(clip.sharpen);
          const shouldSharpen = sharpenAmount > SHARPEN_EPSILON;
          const blurAmount = normalizeBlurAmount(clip.blur);
          const shouldBlur = blurAmount > BLUR_EPSILON;
          const noiseAmount = normalizeNoiseAmount(clip.noise);
          const shouldNoise = noiseAmount > NOISE_EPSILON;
          const noiseSeed = shouldNoise
            ? getNoiseSeed(clip.id || clip.sourcePath || '')
            : 0;
          const clipFilter =
            typeof clip.filter === 'string' && clip.filter.length > 0
              ? clip.filter
              : null;

          ctx.save();
          if (clip.blendMode) {
            ctx.globalCompositeOperation = clip.blendMode;
          }
          if (alpha < 0.9999) {
            ctx.globalAlpha = alpha;
          }
          if (clipFilter) {
            ctx.filter = clipFilter;
          }

          const centerX = rect.x + rect.width / 2;
          const centerY = rect.y + rect.height / 2;
          ctx.translate(centerX, centerY);
          if (clip.rotation) {
            ctx.rotate((clip.rotation * Math.PI) / 180);
          }
          if (clip.flipHorizontal || clip.flipVertical) {
            ctx.scale(clip.flipHorizontal ? -1 : 1, clip.flipVertical ? -1 : 1);
          }

          if (clip.inputKind === 'image') {
            let image = await loadImage(clip.sourcePath);
            let lutApplied = false;
            if (shouldApplyImageLut) {
              try {
                image = await loadProcessedImage(clip, rect);
                lutApplied = true;
              } catch (error) {
                console.warn('[Composer Preview][renderer] image LUT skipped ' + JSON.stringify({
                  clipId: clip.id,
                  lutAssetId: clip.requestedLutAssetId,
                  errorMessage: error instanceof Error ? error.message : String(error),
                }));
              }
            }

            if (shouldSharpen && !shouldBlur && !shouldNoise) {
              try {
                const sourceImage = image;
                image = await loadSharpenedImage(
                  clip,
                  rect,
                  lutApplied
                    ? 'lut:' + (clip.lut?.cacheKey || '')
                    : 'source',
                  () => Promise.resolve(sourceImage),
                );
              } catch (error) {
                console.warn('[Composer Preview][renderer] image sharpen skipped ' + JSON.stringify({
                  clipId: clip.id,
                  sharpen: sharpenAmount,
                  errorMessage: error instanceof Error ? error.message : String(error),
                }));
              }
            }
            if (shouldBlur || shouldNoise) {
              image = renderProcessedVisualSource(
                image,
                rect,
                sharpenAmount,
                blurAmount,
                noiseAmount,
                noiseSeed,
                frameIndex,
              );
            }
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
            const videoFrame =
              shouldSharpen || shouldBlur || shouldNoise
                ? renderProcessedVisualSource(
                    video,
                    rect,
                    sharpenAmount,
                    blurAmount,
                    noiseAmount,
                    noiseSeed,
                    frameIndex,
                  )
                : video;
            ctx.drawImage(
              videoFrame,
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
          let value = clip.volume ?? 1;
          if (clip.fadeInDuration > 0 && clipLocalTime < clip.fadeInDuration) {
            value *= clamp(clipLocalTime / clip.fadeInDuration, 0, 1);
          }
          if (clip.fadeOutDuration > 0 && clipLocalTime > fadeOutStart) {
            value *= clamp((clip.renderedDuration - clipLocalTime) / clip.fadeOutDuration, 0, 1);
          }
          return Math.max(0, value);
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

        try {
          console.info('[Composer Preview][renderer] renderAudioBuffer:start', {
            projectId: request.projectId,
            segmentDuration,
            audioClipCount: audioClips.length,
          });
        } catch {
          /* ignore logging failure */
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
            try {
              console.warn('[Composer Preview][renderer] missingAudioBuffer', {
                clipId: clip.id,
                sourcePath: clip.sourcePath,
              });
            } catch {
              /* ignore */
            }
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
          await renderFrame(ctx, request, globalTime, frameIndex);
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
    try {
      for (const listener of progressListeners) {
        try {
          listener(payload);
        } catch (err) {
          // listener errors are isolated
          console.warn('[Composer] headless progress listener error', err instanceof Error ? err.message : err);
        }
      }
    } catch {
      /* ignore */
    }
  });
}

function rejectPendingSegments(error: Error): void {
  for (const [requestId, pending] of pendingSegmentResults) {
    pendingSegmentResults.delete(requestId);
    pending.reject(error);
  }
}

export function addHeadlessRendererProgressListener(
  listener: (progress: RenderSegmentProgress) => void,
): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

export function removeHeadlessRendererProgressListener(
  listener: (progress: RenderSegmentProgress) => void,
): void {
  progressListeners.delete(listener);
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
      finishWithError(
        new Error(description || "Failed to load headless renderer"),
      );
    });

    try {
      const appPath = app.getAppPath();
      headlessTempHtmlPath = join(
        appPath,
        `.composer-headless-${Date.now()}.html`,
      );
      writeFileSync(headlessTempHtmlPath, buildHeadlessRendererHtml(), "utf-8");
      void window
        .loadURL(pathToFileURL(headlessTempHtmlPath).href)
        .catch((error) => {
          finishWithError(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    } catch (error) {
      finishWithError(
        error instanceof Error ? error : new Error(String(error)),
      );
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
  const requestId = `segment-${Date.now()}-${(requestCounter += 1)}`;
  console.info("[Composer Preview] dispatching headless segment", {
    projectId: request.projectId,
    requestSignature: request.requestSignature,
    requestId,
    segmentId: request.segmentId,
    segmentIndex: request.segmentIndex + 1,
  });

  return new Promise<Buffer>((resolve, reject) => {
    pendingSegmentResults.set(requestId, { resolve, reject });
    renderer.webContents.send("composer:render-segment", {
      requestId,
      request,
    });
  });
}
