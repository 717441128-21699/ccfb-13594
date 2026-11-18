import { describe, expect, it } from "vitest";
import { planStrips, buildInterlacer } from "../src/core/dither.js";
import { composeToImage, composeToSink, MemorySink, AbortError } from "../src/core/engine.js";
import { createRgba, resizeBilinear } from "../src/core/image.js";
import { renderViewAtAngle } from "../src/core/simulation.js";
import { effectiveLpi, pitchMm } from "../src/core/optics.js";
import type { LensParams, RgbaImage } from "../src/core/types.js";

function solidFrame(w: number, h: number, rgb: [number, number, number]): RgbaImage {
  const img = createRgba(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rgb[0];
    img.data[i + 1] = rgb[1];
    img.data[i + 2] = rgb[2];
    img.data[i + 3] = 255;
  }
  return img;
}

const params: LensParams = {
  lpi: 100,
  thicknessMm: 0.58,
  refractiveIndex: 1.57,
  viewingDistanceMm: 350,
  frameCount: 4,
  printDpi: 600,
  measuredLpi: 100
};

const COLORS: [number, number, number][] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0]
];

describe("resizeBilinear", () => {
  it("同尺寸返回等价内容", () => {
    const src = solidFrame(8, 6, [10, 20, 30]);
    const out = resizeBilinear(src, 8, 6);
    expect(out.width).toBe(8);
    expect(out.height).toBe(6);
    expect(out.data[0]).toBe(10);
    expect(out.data[1]).toBe(20);
    expect(out.data[2]).toBe(30);
    expect(out.data[3]).toBe(255);
  });

  it("放大纯色图颜色保持", () => {
    const out = resizeBilinear(solidFrame(4, 4, [123, 45, 200]), 16, 12);
    expect(out.width).toBe(16);
    expect(out.height).toBe(12);
    expect(out.data[0]).toBe(123);
    expect(out.data[1]).toBe(45);
    expect(out.data[2]).toBe(200);
  });
});

describe("交错合成", () => {
  const frames = COLORS.map((c) => solidFrame(40, 30, c));

  it("输出尺寸正确且每列取自正确的帧颜色", () => {
    const plan = planStrips(params, { outputWidthPx: 480 });
    const interlacer = buildInterlacer(params, plan, effectiveLpi(params), pitchMm(params));
    const out = composeToImage(frames, interlacer, 360);
    expect(out.width).toBe(480);
    expect(out.height).toBe(360);

    for (let col = 0; col < 480; col++) {
      const f = interlacer.frameOfColumn[col];
      const expected = COLORS[f];
      const idx = (100 * 480 + col) * 4;
      expect([out.data[idx], out.data[idx + 1], out.data[idx + 2]]).toEqual([...expected]);
    }
  });

  it("MemorySink 与一次性合成结果一致", () => {
    const plan = planStrips(params, { outputWidthPx: 480 });
    const interlacer = buildInterlacer(params, plan, effectiveLpi(params), pitchMm(params));
    const sink = new MemorySink(480, 360);
    composeToSink(frames, interlacer, 360, sink, { bandHeight: 64 });
    const direct = composeToImage(frames, interlacer, 360);
    expect(Buffer.from(sink.image.data)).toEqual(Buffer.from(direct.data));
  });

  it("进度回调覆盖 0→1 且条带位置连续", () => {
    const plan = planStrips(params, { outputWidthPx: 480 });
    const interlacer = buildInterlacer(params, plan, effectiveLpi(params), pitchMm(params));
    const seen: number[] = [];
    composeToImage(frames, interlacer, 300, {
      bandHeight: 100,
      onProgress: (frac) => seen.push(frac)
    });
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });

  it("中止信号抛出 AbortError", () => {
    const plan = planStrips(params, { outputWidthPx: 480 });
    const interlacer = buildInterlacer(params, plan, effectiveLpi(params), pitchMm(params));
    expect(() =>
      composeToImage(frames, interlacer, 300, { shouldAbort: () => true })
    ).toThrow(AbortError);
  });
});

describe("观看模拟", () => {
  it("零角度画面为各帧按权重的合法混合（值域 0..255）", () => {
    const frames = COLORS.map((c) => solidFrame(16, 16, c));
    const view = renderViewAtAngle(frames, params, 0);
    expect(view.width).toBe(16);
    for (let i = 0; i < view.data.length; i++) {
      expect(view.data[i]).toBeGreaterThanOrEqual(0);
      expect(view.data[i]).toBeLessThanOrEqual(255);
    }
  });

  it("对称角度产生对称的左右画面（两帧立体对：左眼看帧0红，右眼看帧1蓝）", () => {
    const p2: LensParams = { ...params, frameCount: 2, stereo: true };
    const pair = [solidFrame(16, 16, [255, 0, 0]), solidFrame(16, 16, [0, 0, 255])];
    const left = renderViewAtAngle(pair, p2, -10);
    const right = renderViewAtAngle(pair, p2, 10);
    const li = 100 * 4;
    // 左眼（负角）偏红，右眼（正角）偏蓝
    expect(left.data[li]).toBeGreaterThan(left.data[li + 2]);
    expect(right.data[li + 2]).toBeGreaterThan(right.data[li]);
    // 对称角度下两眼的红蓝权重互换
    expect(left.data[li]).toBe(right.data[li + 2]);
    expect(left.data[li + 2]).toBe(right.data[li]);
  });
});
