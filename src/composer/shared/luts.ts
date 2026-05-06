export type CubeLutBounds = [number, number, number];

export interface ParsedCubeLut {
  format: "cube";
  kind: "3d";
  title: string | null;
  size: number;
  domainMin: CubeLutBounds;
  domainMax: CubeLutBounds;
  /**
   * RGB triplets stored in the source .cube order (red index varies fastest).
   */
  values: Float32Array;
}

export interface ResolvedComposerLut {
  assetId: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  modifiedAt: string;
  cacheKey: string;
  lut: ParsedCubeLut;
}

const DEFAULT_DOMAIN_MIN: CubeLutBounds = [0, 0, 0];
const DEFAULT_DOMAIN_MAX: CubeLutBounds = [1, 1, 1];

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function createParseError(
  sourceLabel: string,
  lineNumber: number,
  message: string,
): Error {
  return new Error(`${sourceLabel}: line ${lineNumber} — ${message}`);
}

function stripCubeLineComment(line: string): string {
  const commentIndex = line.indexOf("#");
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function parseFiniteNumber(
  value: string,
  sourceLabel: string,
  lineNumber: number,
  context: string,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw createParseError(
      sourceLabel,
      lineNumber,
      `invalid ${context} value "${value}"`,
    );
  }
  return parsed;
}

function parseBounds(
  values: string[],
  sourceLabel: string,
  lineNumber: number,
  keyword: string,
): CubeLutBounds {
  if (values.length !== 3) {
    throw createParseError(
      sourceLabel,
      lineNumber,
      `${keyword} must provide exactly 3 numeric values`,
    );
  }

  return [
    parseFiniteNumber(values[0], sourceLabel, lineNumber, `${keyword}[0]`),
    parseFiniteNumber(values[1], sourceLabel, lineNumber, `${keyword}[1]`),
    parseFiniteNumber(values[2], sourceLabel, lineNumber, `${keyword}[2]`),
  ];
}

export function getCubeLutArrayOffset(
  size: number,
  redIndex: number,
  greenIndex: number,
  blueIndex: number,
): number {
  if (
    !Number.isInteger(size) ||
    !Number.isInteger(redIndex) ||
    !Number.isInteger(greenIndex) ||
    !Number.isInteger(blueIndex) ||
    size < 2 ||
    redIndex < 0 ||
    greenIndex < 0 ||
    blueIndex < 0 ||
    redIndex >= size ||
    greenIndex >= size ||
    blueIndex >= size
  ) {
    throw new Error("Cube LUT index is out of range.");
  }

  return ((blueIndex * size + greenIndex) * size + redIndex) * 3;
}

