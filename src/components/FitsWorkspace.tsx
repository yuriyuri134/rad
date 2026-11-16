import { useEffect, useRef, useState } from 'react';
import { Upload, Sparkles } from 'lucide-react';
import type { FitsAnalysisResult } from '../core/types.ts';

type StretchMode = 'sqrt' | 'log' | 'linear';

export function FitsWorkspace() {
  const [analysis, setAnalysis] = useState<FitsAnalysisResult | null>(null);
  const [stretch, setStretch] = useState<StretchMode>('log');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ x: number; y: number; adu: number } | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const loadSampleFits = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/fits/sample');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '加载 FITS 样本失败');
      setAnalysis(data.analysis);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSampleFits();
  }, []);

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
        // Flip Y for astronomical bottom-up FITS display
        const srcRow = height - 1 - y;
        const val = pixels[srcRow * width + x] ?? low;
        const norm = Math.max(0, Math.min(1, (val - low) / (high - low)));
        let mapped = norm;
        if (stretch === 'sqrt') mapped = Math.sqrt(norm);
        else if (stretch === 'log') mapped = Math.log1p(norm * 60) / Math.log1p(60);

        const g = Math.round(mapped * 255);
        const idx = (y * width + x) * 4;
        imgData.data[idx] = Math.round(g * 0.92);
        imgData.data[idx + 1] = g;
        imgData.data[idx + 2] = Math.min(255, Math.round(g * 1.08));
        imgData.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }, [analysis, stretch]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!analysis || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const px = Math.floor(((e.clientX - rect.left) / rect.width) * analysis.width);
    const pyDisplay = Math.floor(((e.clientY - rect.top) / rect.height) * analysis.height);
    const pyFits = analysis.height - 1 - pyDisplay;
    if (px >= 0 && px < analysis.width && pyFits >= 0 && pyFits < analysis.height) {
      const adu = analysis.pixels[pyFits * analysis.width + px] ?? 0;
      setProbe({ x: px, y: pyFits, adu: Number(adu.toFixed(1)) });
    }
  };

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-6">
      {/* Control Strip */}
      <div className="bg-white border border-slate-200 rounded-md p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-slate-900">
            FITS 天文二进制观测数据解析台
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            纯 2880-byte Header 解析与 IEEE 大端序图像像素测量（对应组件：fits-photometry-reader）
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {(['linear', 'sqrt', 'log'] as StretchMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setStretch(m)}
                className={`px-2.5 py-1 text-xs font-mono rounded cursor-pointer ${
                  stretch === m ? 'bg-white text-slate-900 shadow-xs font-semibold' : 'text-slate-600'
                }`}
              >
                {m.toUpperCase()}
              </button>
            ))}
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
            onClick={loadSampleFits}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
            <span>重载标定 FITS 样本</span>
          </button>

          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded cursor-pointer">
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            <span>上传本地 .fits 文件</span>
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
        <div className="grid grid-cols-1 lg:grid-cols-[440px_1fr] gap-6 items-start">
          {/* Left: 2D Pixel Viewport */}
          <div className="bg-white border border-slate-200 rounded-md p-4 space-y-3">
            <div className="flex items-center justify-between text-xs font-mono text-slate-600">
              <span className="font-semibold text-slate-900">{analysis.fileName}</span>
              <span>
                {analysis.width}×{analysis.height} · BITPIX={analysis.bitpix}
              </span>
            </div>

            <div className="relative bg-slate-950 border border-slate-300 rounded overflow-hidden aspect-square">
              <canvas
                ref={canvasRef}
                onMouseMove={handleMouseMove}
                onMouseLeave={() => setProbe(null)}
                className="w-full h-full cursor-crosshair block"
                style={{ imageRendering: 'pixelated' }}
              />
              {showOverlay && (
                <svg
                  viewBox={`0 0 ${analysis.width} ${analysis.height}`}
                  className="absolute inset-0 w-full h-full pointer-events-none"
                >
                  {analysis.detectedSources.map((src) => {
                    const cy = analysis.height - 1 - src.yCentroid;
                    return (
                      <g key={src.id}>
                        <circle
                          cx={src.xCentroid}
                          cy={cy}
                          r="4"
                          fill="none"
                          stroke="#38bdf8"
                          strokeWidth="0.6"
                        />
                        <text
                          x={src.xCentroid + 4.5}
                          y={cy - 3}
                          className="fill-cyan-300 text-[3.5px] font-mono"
                        >
                          #{src.id}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              )}
              {probe && (
                <div className="absolute bottom-2 left-2 px-2 py-1 bg-slate-900/85 text-slate-100 text-[11px] font-mono rounded tabular-nums">
                  X={probe.x}, Y={probe.y} · {probe.adu} ADU
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
          </div>

          {/* Right: Detected Sources + Header Cards */}
          <div className="space-y-6">
            {/* Aperture Photometry Table */}
            <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">
                  孔径测光检测星表（&gt; 6σ 背景阈值）
                </h2>
                <span className="text-xs font-mono text-slate-500">
                  共检出 {analysis.detectedSources.length} 个点源
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono tabular-nums">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="px-4 py-2">ID</th>
                      <th className="px-4 py-2">质心 X (px)</th>
                      <th className="px-4 py-2">质心 Y (px)</th>
                      <th className="px-4 py-2">峰值 ADU</th>
                      <th className="px-4 py-2">净孔径通量</th>
                      <th className="px-4 py-2">SNR</th>
                      <th className="px-4 py-2">FWHM (px)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {analysis.detectedSources.map((src) => (
                      <tr key={src.id} className="hover:bg-slate-50">
                        <td className="px-4 py-2 font-semibold text-slate-900">#{src.id}</td>
                        <td className="px-4 py-2">{src.xCentroid.toFixed(2)}</td>
                        <td className="px-4 py-2">{src.yCentroid.toFixed(2)}</td>
                        <td className="px-4 py-2">{src.peakAdu.toFixed(1)}</td>
                        <td className="px-4 py-2">{src.apertureFlux.toFixed(1)}</td>
                        <td className="px-4 py-2 text-blue-700 font-medium">{src.snrEstimate.toFixed(1)}</td>
                        <td className="px-4 py-2">{src.fwhmPxEstimate.toFixed(2)}</td>
                      </tr>
                    ))}
                    {analysis.detectedSources.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-6 text-center text-slate-500 font-sans">
                          未检测到超过 6σ 阈值的点源。
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
                <h2 className="text-sm font-semibold text-slate-900">FITS 主 HDU 头卡片 (Header Cards)</h2>
                <span className="text-xs font-mono text-slate-500">
                  目标：{analysis.objectName} · 滤光片：{analysis.filterName}
                </span>
              </div>
              <div className="max-h-64 overflow-y-auto divide-y divide-slate-100 text-xs font-mono">
                {analysis.headers.map((h, i) => (
                  <div key={`${h.keyword}-${i}`} className="px-4 py-1.5 grid grid-cols-[110px_160px_1fr] gap-2">
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
