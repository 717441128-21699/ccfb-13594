/**
 * 纯 TS 位图工具：双线性缩放、条带提取。
 * 不依赖 DOM，Node 与浏览器共用。
 */
import type { RgbaImage } from "./types.js";

export function createRgba(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/**
 * 双线性缩放（含 alpha 直通，源为不透明印刷图时走快速路径）。
 * 预计算映射表，逐行扫描，缓存源行指针避免重复乘法。
 */
export function resizeBilinear(src: RgbaImage, dstW: number, dstH: number): RgbaImage {
  const dst = createRgba(dstW, dstH);
  const sx = src.width / dstW;
  const sy = src.height / dstH;

  const x0 = new Int32Array(dstW);
  const x1 = new Int32Array(dstW);
  const wx = new Float32Array(dstW);
  for (let x = 0; x < dstW; x++) {
    const fx = (x + 0.5) * sx - 0.5;
    const i = Math.floor(fx);
    const i0 = Math.max(0, i);
    const i1 = Math.min(src.width - 1, i0 + 1);
    x0[x] = i0;
    x1[x] = i1;
    wx[x] = Math.min(1, Math.max(0, fx - i0));
  }

  const sd = src.data;
  const dd = dst.data;
  for (let y = 0; y < dstH; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const iy = Math.floor(fy);
    const iy0 = Math.max(0, iy);
    const iy1 = Math.min(src.height - 1, iy0 + 1);
    const wy = Math.min(1, Math.max(0, fy - iy0));
    const row0 = iy0 * src.width * 4;
    const row1 = iy1 * src.width * 4;
    const drow = y * dstW * 4;

    for (let x = 0; x < dstW; x++) {
      const a = row0 + x0[x] * 4;
      const b = row0 + x1[x] * 4;
      const c = row1 + x0[x] * 4;
      const d = row1 + x1[x] * 4;
      const w = wx[x];
      const di = drow + x * 4;

      // 常见情形：源不透明，跳过 alpha 混合的分支与除法
      if (sd[a + 3] === 255 && sd[b + 3] === 255 && sd[c + 3] === 255 && sd[d + 3] === 255) {
        for (let ch = 0; ch < 3; ch++) {
          const top = sd[a + ch] * (1 - w) + sd[b + ch] * w;
          const bot = sd[c + ch] * (1 - w) + sd[d + ch] * w;
          dd[di + ch] = top * (1 - wy) + bot * wy;
        }
        dd[di + 3] = 255;
      } else {
        for (let ch = 0; ch < 4; ch++) {
          const top = sd[a + ch] * (1 - w) + sd[b + ch] * w;
          const bot = sd[c + ch] * (1 - w) + sd[d + ch] * w;
          dd[di + ch] = top * (1 - wy) + bot * wy;
        }
      }
    }
  }
  return dst;
}