export function applyCubeLutToRgbaBuffer(
  lut: ParsedCubeLut,
  rgba: Uint8ClampedArray,
): void {
  if (rgba.length < 4) {
    return;
  }

  const { size, domainMin, domainMax, values } = lut;
  const maxIndex = size - 1;
  const redRange = domainMax[0] - domainMin[0];
  const greenRange = domainMax[1] - domainMin[1];
  const blueRange = domainMax[2] - domainMin[2];

  for (let index = 0; index <= rgba.length - 4; index += 4) {
    const mappedRed =
      clamp((rgba[index] / 255 - domainMin[0]) / redRange, 0, 1) * maxIndex;
    const mappedGreen =
      clamp((rgba[index + 1] / 255 - domainMin[1]) / greenRange, 0, 1) *
      maxIndex;
    const mappedBlue =
      clamp((rgba[index + 2] / 255 - domainMin[2]) / blueRange, 0, 1) *
      maxIndex;

    const redIndex0 = Math.floor(mappedRed);
    const greenIndex0 = Math.floor(mappedGreen);
    const blueIndex0 = Math.floor(mappedBlue);
    const redIndex1 = Math.min(redIndex0 + 1, maxIndex);
    const greenIndex1 = Math.min(greenIndex0 + 1, maxIndex);
    const blueIndex1 = Math.min(blueIndex0 + 1, maxIndex);
    const redMix = mappedRed - redIndex0;
    const greenMix = mappedGreen - greenIndex0;
    const blueMix = mappedBlue - blueIndex0;

    const sample000 = getCubeLutArrayOffset(
      size,
      redIndex0,
      greenIndex0,
      blueIndex0,
    );
    const sample100 = getCubeLutArrayOffset(
      size,
      redIndex1,
      greenIndex0,
      blueIndex0,
    );
    const sample010 = getCubeLutArrayOffset(
      size,
      redIndex0,
      greenIndex1,
      blueIndex0,
    );
    const sample110 = getCubeLutArrayOffset(
      size,
      redIndex1,
      greenIndex1,
      blueIndex0,
    );
    const sample001 = getCubeLutArrayOffset(
      size,
      redIndex0,
      greenIndex0,
      blueIndex1,
    );
    const sample101 = getCubeLutArrayOffset(
      size,
      redIndex1,
      greenIndex0,
      blueIndex1,
    );
    const sample011 = getCubeLutArrayOffset(
      size,
      redIndex0,
      greenIndex1,
      blueIndex1,
    );
    const sample111 = getCubeLutArrayOffset(
      size,
      redIndex1,
      greenIndex1,
      blueIndex1,
    );

    const red000 = values[sample000];
    const red100 = values[sample100];
    const red010 = values[sample010];
    const red110 = values[sample110];
    const red001 = values[sample001];
    const red101 = values[sample101];
    const red011 = values[sample011];
    const red111 = values[sample111];

    const green000 = values[sample000 + 1];
    const green100 = values[sample100 + 1];
    const green010 = values[sample010 + 1];
    const green110 = values[sample110 + 1];
    const green001 = values[sample001 + 1];
    const green101 = values[sample101 + 1];
    const green011 = values[sample011 + 1];
    const green111 = values[sample111 + 1];

    const blue000 = values[sample000 + 2];
    const blue100 = values[sample100 + 2];
    const blue010 = values[sample010 + 2];
    const blue110 = values[sample110 + 2];
    const blue001 = values[sample001 + 2];
    const blue101 = values[sample101 + 2];
    const blue011 = values[sample011 + 2];
    const blue111 = values[sample111 + 2];

    const red00 = lerp(red000, red100, redMix);
    const red10 = lerp(red010, red110, redMix);
    const red01 = lerp(red001, red101, redMix);
    const red11 = lerp(red011, red111, redMix);
    const green00 = lerp(green000, green100, redMix);
    const green10 = lerp(green010, green110, redMix);
    const green01 = lerp(green001, green101, redMix);
    const green11 = lerp(green011, green111, redMix);
    const blue00 = lerp(blue000, blue100, redMix);
    const blue10 = lerp(blue010, blue110, redMix);
    const blue01 = lerp(blue001, blue101, redMix);
    const blue11 = lerp(blue011, blue111, redMix);

    const red0 = lerp(red00, red10, greenMix);
    const red1 = lerp(red01, red11, greenMix);
    const green0 = lerp(green00, green10, greenMix);
    const green1 = lerp(green01, green11, greenMix);
    const blue0 = lerp(blue00, blue10, greenMix);
    const blue1 = lerp(blue01, blue11, greenMix);

    rgba[index] = Math.round(clamp(lerp(red0, red1, blueMix), 0, 1) * 255);
    rgba[index + 1] = Math.round(
      clamp(lerp(green0, green1, blueMix), 0, 1) * 255,
    );
    rgba[index + 2] = Math.round(
      clamp(lerp(blue0, blue1, blueMix), 0, 1) * 255,
    );
  }
}

