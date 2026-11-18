/**
 * 性能基准：A4（或自定义尺寸）@ 印刷 DPI 的全分辨率交错合成计时。
 *
 * 用法：
 *   npm run bench -- --lpi 100 --frames 6 --dpi 2400 --paper A4
 *
 * 目标：A4 @2400dpi（约 22453×15874，2.86GB 成品）纯合成 ≤ 8 秒。
 * 合成阶段不含 PNG 编码（编码受磁盘/压缩库限制，另行计时并单列）。
 */
import { performance } from "node:perf_hooks";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { planStrips, buildInterlacer } from "../core/dither.js";
import { effectiveLpi, pitchMm } from "../core/optics.js";
import { composeToSink, type BandSink } from "../core/engine.js";
import { createRgba } from "../core/image.js";
import type { DitherMode, LensParams, RgbaImage } from "../core/types.js";
import { createStreamingPngSink } from "../platform/node.js";

const PAPERS: Record<string, [number, number]> = {
  A4: [297, 210],
  A5: [210, 148],
  A3: [420, 297]
};

interface CliArgs {
  lpi: number;
  frames: number;
  dpi: number;
  paper: string;
  widthMm?: number;
  heightMm?: number;
  thickness: number;
  index: number;
  distance: number;
  dither: DitherMode;
  band: number;
  out?: string;
  runs: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (key: string, def?: string): string | undefined => {
    const i = argv.indexOf(`--${key}`);
    return i >= 0 ? argv[i + 1] : def;
  };
  return {
    lpi: Number(get("lpi", "100")),
    frames: Number(get("frames", "6")),
    dpi: Number(get("dpi", "2400")),
    paper: get("paper", "A4")!,
    widthMm: get("widthMm") ? Number(get("widthMm")) : undefined,
    heightMm: get("heightMm") ? Number(get("heightMm")) : undefined,
    thickness: Number(get("thickness", "0.58")),
    index: Number(get("index", "1.57")),
    distance: Number(get("distance", "350")),
    dither: (get("dither", "hash") as DitherMode),
    band: Number(get("band", "256")),
    out: get("out"),
    runs: Number(get("runs", "3"))
  };
}

/** 生成带几何图案的合成测试帧（避免外部素材依赖，且能直观看出错位） */
function makePatternFrame(w: number, h: number, frame: number, frameCount: number): RgbaImage {
  const img = createRgba(w, h);
  const d = img.data;
  const hue = (frame / frameCount) * 360;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      // 每帧错开的斜条纹 + 帧专属底色，合成后若取帧错误会立刻可见
      const stripe = Math.sin((x + frame * w * 0.37) / 14) + Math.sin(y / 9 + frame);
      const [r, g, b] = hslToRgb(hue, 0.7, 0.25 + 0.35 * (stripe > 0 ? 1 : 0));
      d[idx] = r;
      d[idx + 1] = g;
      d[idx + 2] = b;
      d[idx + 3] = 255;
    }
  }
  return img;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** 空 sink：纯合成速度基准，零 IO */
class NullSink implements BandSink {
  bytes = 0;
  writeBand(band: RgbaImage): void {
    this.bytes += band.data.byteLength;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [pw, ph] = [args.widthMm ?? PAPERS[args.paper][0], args.heightMm ?? PAPERS[args.paper][1]];
  const outW = Math.round((pw * args.dpi) / 25.4);
  const outH = Math.round((ph * args.dpi) / 25.4);

  const params: LensParams = {
    lpi: args.lpi,
    thicknessMm: args.thickness,
    refractiveIndex: args.index,
    viewingDistanceMm: args.distance,
    frameCount: args.frames,
    printDpi: args.dpi
  };

  const plan = planStrips(params, { outputWidthPx: outW, dither: args.dither });
  const interlacer = buildInterlacer(params, plan, effectiveLpi(params), pitchMm(params));

  console.log("=== 光栅交错基准 ===");
  console.log(`纸张 ${args.paper} ${pw}×${ph}mm @ ${args.dpi}dpi → ${outW}×${outH}px`);
  console.log(`帧数 ${args.frames}，LPI ${effectiveLpi(params).toFixed(3)}，节距 ${interlacer.pitchPx.toFixed(3)}px，单条 ${interlacer.idealStripWidthPx.toFixed(3)}px`);
  console.log(`条宽分布: ${[...interlacer.stripWidthHistogram.entries()].sort((a, b) => a[0] - b[0]).map(([w, c]) => `${w}px×${c}`).join(", ")}`);
  console.log(`源帧宽 ${interlacer.frameWidthPx}px，输出 RGBA ${(outW * outH * 4 / 1024 / 1024).toFixed(0)}MB，抖动 ${args.dither}，条带高 ${args.band}px`);

  // 小尺寸源帧模拟真实素材（相机/设计稿），引擎内部按带放大
  const srcW = 1600;
  const srcH = Math.max(64, Math.round((srcW * outH) / outW));
  const frames = Array.from({ length: args.frames }, (_, f) => makePatternFrame(srcW, srcH, f, args.frames));
  console.log(`测试源帧 ${srcW}×${srcH} × ${args.frames}（每帧 ${(srcW * srcH * 4 / 1024 / 1024).toFixed(1)}MB）\n`);

  const timings: number[] = [];
  for (let run = 1; run <= args.runs; run++) {
    const sink = new NullSink();
    const t0 = performance.now();
    composeToSink(frames, interlacer, outH, sink, { bandHeight: args.band });
    const dt = performance.now() - t0;
    timings.push(dt);
    console.log(`第 ${run} 次纯合成：${(dt / 1000).toFixed(3)}s（吞吐 ${(sink.bytes / 1024 / 1024 / dt * 1000).toFixed(0)} MB/s）`);
  }
  timings.sort((a, b) => a - b);
  const best = timings[0];
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  console.log(`\n最快 ${(best / 1000).toFixed(3)}s，平均 ${(avg / 1000).toFixed(3)}s，目标 8s → ${best <= 8000 ? "✅ 达标" : "❌ 未达标"}`);

  if (args.out) {
    const dir = join(process.cwd(), args.out);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `bench_${args.paper}_${args.dpi}dpi_${args.frames}f.png`);
    const { sink, done } = createStreamingPngSink(outW, outH, file);
    const t0 = performance.now();
    composeToSink(frames, interlacer, outH, sink, { bandHeight: args.band });
    await done();
    console.log(`\n流式 PNG 已写：${file}（合成+编码 ${((performance.now() - t0) / 1000).toFixed(2)}s）`);
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
