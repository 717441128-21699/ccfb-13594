import { describe, expect, it } from "vitest";
import { buildCalibrationBlocks, renderCalibrationTarget } from "../src/core/calibration.js";

describe("校准块", () => {
  it("默认 13 块、±3%、中间块等于标称线数", () => {
    const blocks = buildCalibrationBlocks(100);
    expect(blocks).toHaveLength(13);
    expect(blocks[0].deviationPct).toBeCloseTo(-3, 10);
    expect(blocks[12].deviationPct).toBeCloseTo(3, 10);
    const mid = blocks[6];
    expect(mid.lpi).toBeCloseTo(100, 10);
    expect(mid.deviationPct).toBeCloseTo(0, 10);
    expect(blocks.map((b) => b.index)).toEqual(blocks.map((_, i) => i + 1));
  });

  it("LPI 单调递增", () => {
    const blocks = buildCalibrationBlocks(75, { rangePct: 5, blockCount: 9 });
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].lpi).toBeGreaterThan(blocks[i - 1].lpi);
    }
  });
});

describe("校准图渲染", () => {
  it("尺寸匹配纸张×DPI 且白底起手、含黑色条纹像素", () => {
    // 小尺寸加速测试：50mm×35mm @ 300dpi
    const { image, blocks } = renderCalibrationTarget(100, 300, {
      paperWidthMm: 50,
      paperHeightMm: 35,
      marginMm: 3,
      blockCount: 5
    });
    expect(image.width).toBe(Math.round((50 * 300) / 25.4));
    expect(image.height).toBe(Math.round((35 * 300) / 25.4));
    expect(blocks).toHaveLength(5);

    // 左上角是白底
    const idx0 = (image.width + 2) * 4;
    expect(image.data[idx0]).toBe(255);

    // 全图存在黑像素（条纹/文字/边框）
    let black = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i] === 0 && image.data[i + 1] === 0 && image.data[i + 2] === 0) black++;
    }
    expect(black).toBeGreaterThan(1000);
  });

  it("每行像素均为不透明", () => {
    const { image } = renderCalibrationTarget(100, 300, {
      paperWidthMm: 40,
      paperHeightMm: 30,
      marginMm: 3,
      blockCount: 7
    });
    for (let i = 3; i < image.data.length; i += 4) {
      expect(image.data[i]).toBe(255);
    }
  });
});
