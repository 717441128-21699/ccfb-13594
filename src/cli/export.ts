/**
 * 生产导出 CLI
 *
 * 交错图：
 *   npx tsx src/cli/export.ts interlace \
 *     --frames f1.png f2.png ... --out card.png --lpi 100 --dpi 2400 \
 *     --thickness 0.58 --index 1.57 --distance 350 --measured-lpi 99.6 [--tiff]
 *
 * 校准图：
 *   npx tsx src/cli/export.ts calibration \
 *     --out calib.png --lpi 100 --dpi 2400 [--range 3] [--blocks 13]
 */
import { performance } from "node:perf_hooks";
import { planStrips, buildInterlacer } from "../core/dither.js";
import { effectiveLpi, pitchMm } from "../core/optics.js";
import { composeToSink } from "../core/engine.js";
import { renderCalibrationTarget } from "../core/calibration.js";
import { loadImage, encodePng, encodeTiff, createStreamingPngSink } from "../platform/node.js";
import type { DitherMode, LensParams } from "../core/types.js";

function argsMap(argv: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const vals: string[] = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) vals.push(argv[++i]);
      map.set(key, vals);
    }
  }
  return map;
}

const num = (m: Map<string, string[]>, k: string, d: number): number => {
  const v = m.get(k)?.[0];
  return v === undefined ? d : Number(v);
};

async function runInterlace(m: Map<string, string[]>): Promise<void> {
  const framePaths = m.get("frames");
  const out = m.get("out")?.[0];
  if (!framePaths?.length || !out) throw new Error("需要 --frames <若干图片> 与 --out <输出路径>");
  if (framePaths.length < 2 || framePaths.length > 6) throw new Error("帧数必须在 2~6 之间");
  if (m.has("stereo") && framePaths.length !== 2) throw new Error("左右眼立体模式必须恰好 2 帧（左、右）");

  const params: LensParams = {
    lpi: num(m, "lpi", 100),
    thicknessMm: num(m, "thickness", 0.58),
    refractiveIndex: num(m, "index", 1.57),
    viewingDistanceMm: num(m, "distance", 350),
    frameCount: framePaths.length,
    printDpi: num(m, "dpi", 2400),
    measuredLpi: m.has("measured-lpi") ? num(m, "measured-lpi", NaN) : undefined,
    stereo: m.has("stereo"),
    eyeSeparationMm: num(m, "eye-sep", 63)
  };
  const dither = (m.get("dither")?.[0] ?? "hash") as DitherMode;
  const widthMm = m.has("width-mm") ? num(m, "width-mm", NaN) : undefined;
  const heightMm = m.has("height-mm") ? num(m, "height-mm", NaN) : undefined;

  console.log(`载入 ${framePaths.length} 帧…`);
  const frames = await Promise.all(framePaths.map((p) => loadImage(p)));
  const aspect = frames[0].height / frames[0].width;
  for (const [i, f] of frames.entries()) {
    if (Math.abs(f.height / f.width - aspect) > 0.01) {
      console.warn(`⚠ 帧 ${i + 1} 宽高比与首帧差异较大，将被拉伸`);
    }
  }

  const outW = widthMm ? Math.round((widthMm * params.printDpi) / 25.4) : Math.round(frames[0].width * (params.printDpi / 300));
  const outH = heightMm ? Math.round((heightMm * params.printDpi) / 25.4) : Math.round(outW * aspect);

  const plan = planStrips(params, { outputWidthPx: outW, dither });
  const interlacer = buildInterlacer(params, plan, effectiveLpi(params), pitchMm(params));
  console.log(
    `输出 ${outW}×${outH}px，有效 LPI ${interlacer.effectiveLpi.toFixed(3)}，节距 ${interlacer.pitchPx.toFixed(3)}px，单条 ${interlacer.idealStripWidthPx.toFixed(3)}px`
  );
  console.log(`条宽分布: ${[...interlacer.stripWidthHistogram.entries()].sort((a, b) => a[0] - b[0]).map(([w, c]) => `${w}px×${c}`).join(", ")}`);

  const t0 = performance.now();
  if (m.has("tiff")) {
    // TIFF 走内存路径（sharp 无流式 TIFF 需求时单文件足够）
    const { composeToImage } = await import("../core/engine.js");
    const img = composeToImage(frames, interlacer, outH, {
      onProgress: (f) => process.stdout.write(`\r合成 ${(f * 100).toFixed(0)}%`)
    });
    const bytes = await encodeTiff(img);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, bytes);
  } else if (outW * outH > 200_000_000) {
    // 大图强制流式，避免 2GB+ 内存峰值
    const { sink, done } = createStreamingPngSink(outW, outH, out);
    composeToSink(frames, interlacer, outH, sink, {
      onProgress: (f) => process.stdout.write(`\r合成 ${(f * 100).toFixed(0)}%`)
    });
    await done();
  } else {
    const { composeToImage } = await import("../core/engine.js");
    const img = composeToImage(frames, interlacer, outH, {
      onProgress: (f) => process.stdout.write(`\r合成 ${(f * 100).toFixed(0)}%`)
    });
    const bytes = await encodePng(img);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, bytes);
  }
  console.log(`\n完成：${out}，耗时 ${((performance.now() - t0) / 1000).toFixed(2)}s`);
}

async function runCalibration(m: Map<string, string[]>): Promise<void> {
  const out = m.get("out")?.[0];
  if (!out) throw new Error("需要 --out <输出路径>");
  const lpi = num(m, "lpi", 100);
  const dpi = num(m, "dpi", 2400);
  const { image } = renderCalibrationTarget(lpi, dpi, {
    rangePct: num(m, "range", 3),
    blockCount: num(m, "blocks", 13)
  });
  const bytes = await encodePng(image);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(out, bytes);
  console.log(`校准图已写：${out}（${image.width}×${image.height}px，按 100% 比例打印，勿缩放）`);
}

const m = argsMap(process.argv.slice(2));
const cmd = process.argv[2];
if (cmd === "interlace") {
  runInterlace(m).catch((e) => { console.error(e); process.exit(1); });
} else if (cmd === "calibration") {
  runCalibration(m).catch((e) => { console.error(e); process.exit(1); });
} else {
  console.error("子命令：interlace | calibration");
  process.exit(1);
}
