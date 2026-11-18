/**
 * UI 装配：参数绑定、素材导入、校准导出、预览、串帧提示与成品导出。
 */
import { store } from "./state.js";
import { createPreview } from "./preview.js";
import { renderCrosstalkChart } from "./chart.js";
import { loadImageFile, encodePngBlob, downloadBlob } from "../platform/browser.js";
import { renderCalibrationTarget } from "../core/calibration.js";
import { composeToImage } from "../core/engine.js";
import { createRgba, resizeBilinear } from "../core/image.js";
import type { LensParams, RgbaImage } from "../core/types.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const preview = createPreview($("preview"));
const chart = $<HTMLCanvasElement>("chart");

// ---------------- 参数双向绑定 ----------------
const num = (id: string) => Number($<HTMLInputElement>(id).value);

function readParams(): Partial<LensParams> {
  return {
    lpi: num("lpi"),
    thicknessMm: num("thickness"),
    refractiveIndex: num("index"),
    viewingDistanceMm: num("distance"),
    printDpi: num("dpi"),
    blurSigmaFraction: num("blur"),
    measuredLpi: $<HTMLInputElement>("measured").value === "" ? undefined : num("measured")
  };
}

for (const id of ["lpi", "thickness", "index", "distance", "dpi", "blur", "measured"]) {
  $(id).addEventListener("input", () => store.updateParams(readParams()));
}
$("mismatch").addEventListener("input", () => store.update({ mismatchPct: num("mismatch") }));
$("dither").addEventListener("change", () => store.update({ dither: $<HTMLSelectElement>("dither").value as never }));
$("outW").addEventListener("input", () => store.update({ outputWidthMm: num("outW") }));
$("outH").addEventListener("input", () => store.update({ outputHeightMm: num("outH") }));

// 模式切换：立体对固定 2 帧，超出的素材自动截断
document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) =>
  r.addEventListener("change", () => {
    const stereo = r.value === "stereo" && r.checked;
    store.update({ stereoPair: stereo });
    if (stereo && store.state.frames.length > 2) {
      applyFrames(store.state.frames.slice(0, 2), store.state.frameLabels.slice(0, 2));
    }
  })
);

// ---------------- 帧导入 ----------------
const MAX_FRAMES = 6;

async function ingestFiles(files: File[]): Promise<void> {
  const cap = store.state.stereoPair ? 2 : MAX_FRAMES;
  const keep = files.slice(0, cap - store.state.frames.length);
  const loaded: RgbaImage[] = [];
  for (const f of keep) loaded.push(await loadImageFile(f));
  if (!loaded.length) return;

  // 统一到首帧尺寸（小图，交互级成本）
  const base = store.state.frames[0] ?? loaded[0];
  const normalized = loaded.map((img) =>
    img.width === base.width && img.height === base.height ? img : resizeBilinear(img, base.width, base.height)
  );
  const frames = [...store.state.frames, ...normalized].slice(0, cap);
  const labels = [...store.state.frameLabels, ...keep.map((f) => f.name)].slice(0, cap);
  applyFrames(frames, labels);
}

function applyFrames(frames: RgbaImage[], labels: string[]): void {
  store.update({
    frames,
    frameLabels: labels,
    stereoPair: document.querySelector<HTMLInputElement>('input[name="mode"][value="stereo"]')!.checked
  });
  store.updateParams({ frameCount: frames.length });
  renderFrameChips(labels);
  if (frames.length >= 2) {
    preview.setFrames(frames, store.state.params);
  }
}

function renderFrameChips(labels: string[]): void {
  const el = $("frameList");
  el.innerHTML = "";
  labels.forEach((label, i) => {
    const chip = document.createElement("span");
    chip.className = "frame-chip";
    chip.textContent = `帧${i + 1} · ${label.length > 14 ? label.slice(0, 13) + "…" : label}`;
    el.appendChild(chip);
  });
}

$<HTMLInputElement>("fileInput").addEventListener("change", async (e) => {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  await ingestFiles(files);
});
$("clearFramesBtn").addEventListener("click", () => {
  applyFrames([], []);
  $<HTMLInputElement>("fileInput").value = "";
});

// 演示帧：每帧不同底色 + 大号帧号文字，转动时切换清晰可辨
$("demoBtn").addEventListener("click", () => {
  const palette: [number, number, number][] = [
    [220, 70, 70], [70, 170, 90], [70, 110, 220],
    [220, 170, 60], [170, 90, 200], [70, 190, 200]
  ];
  const w = 900, h = Math.round(w / Math.SQRT2);
  const frames = palette.map((rgb, i): RgbaImage => {
    const img = createRgba(w, h);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.font = `bold ${Math.round(h * 0.55)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${i + 1}`, w / 2, h / 2);
    ctx.font = `${Math.round(h * 0.07)}px sans-serif`;
    ctx.fillText("LENTICULAR DEMO", w / 2, h * 0.86);
    const data = ctx.getImageData(0, 0, w, h).data;
    img.data.set(data);
    return img;
  });
  const cap = store.state.stereoPair ? 2 : MAX_FRAMES;
  applyFrames(frames.slice(0, cap), frames.slice(0, cap).map((_, i) => `demo-${i + 1}.png`));
});

// ---------------- 校准图 ----------------
$("calibBtn").addEventListener("click", async () => {
  const dpi = num("dpi");
  const target = renderCalibrationTarget(num("lpi"), dpi, { rangePct: 3, blockCount: 13 });
  const blob = await encodePngBlob(target.image);
  downloadBlob(blob, `lpi-calibration-${num("lpi")}-${dpi}dpi.png`);
});
$("applyCalibBtn").addEventListener("click", () => {
  $<HTMLInputElement>("measured").value = String(num("lpi"));
  store.updateParams(readParams());
});

