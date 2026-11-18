/**
 * 分块交错合成引擎
 *
 * 内存策略：A4@2400dpi 成品 RGBA ≈ 2.1GB，不能整幅驻留。
 * 引擎按水平条带（band）工作，并把“缩放 + 交错”融合为单遍：
 *   1. 每帧先做一次垂直预缩（源高→输出高，宽度保持源宽）
 *   2. 每个输出条内源列恒定，直接对预缩缓冲做一次水平双线性，
 *      写入成品条带——省掉每帧 × 每带的中间帧缓冲与重复插值
 *   3. 通过 BandSink 交出条带后立即复用（CLI 可流式送入编码器）
 */
import type { Interlacer, RgbaImage } from "./types.js";
import { createRgba } from "./image.js";
import { preScaleFrame, type PreScaledFrame } from "./scaler.js";

export interface BandSink {
  /** 接收一个输出条带，y0 为其在整图中的起始行；同步返回后条带内存即被复用 */
  writeBand(band: RgbaImage, y0: number): void;
}

export interface ComposeOptions {
  /** 条带高度（行），默认 256 */
  bandHeight?: number;
  onProgress?: (fraction: number, y0: number, height: number) => void;
  /** 中止信号：返回 true 时尽快停止并抛出 */
  shouldAbort?: () => boolean;
}

export class AbortError extends Error {
  constructor() {
    super("交错合成已中止");
    this.name = "AbortError";
  }
}

/** 一个输出条的紧凑描述（条内所有列取同一帧、同一源列） */
interface OutputStrip {
  start: number;
  width: number;
  frame: number;
  srcCol: number;
}

function buildStrips(interlacer: Interlacer): OutputStrip[] {
  const strips: OutputStrip[] = [];
  const { widthPx, frameOfColumn, sourceColumn } = interlacer;
  let col = 0;
  while (col < widthPx) {
    const frame = frameOfColumn[col];
    const srcCol = sourceColumn[col];
    let end = col + 1;
    while (end < widthPx && frameOfColumn[end] === frame && sourceColumn[end] === srcCol) end++;
    strips.push({ start: col, width: end - col, frame, srcCol });
    col = end;
  }
  return strips;
}

/**
 * 把 N 帧合成为交错图，逐带写入 sink。
 *
 * @param frames      源帧（尺寸可不同，各自独立缩放）
 * @param interlacer  planStrips + buildInterlacer 产物
 * @param outHeight   输出图高度（印刷像素）
 */
export function composeToSink(
  frames: RgbaImage[],
  interlacer: Interlacer,
  outHeight: number,
  sink: BandSink,
  opts: ComposeOptions = {}
): void {
  const n = frames.length;
  if (n === 0) throw new Error("至少需要一帧");
  const bandH = Math.max(8, opts.bandHeight ?? 256);
  const outW = interlacer.widthPx;

  // 每帧一次垂直预缩 + 水平映射预算
  const prescaled: PreScaledFrame[] = frames.map((f) => preScaleFrame(f, interlacer.frameWidthPx, outHeight));
  const strips = buildStrips(interlacer);

  // 复用条带缓冲
  const outBand = createRgba(outW, bandH);
  const bd = outBand.data;

  for (let y0 = 0; y0 < outHeight; y0 += bandH) {
    if (opts.shouldAbort?.()) throw new AbortError();
    const h = Math.min(bandH, outHeight - y0);

    // 融合通路：按输出条做一次水平双线性，写满该条的全部列
    for (const strip of strips) {
      const ps = prescaled[strip.frame];
      const md = ps.intermediate.data;
      const { x0, x1, wx, srcW } = ps;
      const xa = x0[strip.srcCol];
      const xb = x1[strip.srcCol];
      const w = wx[strip.srcCol];
      const iw = 1 - w;
      const offA = xa * 4;
      const offB = xb * 4;
      const rowBytes = srcW * 4;

      for (let ly = 0; ly < h; ly++) {
        const srcRow = ps.rowIndex[y0 + ly] * rowBytes;
        const a = srcRow + offA;
        const b = srcRow + offB;
        const ar = md[a], ag = md[a + 1], ab = md[a + 2];
        const br = md[b], bg = md[b + 1], bb = md[b + 2];
        const r = ar * iw + br * w;
        const g = ag * iw + bg * w;
        const bl = ab * iw + bb * w;
        let di = (ly * outW + strip.start) * 4;
        const end = di + strip.width * 4;
        for (; di < end; di += 4) {
          bd[di] = r;
          bd[di + 1] = g;
          bd[di + 2] = bl;
          bd[di + 3] = 255;
        }
      }
    }

    // 交出条带（末带可能更矮，给 sink 一个精确高度的视图）
    const view = h === bandH ? outBand : { width: outW, height: h, data: outBand.data.subarray(0, outW * h * 4) };
    sink.writeBand(view, y0);
    opts.onProgress?.((y0 + h) / outHeight, y0, h);
  }
}

/** 收集到完整图像的 sink（小尺寸/预览用，大图请走流式 sink） */
export class MemorySink implements BandSink {
  readonly image: RgbaImage;
  private u8: Uint8ClampedArray<ArrayBuffer>;

  constructor(width: number, height: number) {
    this.image = createRgba(width, height);
    this.u8 = this.image.data;
  }

  writeBand(band: RgbaImage, y0: number): void {
    this.u8.set(band.data.subarray(0, band.width * band.height * 4), y0 * band.width * 4);
  }
}

/** 一次性合成到内存（便捷封装，输出尺寸需在内存可承受范围内） */
export function composeToImage(
  frames: RgbaImage[],
  interlacer: Interlacer,
  outHeight: number,
  opts: ComposeOptions = {}
): RgbaImage {
  const sink = new MemorySink(interlacer.widthPx, outHeight);
  composeToSink(frames, interlacer, outHeight, sink, opts);
  return sink.image;
}
