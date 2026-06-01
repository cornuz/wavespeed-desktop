# Free Tool Review Checklist

This note records issues found during PR #101 (`Add free image colorizer tool`) so future free-tool changes can be checked before review.

## PR #101 Issues

1. Worker request cleanup
   - Problem: `useImageColorizerWorker.colorize()` added an error listener on every request, but successful requests did not remove it.
   - Risk: successful runs accumulate listeners; a later failure can reject multiple old requests and leak memory.
   - Check next time: track requests by `id`, resolve or reject exactly one pending request, and clear pending requests on worker disposal.

2. WebGPU fallback convention
   - Problem: the colorizer worker created the ONNX session with `executionProviders: ["wasm"]` only.
   - Risk: local AI tools become much slower than project convention, especially for fp16 models.
   - Follow-up finding: DDColor fp16 creates a WebGPU session in Electron 33, but inference emits WGSL validation errors around `f16` without the `f16` extension and returns zero chroma tensors on tested inputs. The user-visible result is nearly grayscale.
   - Check next time: workers that use ONNX Runtime should prefer WebGPU and fall back to WASM, matching the existing image eraser, face enhancer, face swapper, and SAM patterns. If WebGPU changes output quality for a model, pin that model to WASM and keep a small output comparison grid as evidence.

3. Multi-phase progress math
   - Problem: progress phases were fixed at `download: 0.35` and `process: 0.65`, but non-AI modes skip download and start at `process`.
   - Risk: non-AI runs cap at 65% progress even when complete.
   - Check next time: if a mode skips a phase, use a mode-specific phase list or make the active phase weight total 1.0.

4. Timeout error normalization
   - Problem: Settings predownload stored raw `(error as Error).message` from `AbortController`.
   - Risk: users may see platform-specific raw abort messages instead of a clear localized timeout message.
   - Check next time: normalize aborts with `controller.signal.aborted` or `error.name === "AbortError"` and map them to a localized timeout string.

5. Desktop and mobile release scope
   - Problem: mobile version files were bumped even though the feature only exists in the desktop app.
   - Risk: release metadata claims a mobile update without a matching mobile feature, and mobile release checks can become misleading.
   - Check next time: only bump mobile version files when the mobile app has the feature or a real mobile change.

6. Locale coverage
   - Problem: new settings cache keys were added only for `en.json` and `zh-CN.json`.
   - Risk: other locales can show raw i18n key paths, especially in Settings where some labels have no runtime fallback.
   - Check next time: when adding `settings.*` or shared UI keys, add entries for all locale files. English fallback text is acceptable when full translation is not ready.

7. Trusted model source
   - Problem: the colorizer model URL pointed to an unofficial personal Hugging Face mirror.
   - Risk: supply-chain risk, disappearing files, or unexpected model replacement.
   - Check next time: use upstream, first-party, well-known, or WaveSpeed-controlled model URLs. If upstream distributes a zip or external-data ONNX model, either implement that loader intentionally or host a verified compatible artifact.

8. CDN CORS for renderer downloads
   - Problem: a WaveSpeed-hosted model URL can have the correct file size and checksum but still miss `Access-Control-Allow-Origin`.
   - Risk: production Electron enables web security, so renderer workers can fail to `fetch()` the model even though server-side HEAD/GET checks pass.
   - Check next time: test model URLs with an `Origin` header and verify `Access-Control-Allow-Origin` is present before replacing a Hugging Face/jsDelivr URL. For public model artifacts, configure the CDN/R2 bucket with `Access-Control-Allow-Origin: *`, allowed methods `GET, HEAD, OPTIONS`, allowed headers `*`, and exposed headers `Content-Length, Content-Range, Accept-Ranges, ETag`.

## Before Opening A Free Tool PR

- Confirm worker lifecycle: one request in, one result/error out, no dangling listeners.
- Confirm local model execution provider matches project convention.
- Test every mode path, especially paths that skip download or model inference.
- Verify Settings predownload and in-worker download report comparable errors.
- Keep desktop and mobile version changes scoped to the platform that changed.
- Run a locale key coverage check for shared/settings keys.
- Verify model URLs are trusted and compatible with the current loader.
- Verify CDN-hosted model URLs return CORS headers for renderer/worker `fetch()`.
- Run `npm run build` before requesting review.
