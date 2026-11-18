import { describe, expect, it } from "vitest";
import { planStrips, hash32, buildInterlacer } from "../src/core/dither.js";
import { effectiveLpi, pitchMm, pitchPx } from "../src/core/optics.js";
import type { LensParams } from "../src/core/types.js";

const baseParams: LensParams = {
  lpi: 100,
  thicknessMm: 0.58,
  refractiveIndex: 1.57,
  viewingDistanceMm: 350,
  frameCount: 6,
  printDpi: 2400
};

/** 用非整数节距参数，取整误差真实存在（100lpi/2400dpi 恰好整除，测不出问题） */
const fractionalParams: LensParams = {
  ...baseParams,
  lpi: 75,
  measuredLpi: 75 // 节距 = 2400/75 = 32px，单条 32/6 ≈ 5.333px
};

describe("hash32 确定性", () => {
  it("同一输入恒定输出且落在 0..1", () => {
    expect(hash32(42)).toBe(hash32(42));
    for (let i = 0; i < 1000; i++) {
      const v = hash32(i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("planStrips 几何正确性", () => {
  it("条带完整覆盖输出宽度且首尾相接", () => {
    const plan = planStrips(baseParams, { outputWidthPx: 10000, dither: "hash" });
    expect(plan.starts[0]).toBe(0);
    let cursor = 0;
    for (let i = 0; i < plan.starts.length; i++) {
      expect(plan.starts[i]).toBe(cursor);
      cursor += plan.widths[i];
    }
    expect(cursor).toBe(10000);
  });

  it("帧序号按 0..N-1 循环", () => {
    const plan = planStrips(baseParams, { outputWidthPx: 5000 });
    for (let i = 0; i < plan.starts.length; i++) {
      expect(plan.frames[i]).toBe(i % baseParams.frameCount);
    }
  });

  it("非末段条宽只取相邻两整数（末条允许被边界截断）", () => {
    const plan = planStrips(fractionalParams, { outputWidthPx: 50000, dither: "hash" });
    const ideal = plan.idealStripWidthPx;
    const lo = Math.floor(ideal);
    const hi = Math.ceil(ideal);
    for (let i = 0; i < plan.widths.length - 1; i++) {
      const w = plan.widths[i];
      expect(w === lo || w === hi).toBe(true);
    }
  });

  it("平均条宽收敛到理想值（误差被抖散而非累积）", () => {
    const plan = planStrips(fractionalParams, { outputWidthPx: 200000, dither: "hash" });
    const sum = plan.widths.reduce((a, b) => a + b, 0);
    const avg = sum / plan.widths.length;
    expect(Math.abs(avg - plan.idealStripWidthPx)).toBeLessThan(0.01);
  });
});

describe("无周期性亮带（核心质量约束）", () => {
  /** 边界误差：第 k 条结束处实际光标与理想边界之差（像素） */
  function boundaryErrors(plan: ReturnType<typeof planStrips>): number[] {
    const ideal = plan.idealStripWidthPx;
    const errs: number[] = [];
    let cursor = 0;
    for (let k = 0; k < plan.widths.length; k++) {
      cursor += plan.widths[k];
      errs.push(cursor - (k + 1) * ideal);
    }
    return errs;
  }

  /** 滑动窗口内平均条宽偏差，检验误差是否在局部被摊平 */
  function windowMeanBias(widths: number[], ideal: number, window: number): number {
    let worst = 0;
    for (let i = 0; i + window <= widths.length; i += Math.floor(window / 2)) {
      let sum = 0;
      for (let j = 0; j < window; j++) sum += widths[i + j];
      worst = Math.max(worst, Math.abs(sum / window - ideal));
    }
    return worst;
  }

  it("hash 模式边界误差有界（始终 <1px），无长程漂移", () => {
    const plan = planStrips(fractionalParams, { outputWidthPx: 200000, dither: "hash" });
    const errs = boundaryErrors(plan);
    expect(Math.max(...errs.map(Math.abs))).toBeLessThan(1);
  });

  it("hash 模式任意 64 条窗口的平均宽偏差趋近于零（亮带不可累积）", () => {
    const plan = planStrips(fractionalParams, { outputWidthPx: 200000, dither: "hash" });
    const bias = windowMeanBias(plan.widths, plan.idealStripWidthPx, 64);
    expect(bias).toBeLessThan(0.08);
  });

  it("error 模式边界误差同样有界且单步不跳变", () => {
    const plan = planStrips(fractionalParams, { outputWidthPx: 200000, dither: "error" });
    const errs = boundaryErrors(plan).slice(0, -1); // 排除末条截断
    expect(Math.max(...errs.map(Math.abs))).toBeLessThan(1);
    for (let i = 1; i < errs.length; i++) {
      expect(Math.abs(errs[i] - errs[i - 1])).toBeLessThan(1.5);
    }
  });

  it("floor 模式暴露问题：持续同向偏差，卡内边界漂移超过一个完整节距（亮带根因）", () => {
    const plan = planStrips(fractionalParams, { outputWidthPx: 200000, dither: "floor" });
    const errs = boundaryErrors(plan);
    const maxDrift = Math.max(...errs.map(Math.abs));
    // ideal=5.333，每条欠 0.333px，每约 16 条（不足 3 个透镜周期）就漂出一整列
    expect(maxDrift).toBeGreaterThan(plan.pitchPx);
    // 且漂移单调
    expect(errs[errs.length - 1]).toBeLessThan(errs[0]);
  });

  /** lag>=2 的自相关峰值绝对值；lag-1 的负相关是误差反馈的正常特征，不算周期 */
  function periodicPeak(widths: number[], maxLag: number): number {
    const mean = widths.reduce((a, b) => a + b, 0) / widths.length;
    const centered = widths.map((v) => v - mean);
    let denom = 0;
    for (const v of centered) denom += v * v;
    if (denom === 0) return 0; // 恒定序列（floor 整除情形）无统计相关，漂移另由边界误差测试覆盖
    let peak = 0;
    for (let lag = 2; lag <= maxLag; lag++) {
      let num = 0;
      for (let i = 0; i + lag < centered.length; i++) num += centered[i] * centered[i + lag];
      peak = Math.max(peak, Math.abs(num / denom));
    }
    return peak;
  }

  it("hash 模式无长程周期峰（lag≥2 相关接近零），亮带无立足结构", () => {
    const plan = planStrips(fractionalParams, { outputWidthPx: 200000, dither: "hash" });
    // 实测约 0.13；反馈带来的 lag-1 负相关被排除在外
    expect(periodicPeak(plan.widths, 200)).toBeLessThan(0.2);
  });

  it("error 模式对照：确定性取整产生强周期峰（故仅在整除性好时可选）", () => {
    const plan = planStrips(fractionalParams, { outputWidthPx: 200000, dither: "error" });
    expect(periodicPeak(plan.widths, 200)).toBeGreaterThan(0.5);
  });
});

describe("buildInterlacer 映射", () => {
  it("每列帧索引与分条计划一致，源列在条内恒定", () => {
    const plan = planStrips(baseParams, { outputWidthPx: 8000 });
    const interlacer = buildInterlacer(baseParams, plan, effectiveLpi(baseParams), pitchMm(baseParams));
    for (let s = 0; s < plan.starts.length; s++) {
      for (let x = plan.starts[s]; x < plan.starts[s] + plan.widths[s]; x++) {
        expect(interlacer.frameOfColumn[x]).toBe(plan.frames[s]);
      }
      const src = interlacer.sourceColumn[plan.starts[s]];
      for (let x = plan.starts[s]; x < plan.starts[s] + plan.widths[s]; x++) {
        expect(interlacer.sourceColumn[x]).toBe(src);
      }
    }
    expect(interlacer.widthPx).toBe(8000);
    expect(interlacer.pitchPx).toBeCloseTo(pitchPx(baseParams), 6);
  });

  it("源帧宽 = 透镜数 × 帧数，源列不越界", () => {
    const plan = planStrips(fractionalParams, { outputWidthPx: 9999 });
    const interlacer = buildInterlacer(fractionalParams, plan, effectiveLpi(fractionalParams), pitchMm(fractionalParams));
    const lensCount = plan.lensIndex[plan.lensIndex.length - 1] + 1;
    expect(interlacer.frameWidthPx).toBe(lensCount * fractionalParams.frameCount);
    for (let x = 0; x < interlacer.widthPx; x++) {
      expect(interlacer.sourceColumn[x]).toBeLessThan(interlacer.frameWidthPx);
    }
  });
});
