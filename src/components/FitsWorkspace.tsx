import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Sparkles, Upload, ZoomIn, ZoomOut } from 'lucide-react';
import { pixelToWorldTan } from '../core/fits.ts';
import type { FitsAnalysisResult, FitsCatalogEntry, FitsSourceDetection } from '../core/types.ts';

type StretchMode = 'linear' | 'sqrt' | 'log' | 'asinh';
type ColorMap = 'grayscale' | 'viridis' | 'inferno';

interface FitsWorkspaceProps {
  catalog?: FitsCatalogEntry[];
  initialCatalogPath?: string | null;
  pythonSourcesOverride?: {
    extractor: string;
    fitsPath: string;
    detectedSources: FitsSourceDetection[];
    medianSkyAdu?: number;
    skyNoiseSigmaAdu?: number;
    medianFwhmPx?: number | null;
    medianFwhmArcsec?: number | null;
  } | null;
  onTriggerPythonExtract?: (params: {
    fitsPath: string;
    extractor: 'photutils_DAOStarFinder' | 'sep_extract';
    fwhmPx: number;
    thresholdSigma: number;
    apertureRadiusPx: number;
  }) => void;
  isJobRunning?: boolean;
}

function mapColormap(t: number, cmap: ColorMap): [number, number, number] {
  const v = Math.max(0, Math.min(1, t));
  if (cmap === 'grayscale') {
    const g = Math.round(v * 255);
    return [g, g, g];
  }
  if (cmap === 'viridis') {
    // Smooth perceptual approximation from deep purple -> teal -> yellow
    const r = Math.round(255 * Math.min(1, Math.max(0, 0.267 + 0.005 * v + 1.65 * v * v - 0.92 * v * v * v)));
    const g = Math.round(255 * Math.min(1, Math.max(0, 0.005 + 1.38 * v - 0.45 * v * v)));
    const b = Math.round(255 * Math.min(1, Math.max(0, 0.329 + 1.44 * v - 2.38 * v * v + 0.72 * v * v * v)));
    return [r, g, b];
  }
  // Inferno: black -> magenta -> orange -> bright yellow
  const r = Math.round(255 * Math.min(1, Math.max(0, 0.02 + 2.2 * v - 1.2 * v * v)));
  const g = Math.round(255 * Math.min(1, Math.max(0, -0.18 + 0.55 * v + 0.65 * v * v)));
  const b = Math.round(255 * Math.min(1, Math.max(0, 0.06 + 1.85 * v - 2.9 * v * v + 1.45 * v * v * v)));
  return [r, g, b];
}

