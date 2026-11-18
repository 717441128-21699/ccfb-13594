/**
 * 观看模拟：给定角度，把各帧按光学权重混合成“眼睛看到的画面”。
 * 用于 three.js 预览的贴图序列，也用于量化串帧。
 */
import type { LensParams, RgbaImage } from "./types.js";
import { frameWeights } from "./optics.js";
import { createRgba, resizeBilinear } from "./image.js";

/**
 * 渲染某个角度的可见画面。
 * @param frames 已归一化到同尺寸的帧
 * @param phasePeriods 周期相位（失配扫描用）
 */
export function renderViewAtAngle(
  frames: RgbaImage[],
  p: LensParams,
  angleDeg: number,
  phasePeriods = 0
): RgbaImage {
  const w = frames[0].width;
  const h = frames[0].height;
  const weights = frameWeights((angleDeg * Math.PI) / 180, p, phasePeriods);
  const out = createRgba(w, h);
  const od = out.data;
  const total = weights.reduce((a, b) => a + b, 0);

  for (let f = 0; f < frames.length; f++) {
    const weight = weights[f] / total;
    if (weight < 1e-4) continue;
    const fd = frames[f].data;
    for (let i = 0; i < od.length; i += 4) {
      od[i] += fd[i] * weight;
      od[i + 1] += fd[i + 1] * weight;
      od[i + 2] += fd[i + 2] * weight;
    }
  }
  for (let i = 3; i < od.length; i += 4) od[i] = 255;
  return out;
}

/**
 * 预渲染一串角度的画面（three.js 转动预览用）。
 * 每帧先缩放到 previewW 宽，控制贴图内存与混合成本。
 */
export function renderViewSequence(
  frames: RgbaImage[],
  p: LensParams,
  anglesDeg: number[],
  previewW: number
): RgbaImage[] {
  const aspect = frames[0].height / frames[0].width;
  const previewH = Math.max(1, Math.round(previewW * aspect));
  const normalized = frames.map((f) =>
    f.width === previewW && f.height === previewH ? f : resizeBilinear(f, previewW, previewH)
  );
  return anglesDeg.map((a) => renderViewAtAngle(normalized, p, a));
}
