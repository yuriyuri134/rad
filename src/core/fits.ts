import type { FitsAnalysisResult, FitsHeaderCard, FitsSourceDetection } from './types.ts';

/**
 * Parses an authentic IEEE / IAU FITS binary file (2880-byte ASCII header blocks + big-endian image array).
 */
export function parseFitsBuffer(buffer: Uint8Array, fileName = 'observation.fits'): FitsAnalysisResult {
  if (buffer.byteLength < 2880) {
    throw new Error(`FITS 文件长度不足 2880 字节（当前 ${buffer.byteLength} 字节）`);
  }

  const decoder = new TextDecoder('ascii');
  const headers: FitsHeaderCard[] = [];
  let headerEndByte = -1;

  for (let blockStart = 0; blockStart + 2880 <= buffer.byteLength; blockStart += 2880) {
    const blockStr = decoder.decode(buffer.subarray(blockStart, blockStart + 2880));
    let foundEnd = false;
    for (let cardOffset = 0; cardOffset < 2880; cardOffset += 80) {
      const card = blockStr.slice(cardOffset, cardOffset + 80);
      const keyword = card.slice(0, 8).trim();
      if (keyword === 'END') {
        foundEnd = true;
        break;
      }
      if (!keyword || keyword === 'COMMENT' || keyword === 'HISTORY') {
        continue;
      }
      if (card.slice(8, 10) === '= ') {
        const rest = card.slice(10);
        const slashIdx = findCommentSlash(rest);
        const rawVal = (slashIdx >= 0 ? rest.slice(0, slashIdx) : rest).trim().replace(/^'(.*)'$/, '$1').trim();
        const comment = slashIdx >= 0 ? rest.slice(slashIdx + 1).trim() : '';
        headers.push({ keyword, value: rawVal, comment });
      }
    }
    if (foundEnd) {
      headerEndByte = blockStart + 2880;
      break;
    }
  }

  if (headerEndByte < 0) {
    throw new Error('未找到 FITS Header 结束标记 END');
  }

  const getHeader = (kw: string) => headers.find((h) => h.keyword === kw)?.value;
  if (getHeader('SIMPLE') !== 'T') {
    throw new Error('SIMPLE 关键字不为 T，非标准主 HDU FITS 文件');
  }

  const bitpix = Number(getHeader('BITPIX') ?? 0);
  const naxis = Number(getHeader('NAXIS') ?? 0);
  const width = Number(getHeader('NAXIS1') ?? 0);
  const height = Number(getHeader('NAXIS2') ?? 0);
  const bscale = Number(getHeader('BSCALE') ?? 1) || 1;
  const bzero = Number(getHeader('BZERO') ?? 0) || 0;
  const objectName = getHeader('OBJECT') ?? 'Unknown Field';
  const exptimeRaw = getHeader('EXPTIME');
  const exposureSec = exptimeRaw !== undefined && Number.isFinite(Number(exptimeRaw)) ? Number(exptimeRaw) : null;
  const filterName = getHeader('FILTER') ?? 'Clear';

  if (naxis < 2 || width <= 0 || height <= 0) {
    throw new Error(`仅支持 2D 图像 HDU（当前 NAXIS=${naxis}, ${width}x${height}）`);
  }

  const bytesPerPixel = Math.abs(bitpix) / 8;
  const totalPixels = width * height;
  const requiredDataBytes = totalPixels * bytesPerPixel;
  if (headerEndByte + requiredDataBytes > buffer.byteLength) {
    throw new Error(`FITS 数据区不完整：需要 ${requiredDataBytes} 字节，实际仅剩 ${buffer.byteLength - headerEndByte} 字节`);
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset + headerEndByte, requiredDataBytes);
  const pixels = new Array<number>(totalPixels);
  let minValue = Infinity;
  let maxValue = -Infinity;
  let sum = 0;

  for (let i = 0; i < totalPixels; i++) {
    const offset = i * bytesPerPixel;
    let raw = 0;
    if (bitpix === -32) {
      raw = view.getFloat32(offset, false);
    } else if (bitpix === -64) {
      raw = view.getFloat64(offset, false);
    } else if (bitpix === 16) {
      raw = view.getInt16(offset, false);
    } else if (bitpix === 32) {
      raw = view.getInt32(offset, false);
    } else if (bitpix === 8) {
      raw = view.getUint8(offset);
    } else {
      throw new Error(`不支持的 BITPIX=${bitpix}`);
    }
    const val = Number.isFinite(raw) ? raw * bscale + bzero : 0;
    pixels[i] = val;
    if (val < minValue) minValue = val;
    if (val > maxValue) maxValue = val;
    sum += val;
  }

  const meanValue = sum / totalPixels;
  const sorted = [...pixels].sort((a, b) => a - b);
  const medianSky = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const absDev = sorted.map((v) => Math.abs(v - medianSky)).sort((a, b) => a - b);
  const mad = absDev[Math.floor(absDev.length / 2)] ?? 0;
  const madNoise = Math.max(1e-6, mad * 1.4826);

  const detectedSources = detectApertureSources(pixels, width, height, medianSky, madNoise);

  return {
    fileName,
    byteLength: buffer.byteLength,
    bitpix,
    width,
    height,
    bscale,
    bzero,
    objectName,
    exposureSec,
    filterName,
    headers,
    minValue: Number(minValue.toFixed(3)),
    maxValue: Number(maxValue.toFixed(3)),
    meanValue: Number(meanValue.toFixed(3)),
    medianSky: Number(medianSky.toFixed(3)),
    madNoise: Number(madNoise.toFixed(3)),
    pixels,
    detectedSources,
  };
}

function findCommentSlash(str: string): number {
  let inQuote = false;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "'") inQuote = !inQuote;
    else if (str[i] === '/' && !inQuote) return i;
  }
  return -1;
}