export function FitsWorkspace({
  catalog = [],
  initialCatalogPath,
  pythonSourcesOverride,
  onTriggerPythonExtract,
  isJobRunning = false,
}: FitsWorkspaceProps) {
  const [selectedPath, setSelectedPath] = useState<string>(
    initialCatalogPath ||
      catalog.find((c) => c.fileName.includes('S3_3Lens') && c.fieldDeg === 0.6)?.relativePath ||
      catalog[0]?.relativePath ||
      '__sample__',
  );
  const [analysis, setAnalysis] = useState<FitsAnalysisResult | null>(null);
  const [stretch, setStretch] = useState<StretchMode>('asinh');
  const [colormap, setColormap] = useState<ColorMap>('grayscale');
  const [zoom, setZoom] = useState<number>(1);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [probe, setProbe] = useState<{
    x: number;
    y: number;
    adu: number;
    raDeg: number | null;
    decDeg: number | null;
  } | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);

  // Live Python extractor controls
  const [pyExtractor, setPyExtractor] = useState<'photutils_DAOStarFinder' | 'sep_extract'>(
    'photutils_DAOStarFinder',
  );
  const [pyFwhmPx, setPyFwhmPx] = useState<number>(1.5);
  const [pySigma, setPySigma] = useState<number>(4.5);
  const [pyAperturePx, setPyAperturePx] = useState<number>(4.0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (initialCatalogPath) {
      setSelectedPath(initialCatalogPath);
    }
  }, [initialCatalogPath]);

  const loadFitsByPath = async (targetPath: string) => {
    setLoading(true);
    setErrorMsg(null);
    setSelectedSourceId(null);
    try {
      const url =
        targetPath === '__sample__'
          ? '/api/fits/sample'
          : `/api/fits/inspect?path=${encodeURIComponent(targetPath)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载 FITS 文件失败');
      setAnalysis(data.analysis);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFitsByPath(selectedPath);
  }, [selectedPath]);

  const handleFileUpload = async (file: File | undefined) => {
    if (!file) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch('/api/fits/upload-raw', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-fits-filename': encodeURIComponent(file.name),
        },
        body: buf,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'FITS 二进制解析失败');
      setAnalysis(data.analysis);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const activeSources = useMemo(() => {
    if (
      pythonSourcesOverride &&
      selectedPath !== '__sample__' &&
      pythonSourcesOverride.fitsPath === selectedPath
    ) {
      return pythonSourcesOverride.detectedSources;
    }
    return analysis?.detectedSources ?? [];
  }, [analysis, pythonSourcesOverride, selectedPath]);

  const activeExtractorLabel = useMemo(() => {
    if (
      pythonSourcesOverride &&
      selectedPath !== '__sample__' &&
      pythonSourcesOverride.fitsPath === selectedPath
    ) {
      return `${pythonSourcesOverride.extractor} (Python 实算)`;
    }
    return 'ts_aperture (浏览器前视孔径检测)';
  }, [pythonSourcesOverride, selectedPath]);

  useEffect(() => {
    if (!analysis || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height, pixels, medianSky, madNoise, maxValue } = analysis;
    canvas.width = width;
    canvas.height = height;

    const imgData = ctx.createImageData(width, height);
    const low = Math.max(analysis.minValue, medianSky - 2 * madNoise);
    const high = Math.max(low + 1e-3, maxValue);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Astronomical bottom-up convention
        const srcRow = height - 1 - y;
        const val = pixels[srcRow * width + x] ?? low;
        const norm = Math.max(0, Math.min(1, (val - low) / (high - low)));
        let mapped = norm;
        if (stretch === 'sqrt') mapped = Math.sqrt(norm);
        else if (stretch === 'log') mapped = Math.log1p(norm * 80) / Math.log1p(80);
        else if (stretch === 'asinh') mapped = Math.asinh(norm * 24) / Math.asinh(24);

        const [r, g, b] = mapColormap(mapped, colormap);
        const idx = (y * width + x) * 4;
        imgData.data[idx] = r;
        imgData.data[idx + 1] = g;
        imgData.data[idx + 2] = b;
        imgData.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }, [analysis, stretch, colormap]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!analysis || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const px = Math.floor(((e.clientX - rect.left) / rect.width) * analysis.width);
    const pyDisplay = Math.floor(((e.clientY - rect.top) / rect.height) * analysis.height);
    const pyFits = analysis.height - 1 - pyDisplay;
    if (px >= 0 && px < analysis.width && pyFits >= 0 && pyFits < analysis.height) {
      const adu = analysis.pixels[pyFits * analysis.width + px] ?? 0;
      const world = analysis.wcs ? pixelToWorldTan(px, pyFits, analysis.wcs) : null;
      setProbe({
        x: px,
        y: pyFits,
        adu: Number(adu.toFixed(1)),
        raDeg: world ? world.raDeg : null,
        decDeg: world ? world.decDeg : null,
      });
    }
  };

  const selectedCatalogMeta = catalog.find((c) => c.relativePath === selectedPath);

  return (
    <div className="space-y-5">
      {/* Control Strip */}
      <div className="bg-white border border-slate-200 rounded-md p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-base font-semibold text-slate-900">
              2D FITS 星场、TAN WCS 与实测孔径测光检查器
            </h2>
            <span className="text-xs font-mono text-slate-500">
              IEEE Big-Endian 解析 · {catalog.length} 帧真实 WF-RC-1000 瓦片可用
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <label htmlFor="fits-catalog-select" className="text-xs font-medium text-slate-600">
              选择观测帧：
            </label>
            <select
              id="fits-catalog-select"
              value={selectedPath}
              onChange={(e) => setSelectedPath(e.target.value)}
              className="text-xs font-mono bg-slate-50 border border-slate-300 rounded px-2.5 py-1.5 text-slate-900 max-w-md"
            >
              {catalog.map((c) => (
                <option key={c.id} value={c.relativePath}>
                  {c.systemKey} · {c.fieldDeg.toFixed(2)}° ({c.fileName})
                </option>
              ))}
              <option value="__sample__">M42_CALIB_SAMPLE.fits (合成标定测试帧)</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {(['linear', 'sqrt', 'log', 'asinh'] as StretchMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setStretch(m)}
                className={`px-2 py-1 text-xs font-mono rounded cursor-pointer ${
                  stretch === m ? 'bg-white text-slate-900 shadow-xs font-semibold' : 'text-slate-600'
                }`}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {(['grayscale', 'viridis', 'inferno'] as ColorMap[]).map((cm) => (
              <button
                key={cm}
                type="button"
                onClick={() => setColormap(cm)}
                className={`px-2 py-1 text-xs font-mono rounded cursor-pointer ${
                  colormap === cm ? 'bg-white text-slate-900 shadow-xs font-semibold' : 'text-slate-600'
                }`}
              >
                {cm === 'grayscale' ? '灰阶' : cm}
              </button>
            ))}
          </div>

          <div className="flex items-center border border-slate-200 rounded bg-slate-50">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(1, Number((z - 0.5).toFixed(1))))}
              className="px-2 py-1 text-slate-700 hover:bg-slate-200 cursor-pointer"
              aria-label="缩小视场"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 text-xs font-mono tabular-nums text-slate-700">{zoom.toFixed(1)}x</span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(4, Number((z + 0.5).toFixed(1))))}
              className="px-2 py-1 text-slate-700 hover:bg-slate-200 cursor-pointer"
              aria-label="放大视场"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowOverlay((v) => !v)}
            className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
          >
            {showOverlay ? '隐藏星点标注' : '显示星点标注'}
          </button>

          <button
            type="button"
            onClick={() => loadFitsByPath('__sample__')}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
            <span>标定样本</span>
          </button>

          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded cursor-pointer">
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            <span>上传 .fits</span>
            <input
              type="file"
              accept=".fits,.fit,.fts"
              onChange={(e) => handleFileUpload(e.target.files?.[0])}
              className="sr-only"
            />
          </label>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded text-xs text-rose-800">{errorMsg}</div>
      )}

      {analysis && (
        <div className="grid grid-cols-1 xl:grid-cols-[480px_1fr] gap-6 items-start">
          {/* Left: Interactive FITS Pixel + WCS Canvas */}
          <div className="bg-white border border-slate-200 rounded-md p-4 space-y-3">
            <div className="flex items-center justify-between text-xs font-mono text-slate-600">
              <span className="font-semibold text-slate-900 truncate max-w-[260px]">{analysis.fileName}</span>
              <span className="tabular-nums">
                {analysis.width}×{analysis.height} · BITPIX={analysis.bitpix}
              </span>
            </div>

            {analysis.wcs && (
              <div className="p-2.5 bg-slate-50 border border-slate-200 rounded text-xs font-mono tabular-nums flex flex-wrap items-center justify-between gap-2 text-slate-700">
                <span>
                  WCS: {analysis.wcs.ctype1}/{analysis.wcs.ctype2} · Scale {analysis.wcs.pixelScaleArcsec}&quot;/px
                </span>
                <span>
                  中心 RA={analysis.wcs.centerRaDeg.toFixed(4)}° · Dec={analysis.wcs.centerDecDeg.toFixed(4)}°
                </span>
              </div>
            )}

            <div className="relative bg-slate-950 border border-slate-300 rounded overflow-auto aspect-square">
              <div
                className="relative origin-top-left"
                style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
              >
                <canvas
                  ref={canvasRef}
                  onMouseMove={handleMouseMove}
                  onMouseLeave={() => setProbe(null)}
                  className="w-full h-full cursor-crosshair block"
                  style={{ imageRendering: zoom >= 1.5 ? 'pixelated' : 'auto' }}
                />
                {showOverlay && (
                  <svg
                    viewBox={`0 0 ${analysis.width} ${analysis.height}`}
                    className="absolute inset-0 w-full h-full pointer-events-none"
                  >
                    {activeSources.map((src) => {
                      const cy = analysis.height - 1 - src.yCentroid;
                      const isSel = selectedSourceId === src.id;
                      return (
                        <g key={src.id}>
                          <circle
                            cx={src.xCentroid}
                            cy={cy}
                            r={isSel ? '10' : '6'}
                            fill="none"
                            stroke={isSel ? '#f59e0b' : '#38bdf8'}
                            strokeWidth={isSel ? '1.6' : '0.9'}
                          />
                          <text
                            x={src.xCentroid + 7.5}
                            y={cy - 4}
                            className="fill-cyan-300 font-mono"
                            style={{ fontSize: analysis.width > 200 ? '9px' : '3.5px' }}
                          >
                            #{src.id}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                )}
              </div>

              {probe && (
                <div className="sticky bottom-2 left-2 inline-block px-2.5 py-1 bg-slate-900/90 text-slate-100 text-[11px] font-mono rounded tabular-nums pointer-events-none m-2">
                  X={probe.x}, Y={probe.y} · {probe.adu} ADU
                  {probe.raDeg !== null && probe.decDeg !== null
                    ? ` · RA=${probe.raDeg.toFixed(5)}°, Dec=${probe.decDeg.toFixed(5)}°`
                    : ''}
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100 text-xs font-mono tabular-nums">
              <div>
                <div className="text-slate-400">天光背景中值</div>
                <div className="font-semibold text-slate-900">{analysis.medianSky} ADU</div>
              </div>
              <div>
                <div className="text-slate-400">MAD 背景噪声 σ</div>
                <div className="font-semibold text-slate-900">{analysis.madNoise} ADU</div>
              </div>
              <div>
                <div className="text-slate-400">峰值 / 最低</div>
                <div className="font-semibold text-slate-900">
                  {analysis.maxValue} / {analysis.minValue}
                </div>
              </div>
            </div>

            {selectedCatalogMeta?.summaryMetrics && (
              <div className="p-3 bg-slate-50 border border-slate-200 rounded text-xs space-y-1.5">
                <div className="font-semibold text-slate-800">
                  Stage 3 基准评测指标（外部验证导入 · SHA-256={selectedCatalogMeta.sha256.slice(0, 10)}…）
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono tabular-nums text-slate-700">
                  <div>DAOStarFinder(3px) 完备度: {selectedCatalogMeta.summaryMetrics.photutilsCompletenessPct ?? '?'}%</div>
                  <div>SEP 完备度: {selectedCatalogMeta.summaryMetrics.sepCompletenessPct ?? '?'}%</div>
                  <div>SEP 去畸变天测 RMS: {selectedCatalogMeta.summaryMetrics.sepAstrometryRmsArcsec ?? '?'}"</div>
                  <div>SEP 中位 FWHM: {selectedCatalogMeta.summaryMetrics.sepMedianFwhmArcsec ?? '?'}"</div>
                </div>
              </div>
            )}
          </div>

          {/* Right: Live Python Re-extraction Controls, Photometry Table & Header */}
          <div className="space-y-5">
            {onTriggerPythonExtract && selectedPath !== '__sample__' && (
              <div className="bg-white border border-slate-200 rounded-md p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      实时 Python 星表重提取实验 (Photutils / SEP)
                    </h3>
                    <p className="text-xs text-slate-500">
                      针对当前帧直接调用 Photutils DAOStarFinder 或 SEP 调整核宽与阈值，派生新分支并回显覆盖层
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={isJobRunning}
                    onClick={() =>
                      onTriggerPythonExtract({
                        fitsPath: selectedPath,
                        extractor: pyExtractor,
                        fwhmPx: pyFwhmPx,
                        thresholdSigma: pySigma,
                        apertureRadiusPx: pyAperturePx,
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{isJobRunning ? '执行中...' : '在当前 FITS 帧实算提取'}</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <label className="space-y-1">
                    <span className="text-slate-600 block">提取引擎</span>
                    <select
                      value={pyExtractor}
                      onChange={(e) =>
                        setPyExtractor(e.target.value as 'photutils_DAOStarFinder' | 'sep_extract')
                      }
                      className="w-full font-mono bg-slate-50 border border-slate-300 rounded px-2 py-1.5"
                    >
                      <option value="photutils_DAOStarFinder">photutils DAOStarFinder</option>
                      <option value="sep_extract">SEP SourceExtractor</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-600 block">核宽 FWHM (px)</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0.8"
                      max="8"
                      value={pyFwhmPx}
                      onChange={(e) => setPyFwhmPx(Number(e.target.value))}
                      className="w-full font-mono tabular-nums bg-slate-50 border border-slate-300 rounded px-2 py-1.5"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-600 block">检测阈值 (σ)</span>
                    <input
                      type="number"
                      step="0.5"
                      min="2"
                      max="20"
                      value={pySigma}
                      onChange={(e) => setPySigma(Number(e.target.value))}
                      className="w-full font-mono tabular-nums bg-slate-50 border border-slate-300 rounded px-2 py-1.5"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-600 block">孔径半径 (px)</span>
                    <input
                      type="number"
                      step="0.5"
                      min="2"
                      max="12"
                      value={pyAperturePx}
                      onChange={(e) => setPyAperturePx(Number(e.target.value))}
                      className="w-full font-mono tabular-nums bg-slate-50 border border-slate-300 rounded px-2 py-1.5"
                    />
                  </label>
                </div>
              </div>
            )}

            {/* Aperture Photometry Table */}
            <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-900">
                  检测星表与天体测量列表
                </h3>
                <span className="text-xs font-mono text-slate-600 tabular-nums">
                  {activeExtractorLabel} · 共 {activeSources.length} 个点源
                </span>
              </div>
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 sticky top-0">
                    <tr>
                      <th className="px-3 py-2">ID</th>
                      <th className="px-3 py-2">X / Y (px)</th>
                      <th className="px-3 py-2">RA / Dec (°)</th>
                      <th className="px-3 py-2">峰值 ADU</th>
                      <th className="px-3 py-2">净通量</th>
                      <th className="px-3 py-2">SNR</th>
                      <th className="px-3 py-2">FWHM (px / &quot;)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {activeSources.map((src) => (
                      <tr
                        key={src.id}
                        onClick={() => setSelectedSourceId(src.id)}
                        className={`cursor-pointer transition-colors ${
                          selectedSourceId === src.id ? 'bg-amber-50' : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="px-3 py-2 font-semibold text-slate-900">#{src.id}</td>
                        <td className="px-3 py-2">
                          {src.xCentroid.toFixed(2)}, {src.yCentroid.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {src.raDeg !== null && src.raDeg !== undefined && src.decDeg !== null && src.decDeg !== undefined
                            ? `${src.raDeg.toFixed(5)}, ${src.decDeg.toFixed(5)}`
                            : '—'}
                        </td>
                        <td className="px-3 py-2">{src.peakAdu.toFixed(1)}</td>
                        <td className="px-3 py-2">{src.apertureFlux.toFixed(1)}</td>
                        <td className="px-3 py-2 text-blue-700 font-medium">{src.snrEstimate.toFixed(1)}</td>
                        <td className="px-3 py-2">
                          {src.fwhmPxEstimate.toFixed(2)}
                          {src.fwhmArcsec ? ` (${src.fwhmArcsec.toFixed(2)}")` : ''}
                        </td>
                      </tr>
                    ))}
                    {activeSources.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-6 text-center text-slate-500 font-sans">
                          当前帧未检测到超过阈值的点源（S0 裸 RC 在 0.60° 因剧烈离轴像散能量分散是预期物理现象）。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Raw 2880-byte FITS Header Cards */}
            <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">FITS 主 HDU 头卡片 (Header Cards)</h3>
                <span className="text-xs font-mono text-slate-500">
                  目标：{analysis.objectName} · 滤光片：{analysis.filterName}
                </span>
              </div>
              <div className="max-h-56 overflow-y-auto divide-y divide-slate-100 text-xs font-mono">
                {analysis.headers.map((h, i) => (
                  <div key={`${h.keyword}-${i}`} className="px-4 py-1.5 grid grid-cols-[100px_150px_1fr] gap-2">
                    <span className="font-semibold text-slate-800">{h.keyword}</span>
                    <span className="text-blue-700 truncate">{h.value}</span>
                    <span className="text-slate-500 truncate">{h.comment}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