export function parseCubeLut(
  source: string,
  sourceLabel = "LUT",
): ParsedCubeLut {
  const lines = source.split(/\r?\n/);
  let title: string | null = null;
  let size: number | null = null;
  let domainMin: CubeLutBounds = [...DEFAULT_DOMAIN_MIN] as CubeLutBounds;
  let domainMax: CubeLutBounds = [...DEFAULT_DOMAIN_MAX] as CubeLutBounds;
  const values: number[] = [];
  let sawData = false;

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = stripCubeLineComment(rawLine).trim();
    if (line.length === 0) {
      return;
    }

    if (/^TITLE\b/i.test(line)) {
      if (sawData) {
        throw createParseError(
          sourceLabel,
          lineNumber,
          "TITLE must appear before LUT data",
        );
      }
      const value = line.slice(5).trim();
      title =
        value.startsWith('"') && value.endsWith('"') && value.length >= 2
          ? value.slice(1, -1)
          : value;
      return;
    }

    const tokens = line.split(/\s+/);
    const keyword = tokens[0]?.toUpperCase();

    if (keyword === "LUT_3D_SIZE") {
      if (sawData) {
        throw createParseError(
          sourceLabel,
          lineNumber,
          "LUT_3D_SIZE must appear before LUT data",
        );
      }
      if (size != null) {
        throw createParseError(
          sourceLabel,
          lineNumber,
          "duplicate LUT_3D_SIZE declaration",
        );
      }
      if (tokens.length !== 2) {
        throw createParseError(
          sourceLabel,
          lineNumber,
          "LUT_3D_SIZE must provide exactly one integer value",
        );
      }
      const parsedSize = Number(tokens[1]);
      if (!Number.isInteger(parsedSize) || parsedSize < 2) {
        throw createParseError(
          sourceLabel,
          lineNumber,
          `invalid LUT_3D_SIZE value "${tokens[1]}"`,
        );
      }
      size = parsedSize;
      return;
    }

    if (keyword === "DOMAIN_MIN" || keyword === "DOMAIN_MAX") {
      if (sawData) {
        throw createParseError(
          sourceLabel,
          lineNumber,
          `${keyword} must appear before LUT data`,
        );
      }
      const bounds = parseBounds(
        tokens.slice(1),
        sourceLabel,
        lineNumber,
        keyword,
      );
      if (keyword === "DOMAIN_MIN") {
        domainMin = bounds;
      } else {
        domainMax = bounds;
      }
      return;
    }

    if (keyword === "LUT_1D_SIZE" || keyword === "LUT_1D_INPUT_RANGE") {
      throw createParseError(
        sourceLabel,
        lineNumber,
        `${keyword} is not supported in the Composer LUT MVP`,
      );
    }

    if (/^[A-Z_][A-Z0-9_]*$/i.test(tokens[0])) {
      throw createParseError(
        sourceLabel,
        lineNumber,
        `unsupported .cube directive "${tokens[0]}"`,
      );
    }

    if (size == null) {
      throw createParseError(
        sourceLabel,
        lineNumber,
        "LUT data appeared before LUT_3D_SIZE",
      );
    }

    if (tokens.length !== 3) {
      throw createParseError(
        sourceLabel,
        lineNumber,
        "expected exactly 3 LUT sample values",
      );
    }

    sawData = true;
    values.push(
      parseFiniteNumber(tokens[0], sourceLabel, lineNumber, "red sample"),
      parseFiniteNumber(tokens[1], sourceLabel, lineNumber, "green sample"),
      parseFiniteNumber(tokens[2], sourceLabel, lineNumber, "blue sample"),
    );
  });

  if (size == null) {
    throw new Error(`${sourceLabel}: missing LUT_3D_SIZE declaration`);
  }

  if (
    domainMax[0] <= domainMin[0] ||
    domainMax[1] <= domainMin[1] ||
    domainMax[2] <= domainMin[2]
  ) {
    throw new Error(
      `${sourceLabel}: DOMAIN_MAX must be greater than DOMAIN_MIN`,
    );
  }

  const expectedValueCount = size * size * size * 3;
  if (values.length !== expectedValueCount) {
    throw new Error(
      `${sourceLabel}: expected ${expectedValueCount / 3} LUT rows for size ${size}, received ${values.length / 3}`,
    );
  }

  return {
    format: "cube",
    kind: "3d",
    title,
    size,
    domainMin,
    domainMax,
    values: Float32Array.from(values),
  };
}
