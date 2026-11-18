/**
 * 线数校准图
 *
 * 用法：按 printDpi 1:1 打印 → 把光栅板平贴其上 → 上下/左右轻微转动，
 * 某一块内的摩尔纹在某个角度完全静止（竖条与透镜柱对齐）→
 * 该块标注的 LPI 就是这块板材的实测线数，回填到参数 measuredLpi。
 *
 * 每块内竖条按各自的测试 LPI 精确换算像素宽，小数误差用与正式分条
 * 相同的哈希抖动散开，保证校准图本身不引入周期伪影。
 */
import type { CalibrationBlock, RgbaImage } from "./types.js";
import { MM_PER_INCH } from "./optics.js";
import { createRgba } from "./image.js";
import { hash32 } from "./dither.js";

export interface CalibrationOptions {
  /** 相对标称线数的扫描半幅，百分比，默认 3（即 ±3%） */
  rangePct?: number;
  /** 分块数，默认 13（奇数，正中一块等于标称线数） */
  blockCount?: number;
  /** 打印纸宽，毫米，默认 297（A4 横放长边） */
  paperWidthMm?: number;
  /** 打印纸高，毫米，默认 210 */
  paperHeightMm?: number;
  /** 页边距，毫米，默认 10 */
  marginMm?: number;
}

export function buildCalibrationBlocks(nominalLpi: number, opts: CalibrationOptions = {}): CalibrationBlock[] {
  const range = opts.rangePct ?? 3;
  const count = opts.blockCount ?? 13;
  const blocks: CalibrationBlock[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1) - 0.5; // -0.5..0.5
    const deviationPct = t * 2 * range;
    blocks.push({
      index: i + 1,
      lpi: nominalLpi * (1 + deviationPct / 100),
      deviationPct
    });
  }
  return blocks;
}

/* ---------------- 极简 5x7 点阵字库（数字/字母/常用符号） ---------------- */

