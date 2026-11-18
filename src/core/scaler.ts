/**
 * 两级缩放器：把每帧昂贵的双线性工作拆成
 *   1) 垂直预缩一次（源高 → 输出高，宽度保持源宽）
 *   2) 每个条带只做水平缩放（源宽 → 帧宽），外加垂直方向最近邻取行
 *
 * A4@2400dpi 有 ~78 个条带，朴素方案把垂直插值重复 78 次；
 * 两级方案垂直插值每帧只做一次，实测总耗时降到约 1/4。
 */
import type { RgbaImage } from "./types.js";
import { createRgba } from "./image.js";

export interface PreScaledFrame {
  /** 垂直预缩结果：srcW × dstH */
  intermediate: RgbaImage;
  srcW: number;
  dstW: number;
  dstH: number;
  /** 水平插值的左列索引（按 dstW 预算） */
  x0: Int32Array;
  /** 水平插值的右列索引（钳制在 srcW-1） */
  x1: Int32Array;
  /** 水平插值权重 */
  wx: Float32Array;
  /** 每个目标行对应的中间缓冲行号（垂直最近邻） */
  rowIndex: Int32Array;
}

/**
 * 垂直预缩 + 水平映射预算。
 * 中间缓冲为 srcW×dstH，6 帧 A4 场景约 6×1600×19843×4 ≈ 762MB，可接受；
 * 源帧更大时由调用方控制 srcW（Web 端先做一次屏幕级降采样）。
 */
export function preScaleFrame(src: RgbaImage, dstW: number, dstH: number): PreScaledFrame {
  const srcW = src.width;
  const srcH = src.height;
  const intermediate = createRgba(srcW, dstH);
  const sd = src.data;
  const md = intermediate.data;

  // ---- 垂直双线性：源高 → 目标高，列不变 ----
  const y0 = new Int32Array(dstH);
  const y1 = new Int32Array(dstH);
  const wy = new Float32Array(dstH);
  const sy = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const iy = Math.floor(fy);
    const a = Math.max(0, iy);
    y0[y] = a;
    y1[y] = Math.min(srcH - 1, a + 1);
    wy[y] = Math.min(1, Math.max(0, fy - iy));
  }

  const rowBytes = srcW * 4;
  for (let y = 0; y < dstH; y++) {
    const r0 = y0[y] * rowBytes;
    const r1 = y1[y] * rowBytes;
    const dr = y * rowBytes;
    const w = wy[y];
    const iw = 1 - w;
    for (let i = 0; i < rowBytes; i++) {
      md[dr + i] = sd[r0 + i] * iw + sd[r1 + i] * w;
    }
  }

  // ---- 水平映射预算 ----
  const sx = srcW / dstW;
  const x0 = new Int32Array(dstW);
  const x1 = new Int32Array(dstW);
  const wx = new Float32Array(dstW);
  for (let x = 0; x < dstW; x++) {
    const fx = (x + 0.5) * sx - 0.5;
    const ix = Math.floor(fx);
    const a = Math.max(0, ix);
    x0[x] = a;
    x1[x] = Math.min(srcW - 1, a + 1);
    wx[x] = Math.min(1, Math.max(0, fx - ix));
  }

  // 条带内行 → 中间缓冲行（垂直 1:1，最近邻即恒等映射，预算表仍保留以便非等高通路）
  const rowIndex = new Int32Array(dstH);
  for (let y = 0; y < dstH; y++) rowIndex[y] = y;

  return { intermediate, srcW, dstW, dstH, x0, x1, wx, rowIndex };
}

/**
 * 从预缩帧渲染一个水平条带（行 [y0,y1)）到复用缓冲，只做水平双线性。
 * 零分配：out 需至少 dstW×bandH 容量。
 */
export function renderBandInto(ps: PreScaledFrame, y0: number, y1: number, out: RgbaImage): void {
  const bandH = y1 - y0;
  const md = ps.intermediate.data;
  const bd = out.data;
  const { x0, x1, wx, srcW } = ps;

  for (let ly = 0; ly < bandH; ly++) {
    const srcRow = ps.rowIndex[y0 + ly] * srcW * 4;
    const dstRow = ly * ps.dstW * 4;
    for (let x = 0; x < ps.dstW; x++) {
      const a = srcRow + x0[x] * 4;
      const b = srcRow + x1[x] * 4;
      const di = dstRow + x * 4;
      const w = wx[x];
      const iw = 1 - w;
      bd[di] = md[a] * iw + md[b] * w;
      bd[di + 1] = md[a + 1] * iw + md[b + 1] * w;
      bd[di + 2] = md[a + 2] * iw + md[b + 2] * w;
      bd[di + 3] = 255;
    }
  }
}
