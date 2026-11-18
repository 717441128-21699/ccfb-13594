/**
 * 端到端校验：导出的交错 PNG 中，每一列的颜色必须来自该列映射到的源帧。
 * 用 6 张纯色帧（每帧唯一 RGB），读回成品按 interlacer 映射逐列核对。
 * 内存通路与流式（背压）通路各验一次。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planStrips, buildInterlacer } from "../src/core/dither.js";
import { effectiveLpi, pitchMm } from "../src/core/optics.js";
import { composeToImage, composeToSink } from "../src/core/engine.js";
import { createRgba, type RgbaImage } from "../src/core/image.js";
import { encodePng, loadImage, createStreamingPngSink } from "../src/platform/node.js";
import type { LensParams } from "../src/core/types.js";

const params: LensParams = {
  lpi: 75, measuredLpi: 74.8, thicknessMm: 0.5, refractiveIndex: 1.57,
  viewingDistanceMm: 300, frameCount: 6, printDpi: 1200
};
const COLORS: [number, number, number][] = [
  [230, 10, 10], [10, 230, 10], [10, 10, 230],
  [230, 230, 10], [230, 10, 230], [10, 230, 230]
];
const W = 3000, H = 240;
const frames: RgbaImage[] = COLORS.map((c) => {
  const img = createRgba(120, 60);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
  }
  return img;
});

function build() {
  const plan = planStrips(params, { outputWidthPx: W, dither: "hash" });
  return buildInterlacer(params, plan, effectiveLpi(params), pitchMm(params));
}

function verifyColumns(roundtrip: RgbaImage, interlacer: ReturnType<typeof build>): number {
  let mismatches = 0;
  for (let col = 0; col < W; col++) {
    const f = interlacer.frameOfColumn[col];
    const expected = COLORS[f];
    const idx = (120 * W + col) * 4;
    if (roundtrip.data[idx] !== expected[0] || roundtrip.data[idx + 1] !== expected[1] || roundtrip.data[idx + 2] !== expected[2]) {
      mismatches++;
    }
  }
  return mismatches;
}

describe("端到端：PNG 往返后列-帧对应不变", () => {
  it("内存通路：成品每一列都取自 interlacer 指定的源帧", async () => {
    const interlacer = build();
    const out = composeToImage(frames, interlacer, H);

    const dir = mkdtempSync(join(tmpdir(), "lenti-e2e-"));
    const file = join(dir, "card.png");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, await encodePng(out));
    const roundtrip = await loadImage(file);
    rmSync(dir, { recursive: true, force: true });

    expect(verifyColumns(roundtrip, interlacer)).toBe(0);
  });

  it("流式 sink（多带分块管道）：分带写盘的成品同样逐列正确", async () => {
    const interlacer = build();
    const dir = mkdtempSync(join(tmpdir(), "lenti-e2e-stream-"));
    const file = join(dir, "stream.png");
    const { sink, done } = createStreamingPngSink(W, H, file);
    // 故意用很小的条带高，制造大量 writeBand 与潜在背压
    composeToSink(frames, interlacer, H, sink, { bandHeight: 16 });
    await done();
    const roundtrip = await loadImage(file);
    rmSync(dir, { recursive: true, force: true });

    expect(roundtrip.width).toBe(W);
    expect(roundtrip.height).toBe(H);
    expect(verifyColumns(roundtrip, interlacer)).toBe(0);
  });
});
