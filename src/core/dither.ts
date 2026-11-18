/**
 * 分条规划：把浮点条纹宽映射成整数印刷像素，并把除不尽的误差抖散。
 *
 * 为什么不能直接取整/四舍五入：
 *   节距 75.59px、6 帧时单条约 12.598px。若每条都取 13px，误差同向累积，
 *   每 1/0.598 ≈ 1.67 个节距就多出一整列——在画面上表现为周期性亮带/重影线。
 *
 * 三种策略：
 * - hash（默认）：随机化误差扩散。每条独立哈希决策 + 累积相位误差反馈到
 *   阈值，既无空间周期（肉眼/摩尔纹都看不到结构），又把条纹相对透镜的
 *   相位漂移始终锁在 ±1px 内。纯独立哈希是随机游走，跨整张卡会漂出数个
 *   节距，因此必须带反馈。
 * - error：      确定性误差传递（取整到最近目标边界），平均误差最小，
 *   但有理小数会产生短周期重复图案，仅在帧宽与节距整除性良好时使用
 * - floor：      保守基线（仅用于对照测试，会产生明显漂移，不建议生产使用）
 */
import type { DitherMode, Interlacer, LensParams } from "./types.js";
import { pitchPx, stripWidthPx } from "./optics.js";

/** 确定性 32 位哈希（同一参数永远得到同一张图，便于复版） */
export function hash32(x: number): number {
  let h = (x | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296; // 0..1
}

export interface PlanOptions {
  dither?: DitherMode;
  /** 输出图物理宽度，毫米；不给则按宽度像素与 DPI 反推 */
  outputWidthMm?: number;
  /** 直接指定输出宽度（印刷像素），优先于 outputWidthMm */
  outputWidthPx?: number;
}

export interface StripPlan {
  /** 每条的起始输出列 */
  starts: number[];
  /** 每条的像素宽度 */
  widths: number[];
  /** 每条对应的帧索引 */
  frames: number[];
  /** 透镜周期序号（每 frameCount 条 +1） */
  lensIndex: number[];
  widthPx: number;
  idealStripWidthPx: number;
  pitchPx: number;
}

/**
 * 生成整幅图的分条计划。
 * 条按透镜周期排列：第 j 个周期内依次是帧 0..N-1。
 */
export function planStrips(p: LensParams, opts: PlanOptions = {}): StripPlan {
  const ideal = stripWidthPx(p);
  const pitch = pitchPx(p);
  const n = p.frameCount;

  let widthPx: number;
  if (opts.outputWidthPx !== undefined) {
    widthPx = Math.round(opts.outputWidthPx);
  } else if (opts.outputWidthMm !== undefined) {
    widthPx = Math.round((opts.outputWidthMm * p.printDpi) / 25.4);
  } else {
    throw new Error("planStrips 需要 outputWidthPx 或 outputWidthMm");
  }

  const mode = opts.dither ?? "hash";
  const starts: number[] = [];
  const widths: number[] = [];
  const frames: number[] = [];
  const lensIndex: number[] = [];

  let cursor = 0;
  let strip = 0;
  // hash 模式的累积相位误差（理想光标 − 实际光标，像素），恒有 |acc| < 1
  let acc = 0;

  while (cursor < widthPx) {
    const lens = Math.floor(strip / n);
    const frame = strip % n;
    let w: number;

    if (mode === "floor") {
      w = Math.floor(ideal);
    } else if (mode === "error") {
      // 目标边界 = (strip+1)·ideal；相对实际光标取整，单步误差 ≤0.5px 且不累积
      const target = (strip + 1) * ideal;
      w = Math.round(target - cursor);
    } else {
      // 随机化误差扩散：基础概率 frac 加上历史欠账 acc。
      // acc>0（前面放窄了）→ 阈值抬高、本条更可能加宽，相位立刻回追；
      // 哈希保证决策无周期，反馈保证 |acc| 始终 < 1px。
      const base = Math.floor(ideal);
      const frac = ideal - base;
      w = base + (hash32(strip * 73856093) < frac + acc ? 1 : 0);
      acc += ideal - w;
    }

    if (w < 1) w = 1;
    if (cursor + w > widthPx) w = widthPx - cursor;

    starts.push(cursor);
    widths.push(w);
    frames.push(frame);
    lensIndex.push(lens);
    cursor += w;
    strip++;
  }

  return { starts, widths, frames, lensIndex, widthPx, idealStripWidthPx: ideal, pitchPx: pitch };
}

/**
 * 由分条计划构造交错器，并预计算每个输出列的取帧/取列映射。
 *
 * 源帧统一缩放到 frameWidthPx（= 周期数 × N 条，按整数条宽统计折算），
 * 每条取源帧的同一相对列，保证画面几何不错位。
 */
export function buildInterlacer(
  p: LensParams,
  plan: StripPlan,
  effectiveLpiValue: number,
  pitchMmValue: number
): Interlacer {
  const n = p.frameCount;
  const lensCount = plan.lensIndex[plan.lensIndex.length - 1] + 1;
  // 源帧宽度：每个透镜周期贡献 N 个“源像素列”，再按实际条宽做最近邻映射
  const frameWidthPx = Math.max(1, lensCount * n);

  const frameOfColumn = new Uint8Array(plan.widthPx);
  const sourceColumn = new Uint32Array(plan.widthPx);
  const histogram = new Map<number, number>();

  for (let s = 0; s < plan.starts.length; s++) {
    const start = plan.starts[s];
    const w = plan.widths[s];
    const frame = plan.frames[s];
    const lens = plan.lensIndex[s];
    histogram.set(w, (histogram.get(w) ?? 0) + 1);

    // 该条在源帧中的基准列：透镜 lens 的第 frame 条
    const srcBase = lens * n + frame;
    for (let x = 0; x < w; x++) {
      const col = start + x;
      frameOfColumn[col] = frame;
      // 条内多个印刷像素映射到同一源列（条宽 >1 时的重复采样）
      sourceColumn[col] = srcBase;
    }
  }

  return {
    widthPx: plan.widthPx,
    frameOfColumn,
    sourceColumn,
    stripWidthHistogram: histogram,
    idealStripWidthPx: plan.idealStripWidthPx,
    pitchPx: plan.pitchPx,
    pitchMm: pitchMmValue,
    effectiveLpi: effectiveLpiValue,
    frameWidthPx
  };
}