const FONT: Record<string, number[]> = {
  "0": [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
  "1": [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
  "2": [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
  "3": [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
  "4": [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
  "5": [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
  "6": [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
  "7": [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
  "9": [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
  A: [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  B: [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
  C: [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
  D: [0x1C, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1C],
  E: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
  F: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
  G: [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
  H: [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  I: [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
  M: [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  P: [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
  Q: [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
  R: [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
  S: [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
  T: [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
  X: [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
  " ": [0, 0, 0, 0, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 0x0C, 0x0C],
  ",": [0, 0, 0, 0, 0x0C, 0x04, 0x08],
  ":": [0, 0x0C, 0x0C, 0, 0, 0x0C, 0x0C],
  "%": [0x19, 0x1A, 0x02, 0x04, 0x08, 0x0B, 0x13],
  "+": [0, 0, 0x04, 0x1F, 0x04, 0, 0],
  "-": [0, 0, 0, 0x1F, 0, 0, 0],
  "/": [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  "=": [0, 0, 0x1F, 0, 0x1F, 0]
};

function drawText(img: RgbaImage, text: string, x: number, y: number, scale: number): void {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch];
    if (!glyph) {
      cx += 6 * scale;
      continue;
    }
    for (let gy = 0; gy < 7; gy++) {
      const bits = glyph[gy];
      for (let gx = 0; gx < 5; gx++) {
        if (bits & (1 << (4 - gx))) {
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = cx + gx * scale + sx;
              const py = y + gy * scale + sy;
              if (px >= 0 && px < img.width && py >= 0 && py < img.height) {
                const idx = (py * img.width + px) * 4;
                img.data[idx] = 0;
                img.data[idx + 1] = 0;
                img.data[idx + 2] = 0;
                img.data[idx + 3] = 255;
              }
            }
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

function fillRect(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]): void {
  const xa = Math.max(0, Math.min(img.width, x0));
  const xb = Math.max(0, Math.min(img.width, x1));
  const ya = Math.max(0, Math.min(img.height, y0));
  const yb = Math.max(0, Math.min(img.height, y1));
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const idx = (y * img.width + x) * 4;
      img.data[idx] = rgb[0];
      img.data[idx + 1] = rgb[1];
      img.data[idx + 2] = rgb[2];
      img.data[idx + 3] = 255;
    }
  }
}

/** 按测试 LPI 在指定矩形内画黑白竖条，随机化误差扩散散开取整误差 */
function drawBars(img: RgbaImage, x0: number, y0: number, w: number, h: number, lpi: number, dpi: number): void {
  const periodPx = (MM_PER_INCH / lpi) * (dpi / MM_PER_INCH); // = dpi / lpi
  const ideal = periodPx / 2;
  const base = Math.floor(ideal);
  const frac = ideal - base;
  let cursor = 0;
  let bar = 0;
  let acc = 0;
  while (cursor < w) {
    const bw = Math.max(1, base + (hash32(bar * 2654435761 >>> 0) < frac + acc ? 1 : 0));
    acc += ideal - bw;
    const clamped = Math.min(bw, w - cursor);
    if (bar % 2 === 0) {
      fillRect(img, x0 + cursor, y0, x0 + cursor + clamped, y0 + h, [0, 0, 0]);
    }
    cursor += clamped;
    bar++;
  }
}

export interface CalibrationTarget {
  image: RgbaImage;
  blocks: CalibrationBlock[];
}

/**
 * 生成整张校准图（白底黑字）。
 * 块数 <=7 单行排列，否则两行；每块含编号、条纹区、LPI 标注与偏差百分比。
 */
export function renderCalibrationTarget(
  nominalLpi: number,
  dpi: number,
  opts: CalibrationOptions = {}
): CalibrationTarget {
  const blocks = buildCalibrationBlocks(nominalLpi, opts);
  const paperWmm = opts.paperWidthMm ?? 297;
  const paperHmm = opts.paperHeightMm ?? 210;
  const marginMm = opts.marginMm ?? 10;
  const pxPerMm = dpi / MM_PER_INCH;

  const W = Math.round(paperWmm * pxPerMm);
  const H = Math.round(paperHmm * pxPerMm);
  const img = createRgba(W, H);
  fillRect(img, 0, 0, W, H, [255, 255, 255]);

  const margin = Math.round(marginMm * pxPerMm);
  const fontScale = Math.max(2, Math.round(pxPerMm * 0.5));
  const headerH = fontScale * 16;
  const footerH = fontScale * 18;

  drawText(img, `LENTICULAR LPI CALIBRATION  NOMINAL ${nominalLpi} LPI`, margin, margin, fontScale);
  drawText(img, `PRINT 1:1 AT ${dpi} DPI - DO NOT SCALE`, margin, margin + fontScale * 9, fontScale);

  // 角部裁切对位线
  const crop = Math.round(5 * pxPerMm);
  for (const [cx, cy] of [
    [margin, margin],
    [W - margin, margin],
    [margin, H - margin],
    [W - margin, H - margin]
  ] as const) {
    fillRect(img, cx - crop, cy - 1, cx + crop, cy + 1, [0, 0, 0]);
    fillRect(img, cx - 1, cy - crop, cx + 1, cy + crop, [0, 0, 0]);
  }

  const areaX0 = margin;
  const areaX1 = W - margin;
  const areaY0 = margin + headerH;
  const areaY1 = H - margin;
  const rows = blocks.length <= 7 ? 1 : 2;
  const gap = Math.round(2 * pxPerMm);
  const rowH = Math.floor((areaY1 - areaY0 - gap * (rows - 1)) / rows);
  const blockW = Math.floor((areaX1 - areaX0 - gap * (Math.ceil(blocks.length / rows) - 1)) / Math.ceil(blocks.length / rows));

  blocks.forEach((b, i) => {
    const row = rows === 1 ? 0 : i < Math.ceil(blocks.length / 2) ? 0 : 1;
    const col = rows === 1 ? i : i - (row === 1 ? Math.ceil(blocks.length / 2) : 0);
    const x0 = areaX0 + col * (blockW + gap);
    const y0 = areaY0 + row * (rowH + gap);
    const x1 = x0 + blockW;
    const y1 = y0 + rowH;

    // 边框
    fillRect(img, x0, y0, x1, y0 + 2, [0, 0, 0]);
    fillRect(img, x0, y1 - 2, x1, y1, [0, 0, 0]);
    fillRect(img, x0, y0, x0 + 2, y1, [0, 0, 0]);
    fillRect(img, x1 - 2, y0, x1, y1, [0, 0, 0]);

    drawText(img, `${b.index}`, x0 + 6, y0 + 6, fontScale);
    const barsY0 = y0 + fontScale * 10;
    const barsY1 = y1 - footerH;
    drawBars(img, x0 + 2, barsY0, blockW - 4, barsY1 - barsY0, b.lpi, dpi);

    const label = `${b.lpi.toFixed(1)} LPI`;
    const dev = `${b.deviationPct >= 0 ? "+" : ""}${b.deviationPct.toFixed(2)}%`;
    drawText(img, label, x0 + 6, y1 - footerH + 4, fontScale);
    drawText(img, dev, x0 + 6, y1 - Math.round(footerH / 2), fontScale);
  });

  return { image: img, blocks };
}
