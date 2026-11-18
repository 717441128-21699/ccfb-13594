/**
 * 串帧曲线（2D canvas）：各帧权重随角度变化，叠加最差鬼影/漏帧标记。
 */
import type { CrosstalkReport } from "../core/types.js";

const COLORS = ["#5b8ff9", "#5ad8a6", "#f6bd16", "#e86452", "#6dc8ec", "#945fb9"];

export function renderCrosstalkChart(canvas: HTMLCanvasElement, report: CrosstalkReport, currentAngle: number): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 220;
  if (canvas.width !== cssW * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext("2d")!;
  // 每次显式重置变换，避免 scale 在连续重绘时累乘
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW, H = cssH;
  ctx.clearRect(0, 0, W, H);

  const padL = 42, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const samples = report.samples;
  const aMin = samples[0].angleDeg;
  const aMax = samples[samples.length - 1].angleDeg;
  const x = (a: number) => padL + ((a - aMin) / (aMax - aMin)) * plotW;
  const y = (v: number) => padT + (1 - v) * plotH;

  // 网格 + 坐标
  ctx.strokeStyle = "#2a2f3a";
  ctx.fillStyle = "#8a93a6";
  ctx.font = "11px sans-serif";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = i / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y(v));
    ctx.lineTo(W - padR, y(v));
    ctx.stroke();
    ctx.fillText(v.toFixed(2), 6, y(v) + 4);
  }
  for (const a of [-40, -20, 0, 20, 40]) {
    if (a < aMin || a > aMax) continue;
    ctx.fillText(`${a}°`, x(a) - 8, H - 8);
  }

  // 最差角度竖线
  const mark = (a: number, color: string, label: string) => {
    ctx.strokeStyle = color;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x(a), padT);
    ctx.lineTo(x(a), padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.fillText(label, Math.min(W - padR - 70, x(a) + 4), padT + 10);
  };
  mark(report.worstGhost.angleDeg, "#e86452", `鬼影峰 ${report.worstGhost.angleDeg}°`);
  mark(report.worstLeakage.angleDeg, "#f6bd16", `漏帧峰 ${report.worstLeakage.angleDeg}°`);

  // 每帧权重曲线
  const n = samples[0].weights.length;
  for (let f = 0; f < n; f++) {
    ctx.strokeStyle = COLORS[f % COLORS.length];
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    samples.forEach((s, i) => {
      const px = x(s.angleDeg);
      const py = y(s.weights[f]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  // 当前角度光标
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x(currentAngle), padT);
  ctx.lineTo(x(currentAngle), padT + plotH);
  ctx.stroke();

  // 图例
  for (let f = 0; f < n; f++) {
    ctx.fillStyle = COLORS[f % COLORS.length];
    ctx.fillRect(padL + f * 78, H - 22, 10, 10);
    ctx.fillStyle = "#c8cedb";
    ctx.fillText(`帧 ${f + 1}`, padL + f * 78 + 14, H - 13);
  }
}