function detectApertureSources(
  pixels: number[],
  width: number,
  height: number,
  medianSky: number,
  noiseSigma: number,
): FitsSourceDetection[] {
  const threshold = medianSky + 6 * noiseSigma;
  const peaks: Array<{ x: number; y: number; val: number }> = [];

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const val = pixels[y * width + x];
      if (val < threshold) continue;
      let isLocalMax = true;
      for (let dy = -2; dy <= 2 && isLocalMax; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (pixels[(y + dy) * width + (x + dx)] > val) {
            isLocalMax = false;
            break;
          }
        }
      }
      if (isLocalMax) {
        peaks.push({ x, y, val });
      }
    }
  }

  peaks.sort((a, b) => b.val - a.val);
  const selected: typeof peaks = [];
  for (const p of peaks) {
    if (selected.every((s) => Math.hypot(s.x - p.x, s.y - p.y) >= 6)) {
      selected.push(p);
    }
    if (selected.length >= 12) break;
  }

  return selected.map((peak, idx) => {
    const r = 4;
    let fluxSum = 0;
    let wx = 0;
    let wy = 0;
    let r2Weighted = 0;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = peak.x + dx;
        const py = peak.y + dy;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        if (dx * dx + dy * dy > r * r) continue;
        const net = Math.max(0, pixels[py * width + px] - medianSky);
        fluxSum += net;
        wx += px * net;
        wy += py * net;
      }
    }

    const cx = fluxSum > 0 ? wx / fluxSum : peak.x;
    const cy = fluxSum > 0 ? wy / fluxSum : peak.y;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = peak.x + dx;
        const py = peak.y + dy;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        if (dx * dx + dy * dy > r * r) continue;
        const net = Math.max(0, pixels[py * width + px] - medianSky);
        const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
        r2Weighted += d2 * net;
      }
    }

    const sigma = fluxSum > 0 ? Math.sqrt(r2Weighted / (2 * fluxSum)) : 1.0;
    const fwhm = sigma * 2.3548;
    const snr = (peak.val - medianSky) / noiseSigma;

    return {
      id: idx + 1,
      xCentroid: Number(cx.toFixed(2)),
      yCentroid: Number(cy.toFixed(2)),
      peakAdu: Number(peak.val.toFixed(1)),
      apertureFlux: Number(fluxSum.toFixed(1)),
      snrEstimate: Number(snr.toFixed(1)),
      fwhmPxEstimate: Number(fwhm.toFixed(2)),
    };
  });
}

function formatFitsCard(keyword: string, valueStr: string, comment: string): string {
  const kw = keyword.padEnd(8, ' ').slice(0, 8);
  const body = `= ${valueStr.padStart(20, ' ')} / ${comment}`;
  return (kw + body).padEnd(80, ' ').slice(0, 80);
}

/**
 * Generates an authentic IEEE-754 big-endian FITS binary calibration frame for deterministic testing.
 */
export function buildSampleFitsBuffer(options?: {
  width?: number;
  height?: number;
  objectName?: string;
}): Uint8Array {
  const width = options?.width ?? 96;
  const height = options?.height ?? 96;
  const objectName = options?.objectName ?? 'M42_CALIB_TEST';

  const cards = [
    formatFitsCard('SIMPLE', 'T', 'Standard FITS format'),
    formatFitsCard('BITPIX', '-32', 'IEEE 754 single-precision float'),
    formatFitsCard('NAXIS', '2', '2D calibration image'),
    formatFitsCard('NAXIS1', String(width), 'Image width in pixels'),
    formatFitsCard('NAXIS2', String(height), 'Image height in pixels'),
    formatFitsCard('BSCALE', '1.0', 'Physical scale factor'),
    formatFitsCard('BZERO', '0.0', 'Physical zero offset'),
    formatFitsCard('OBJECT', `'${objectName}'`, 'Calibration star field'),
    formatFitsCard('EXPTIME', '12.5', 'Exposure duration (s)'),
    formatFitsCard('FILTER', `'V_550nm'`, 'Johnson V passband'),
    'END'.padEnd(80, ' '),
  ];

  const headerRaw = cards.join('');
  const headerBlocks = Math.ceil(headerRaw.length / 2880) * 2880;
  const headerPadded = headerRaw.padEnd(headerBlocks, ' ');

  const dataBytes = width * height * 4;
  const dataBlocks = Math.ceil(dataBytes / 2880) * 2880;

  const out = new Uint8Array(headerBlocks + dataBlocks);
  const encoder = new TextEncoder();
  out.set(encoder.encode(headerPadded), 0);

  // Deterministic seeded pseudo-noise + 5 synthetic Gaussian stars
  const stars = [
    { x: 48.3, y: 47.7, amp: 4200, sigma: 1.65 },
    { x: 24.8, y: 31.2, amp: 2450, sigma: 1.55 },
    { x: 71.4, y: 66.8, amp: 1850, sigma: 1.7 },
    { x: 65.0, y: 22.5, amp: 980, sigma: 1.5 },
    { x: 18.5, y: 74.1, amp: 740, sigma: 1.6 },
  ];

  const view = new DataView(out.buffer, headerBlocks, dataBytes);
  let seed = 1337;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Box-Muller deterministic sky background ~ 115 ADU +/- 8.5
      const u1 = Math.max(1e-6, nextRand());
      const u2 = nextRand();
      const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      let val = 115 + 0.08 * x + 8.5 * gauss;
      for (const s of stars) {
        const d2 = (x - s.x) * (x - s.x) + (y - s.y) * (y - s.y);
        val += s.amp * Math.exp(-d2 / (2 * s.sigma * s.sigma));
      }
      view.setFloat32((y * width + x) * 4, val, false);
    }
  }

  return out;
}
