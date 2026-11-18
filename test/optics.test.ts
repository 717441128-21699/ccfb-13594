import { describe, expect, it } from "vitest";
import {
  effectiveLpi,
  pitchMm,
  pitchPx,
  stripWidthPx,
  shiftInPeriods,
  frameWeights,
  crosstalkReport,
  assessStereo,
  MM_PER_INCH
} from "../src/core/optics.js";
import type { LensParams } from "../src/core/types.js";

function makeParams(over: Partial<LensParams> = {}): LensParams {
  return {
    lpi: 100,
    thicknessMm: 0.58,
    refractiveIndex: 1.57,
    viewingDistanceMm: 350,
    frameCount: 3,
    printDpi: 2400,
    ...over
  };
}

describe("effectiveLpi 与节距", () => {
  it("有实测值时优先实测值", () => {
    const p = makeParams({ measuredLpi: 98.7 });
    expect(effectiveLpi(p)).toBe(98.7);
  });

  it("无实测值时按观看距离补偿，印刷节距大于物理节距", () => {
    const p = makeParams();
    const lpiEff = effectiveLpi(p);
    expect(lpiEff).toBeLessThan(p.lpi);
    const expected = p.lpi / (1 + p.thicknessMm / (p.refractiveIndex * p.viewingDistanceMm));
    expect(lpiEff).toBeCloseTo(expected, 8);
    expect(pitchMm(p)).toBeCloseTo(MM_PER_INCH / lpiEff, 8);
  });

  it("2400dpi / 100lpi 时节距约 24px", () => {
    const p = makeParams({ measuredLpi: 100 });
    expect(pitchPx(p)).toBeCloseTo(24, 6);
    expect(stripWidthPx(p)).toBeCloseTo(8, 6);
  });
});

describe("角度→帧位移", () => {
  it("零角度零位移，角度增大位移单调增大", () => {
    const p = makeParams({ measuredLpi: 100 });
    expect(shiftInPeriods(0, p)).toBeCloseTo(0, 10);
    const s10 = shiftInPeriods((10 * Math.PI) / 180, p);
    const s20 = shiftInPeriods((20 * Math.PI) / 180, p);
    expect(s20).toBeGreaterThan(s10);
    expect(s10).toBeGreaterThan(0);
  });

  it("负角度产生负位移", () => {
    const p = makeParams({ measuredLpi: 100 });
    expect(shiftInPeriods((-15 * Math.PI) / 180, p)).toBeLessThan(0);
  });
});

describe("frameWeights", () => {
  it("权重归一化且非负", () => {
    const p = makeParams();
    const w = frameWeights(0.2, p);
    expect(w).toHaveLength(p.frameCount);
    const sum = w.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 9);
    expect(w.every((v) => v >= 0)).toBe(true);
  });

  it("模糊增大时主导帧权重下降（串光更重）", () => {
    const p1 = makeParams({ blurSigmaFraction: 0.1 });
    const p2 = makeParams({ blurSigmaFraction: 0.4 });
    const w1 = frameWeights(0.25, p1);
    const w2 = frameWeights(0.25, p2);
    const max1 = Math.max(...w1);
    const max2 = Math.max(...w2);
    expect(max2).toBeLessThan(max1);
  });
});

describe("crosstalkReport", () => {
  it("扫描覆盖对称角度范围并给出最差角度", () => {
    const p = makeParams({ frameCount: 2, measuredLpi: 100 });
    const report = crosstalkReport(p, { halfRangeDeg: 45, stepDeg: 1 });
    expect(report.samples[0].angleDeg).toBe(-45);
    expect(report.samples.at(-1)!.angleDeg).toBe(45);
    expect(report.worstGhost.ghost).toBeGreaterThanOrEqual(0);
    expect(report.worstLeakage.leakage).toBeGreaterThanOrEqual(0);
  });

  it("节距失配会拉低整卡平均后的画面纯净度", () => {
    const p = makeParams({ frameCount: 3, measuredLpi: 100 });
    const clean = crosstalkReport(p, { mismatchPct: 0, stepDeg: 2 });
    const mismatched = crosstalkReport(p, { mismatchPct: 0.5, averageLenses: 300, stepDeg: 2 });
    const maxClean = Math.max(...clean.samples.map((s) => 1 - s.leakage));
    const maxMixed = Math.max(...mismatched.samples.map((s) => 1 - s.leakage));
    expect(maxMixed).toBeLessThan(maxClean);
  });

  it("立体模式返回双眼评估且角度对称", () => {
    const p = makeParams({ frameCount: 2, stereo: true, measuredLpi: 100 });
    const report = crosstalkReport(p);
    expect(report.stereo).not.toBeNull();
    expect(report.stereo!.leftEyeAngleDeg).toBeCloseTo(-report.stereo!.rightEyeAngleDeg, 9);
    expect(report.stereo!.leftPurity).toBeGreaterThan(0);
    expect(report.stereo!.rightPurity).toBeGreaterThan(0);
  });

  it("非立体模式 stereo 为 null", () => {
    const report = crosstalkReport(makeParams());
    expect(report.stereo).toBeNull();
  });
});

describe("assessStereo 几何", () => {
  it("观看距离越近，双眼半角越大", () => {
    const near = assessStereo(makeParams({ stereo: true, viewingDistanceMm: 200 }));
    const far = assessStereo(makeParams({ stereo: true, viewingDistanceMm: 600 }));
    expect(Math.abs(near.leftEyeAngleDeg)).toBeGreaterThan(Math.abs(far.leftEyeAngleDeg));
  });
});
