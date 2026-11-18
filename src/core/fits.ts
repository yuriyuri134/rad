import type {
  FitsAnalysisResult,
  FitsHeaderCard,
  FitsSourceDetection,
  FitsWcsInfo,
} from './types.ts';

export interface ParseFitsOptions {
  maxSources?: number;
  thresholdSigma?: number;
  apertureRadiusPx?: number;
}

interface InternalTanWcs extends FitsWcsInfo {
  cd11: number;
  cd12: number;
  cd21: number;
  cd22: number;
}

export function extractTanWcs(headers: FitsHeaderCard[], width: number, height: number): FitsWcsInfo | null {
  const internal = buildInternalTanWcs(headers, width, height);
  if (!internal) return null;
  return {
    ctype1: internal.ctype1,
    ctype2: internal.ctype2,
    crval1: internal.crval1,
    crval2: internal.crval2,
    crpix1: internal.crpix1,
    crpix2: internal.crpix2,
    cdelt1: internal.cdelt1,
    cdelt2: internal.cdelt2,
    pixelScaleArcsec: internal.pixelScaleArcsec,
    centerRaDeg: internal.centerRaDeg,
    centerDecDeg: internal.centerDecDeg,
  };
}

function buildInternalTanWcs(
  headers: FitsHeaderCard[],
  width: number,
  height: number,
): InternalTanWcs | null {
  const getNum = (kw: string): number | null => {
    const raw = headers.find((h) => h.keyword === kw)?.value;
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const getStr = (kw: string): string | null => headers.find((h) => h.keyword === kw)?.value ?? null;

  const crval1 = getNum('CRVAL1');
  const crval2 = getNum('CRVAL2');
  const crpix1 = getNum('CRPIX1');
  const crpix2 = getNum('CRPIX2');
  if (crval1 === null || crval2 === null || crpix1 === null || crpix2 === null) {
    return null;
  }

  const ctype1 = getStr('CTYPE1') ?? 'RA---TAN';
  const ctype2 = getStr('CTYPE2') ?? 'DEC--TAN';

  const cd11Raw = getNum('CD1_1');
  const cd12Raw = getNum('CD1_2');
  const cd21Raw = getNum('CD2_1');
  const cd22Raw = getNum('CD2_2');
  const cdelt1Raw = getNum('CDELT1');
  const cdelt2Raw = getNum('CDELT2');

  let cd11 = 0;
  let cd12 = 0;
  let cd21 = 0;
  let cd22 = 0;

  if (cd11Raw !== null || cd22Raw !== null) {
    cd11 = cd11Raw ?? 0;
    cd12 = cd12Raw ?? 0;
    cd21 = cd21Raw ?? 0;
    cd22 = cd22Raw ?? 0;
  } else if (cdelt1Raw !== null && cdelt2Raw !== null) {
    const pc11 = getNum('PC1_1') ?? 1;
    const pc12 = getNum('PC1_2') ?? 0;
    const pc21 = getNum('PC2_1') ?? 0;
    const pc22 = getNum('PC2_2') ?? 1;
    cd11 = cdelt1Raw * pc11;
    cd12 = cdelt1Raw * pc12;
    cd21 = cdelt2Raw * pc21;
    cd22 = cdelt2Raw * pc22;
  } else {
    return null;
  }

  const scaleX = Math.hypot(cd11, cd21) * 3600;
  const scaleY = Math.hypot(cd12, cd22) * 3600;
  const pixelScaleArcsec = Number(((scaleX + scaleY) * 0.5).toFixed(4));

  const tempWcs: InternalTanWcs = {
    ctype1,
    ctype2,
    crval1,
    crval2,
    crpix1,
    crpix2,
    cdelt1: cdelt1Raw ?? cd11,
    cdelt2: cdelt2Raw ?? cd22,
    pixelScaleArcsec,
    centerRaDeg: crval1,
    centerDecDeg: crval2,
    cd11,
    cd12,
    cd21,
    cd22,
  };

  const centerWorld = projectTanInternal((width - 1) * 0.5, (height - 1) * 0.5, tempWcs);
  tempWcs.centerRaDeg = centerWorld.raDeg;
  tempWcs.centerDecDeg = centerWorld.decDeg;
  return tempWcs;
}

function projectTanInternal(x0Indexed: number, y0Indexed: number, wcs: InternalTanWcs): { raDeg: number; decDeg: number } {
  const dx = x0Indexed + 1 - wcs.crpix1;
  const dy = y0Indexed + 1 - wcs.crpix2;
  const xiDeg = wcs.cd11 * dx + wcs.cd12 * dy;
  const etaDeg = wcs.cd21 * dx + wcs.cd22 * dy;

  const deg2rad = Math.PI / 180;
  const xiRad = xiDeg * deg2rad;
  const etaRad = etaDeg * deg2rad;
  const alpha0 = wcs.crval1 * deg2rad;
  const delta0 = wcs.crval2 * deg2rad;

  const denom = Math.cos(delta0) - etaRad * Math.sin(delta0);
  let raDeg = (alpha0 + Math.atan2(xiRad, denom)) / deg2rad;
  raDeg = ((raDeg % 360) + 360) % 360;
  const decDeg = Math.atan2(Math.sin(delta0) + etaRad * Math.cos(delta0), Math.hypot(xiRad, denom)) / deg2rad;

  return {
    raDeg: Number(raDeg.toFixed(6)),
    decDeg: Number(decDeg.toFixed(6)),
  };
}

export function pixelToWorldTan(x0Indexed: number, y0Indexed: number, wcs: FitsWcsInfo): { raDeg: number; decDeg: number } {
  return projectTanInternal(x0Indexed, y0Indexed, {
    ...wcs,
    cd11: wcs.cdelt1,
    cd12: 0,
    cd21: 0,
    cd22: wcs.cdelt2,
  });
}

/**
 * Parses an authentic IEEE / IAU FITS binary file (2880-byte ASCII header blocks + big-endian image array).
 */
export function parseFitsBuffer(
  buffer: Uint8Array,
  fileName = 'observation.fits',
  options?: ParseFitsOptions,
): FitsAnalysisResult {
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

  const wcsInternal = buildInternalTanWcs(headers, width, height);
  const detectedSources = detectApertureSources(pixels, width, height, medianSky, madNoise, wcsInternal, options);

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
    wcs: wcsInternal
      ? {
          ctype1: wcsInternal.ctype1,
          ctype2: wcsInternal.ctype2,
          crval1: wcsInternal.crval1,
          crval2: wcsInternal.crval2,
          crpix1: wcsInternal.crpix1,
          crpix2: wcsInternal.crpix2,
          cdelt1: wcsInternal.cdelt1,
          cdelt2: wcsInternal.cdelt2,
          pixelScaleArcsec: wcsInternal.pixelScaleArcsec,
          centerRaDeg: wcsInternal.centerRaDeg,
          centerDecDeg: wcsInternal.centerDecDeg,
        }
      : null,
    extractorUsed: 'ts_aperture',
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
  wcs: InternalTanWcs | null,
  options?: ParseFitsOptions,
): FitsSourceDetection[] {
  const sigmaThresh = options?.thresholdSigma ?? 6;
  const maxSources = options?.maxSources ?? 64;
  const apertureRadius = Math.max(2, Math.min(10, Math.round(options?.apertureRadiusPx ?? 4)));
  const threshold = medianSky + sigmaThresh * noiseSigma;
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
    if (selected.length >= maxSources) break;
  }

  return selected.map((peak, idx) => {
    const r = apertureRadius;
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
    const world = wcs ? projectTanInternal(cx, cy, wcs) : null;
    const fwhmArcsec = wcs ? Number((fwhm * wcs.pixelScaleArcsec).toFixed(3)) : null;

    return {
      id: idx + 1,
      xCentroid: Number(cx.toFixed(2)),
      yCentroid: Number(cy.toFixed(2)),
      peakAdu: Number(peak.val.toFixed(1)),
      apertureFlux: Number(fluxSum.toFixed(1)),
      snrEstimate: Number(snr.toFixed(1)),
      fwhmPxEstimate: Number(fwhm.toFixed(2)),
      raDeg: world ? world.raDeg : null,
      decDeg: world ? world.decDeg : null,
      fwhmArcsec,
      extractor: 'ts_aperture',
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