// ---------------- 预览角度 ----------------
const slider = $<HTMLInputElement>("angleSlider");
slider.addEventListener("input", () => preview.setAngle(Number(slider.value)));
preview.onAngleChange((deg) => {
  $("angleReadout").textContent = `角度 ${deg.toFixed(1)}°`;
  if (document.activeElement !== slider) slider.value = String(deg);
  drawChart();
});
$<HTMLInputElement>("autoSwing").addEventListener("change", (e) =>
  preview.setAutoSwing((e.target as HTMLInputElement).checked)
);

// ---------------- 串帧提示与指标 ----------------
function severity(leakage: number): "ok" | "warn" | "bad" {
  if (leakage < 0.12) return "ok";
  if (leakage < 0.3) return "warn";
  return "bad";
}

function renderAlerts(): void {
  const report = store.state.report;
  const el = $("alerts");
  el.innerHTML = "";
  if (!report) return;

  const g = report.worstGhost;
  const l = report.worstLeakage;
  const ghostLevel = severity(g.ghost);
  const leakLevel = severity(l.leakage);

  const ghost = document.createElement("div");
  ghost.className = `alert ${ghostLevel === "ok" ? "ok" : "ghost-level"}`;
  ghost.innerHTML = ghostLevel === "ok"
    ? `<span>鬼影控制良好</span><b>峰值 ${(g.ghost * 100).toFixed(1)}% @ ${g.angleDeg}°</b>`
    : `<span>⚠ 鬼影最重角度：帧 ${g.dominantFrame + 1} 主导时混入远帧，转动到这里叠图最明显</span><b>${(g.ghost * 100).toFixed(1)}% @ ${g.angleDeg}°</b>`;
  el.appendChild(ghost);

  const leak = document.createElement("div");
  leak.className = `alert ${leakLevel === "ok" ? "ok" : "leak-level"}`;
  leak.innerHTML = leakLevel === "ok"
    ? `<span>邻帧漏光可接受</span><b>峰值 ${(l.leakage * 100).toFixed(1)}% @ ${l.angleDeg}°</b>`
    : `<span>⚠ 漏帧最重角度：画面对比度下降、发灰</span><b>${(l.leakage * 100).toFixed(1)}% @ ${l.angleDeg}°</b>`;
  el.appendChild(leak);

  if (report.stereo) {
    const stereo = report.stereo;
    const box = document.createElement("div");
    const cls = Math.min(stereo.leftPurity, stereo.rightPurity) > 0.8 ? "ok" : "leak-level";
    box.className = `alert ${cls}`;
    box.innerHTML = `<span>立体双眼纯净度（左/右）</span><b>${(stereo.leftPurity * 100).toFixed(1)}% / ${(stereo.rightPurity * 100).toFixed(1)}%</b>`;
    el.appendChild(box);
  }
}

function renderMetrics(): void {
  const g = store.geometry;
  const inter = store.state.frames.length >= 2 ? store.buildInterlacer() : null;
  const dist = inter ? [...inter.stripWidthHistogram.entries()].sort((a, b) => a[0] - b[0]).map(([w, c]) => `${w}px×${c}`).join("，") : "—";
  const items: [string, string][] = [
    ["有效线数", `${g.effectiveLpi.toFixed(3)} LPI`],
    ["透镜节距", `${g.pitchPx.toFixed(3)} px（${g.pitchMm.toFixed(4)} mm）`],
    ["单帧条纹", `${g.stripPx.toFixed(3)} px`],
    ["输出像素", `${g.outputWidthPx} × ${g.outputHeightPx}`],
    ["条宽分布", dist],
    ["成品 RGBA", `${(g.outputWidthPx * g.outputHeightPx * 4 / 1024 / 1024).toFixed(0)} MB`]
  ];
  $("metrics").innerHTML = items.map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
}

function drawChart(): void {
  if (store.state.report) renderCrosstalkChart(chart, store.state.report, preview.getAngle());
}

// 任意状态变化刷新侧栏；帧变化才需要重建预览贴图
store.subscribe(() => {
  renderAlerts();
  renderMetrics();
  drawChart();
  if (store.state.report) preview.setReport(store.state.report);
});
store.update({}); // 初始化派生数据

// ---------------- 成品导出（浏览器，限制在内存可承受尺寸） ----------------
$("exportBtn").addEventListener("click", async () => {
  const status = $("exportStatus");
  if (store.state.frames.length < 2) {
    status.textContent = "请先导入至少 2 帧";
    return;
  }
  const g = store.geometry;
  const megaBytes = (g.outputWidthPx * g.outputHeightPx * 4) / 1024 / 1024;
  if (megaBytes > 900) {
    status.textContent = `成品约 ${megaBytes.toFixed(0)}MB，超出浏览器内存安全范围，请用 CLI 导出（npm run export）`;
    return;
  }
  status.textContent = "合成中…";
  const t0 = performance.now();
  try {
    // 让浏览器有机会绘制状态文案
    await new Promise((r) => setTimeout(r, 30));
    const interlacer = store.buildInterlacer();
    const img = composeToImage(store.state.frames, interlacer, g.outputHeightPx, {
      onProgress: (f) => (status.textContent = `合成中 ${(f * 100).toFixed(0)}%`)
    });
    const blob = await encodePngBlob(img);
    downloadBlob(blob, `interlaced-${store.state.params.frameCount}f-${num("dpi")}dpi.png`);
    status.textContent = `完成，用时 ${((performance.now() - t0) / 1000).toFixed(2)}s（${(blob.size / 1024 / 1024).toFixed(1)}MB PNG）`;
  } catch (err) {
    status.textContent = `失败：${(err as Error).message}（大图请用 CLI）`;
  }
});
