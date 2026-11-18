/**
 * UI 集中状态：参数、帧、串帧报告与派生几何。
 * 框架无关的发布订阅，main.ts 负责订阅渲染。
 */
import { crosstalkReport, effectiveLpi, pitchMm, pitchPx, stripWidthPx } from "../core/optics.js";
import { planStrips, buildInterlacer } from "../core/dither.js";
import type { CrosstalkReport, DitherMode, LensParams, RgbaImage } from "../core/types.js";

export interface AppState {
  params: LensParams;
  dither: DitherMode;
  frames: RgbaImage[];
  frameLabels: string[];
  stereoPair: boolean;
  outputWidthMm: number;
  outputHeightMm: number;
  report: CrosstalkReport | null;
  /** 模拟节距失配百分比（串帧扫描用） */
  mismatchPct: number;
}

type Listener = (s: AppState) => void;

const DEFAULT_PARAMS: LensParams = {
  lpi: 100,
  thicknessMm: 0.58,
  refractiveIndex: 1.57,
  viewingDistanceMm: 350,
  frameCount: 2,
  printDpi: 2400,
  blurSigmaFraction: 0.18,
  eyeSeparationMm: 63
};

class Store {
  state: AppState = {
    params: { ...DEFAULT_PARAMS },
    dither: "hash",
    frames: [],
    frameLabels: [],
    stereoPair: false,
    outputWidthMm: 297,
    outputHeightMm: 210,
    report: null,
    mismatchPct: 0
  };
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 局部更新后重算派生数据并通知 */
  update(patch: Partial<AppState>): void {
    Object.assign(this.state, patch);
    this.recompute();
    for (const fn of this.listeners) fn(this.state);
  }

  updateParams(patch: Partial<LensParams>): void {
    this.state.params = { ...this.state.params, ...patch };
    this.recompute();
    for (const fn of this.listeners) fn(this.state);
  }

  private recompute(): void {
    const p = this.state.params;
    p.frameCount = this.state.frames.length || p.frameCount;
    p.stereo = this.state.stereoPair;
    this.state.report = crosstalkReport(p, {
      mismatchPct: this.state.mismatchPct,
      stepDeg: 0.5,
      averageLenses: 200
    });
  }

  get geometry() {
    const p = this.state.params;
    const lpi = effectiveLpi(p);
    const pitch = pitchPx(p);
    return {
      effectiveLpi: lpi,
      pitchMm: pitchMm(p),
      pitchPx: pitch,
      stripPx: stripWidthPx(p),
      outputWidthPx: Math.round((this.state.outputWidthMm * p.printDpi) / 25.4),
      outputHeightPx: Math.round((this.state.outputHeightMm * p.printDpi) / 25.4)
    };
  }

  buildInterlacer() {
    const g = this.geometry;
    const plan = planStrips(this.state.params, {
      outputWidthPx: g.outputWidthPx,
      dither: this.state.dither
    });
    return buildInterlacer(this.state.params, plan, g.effectiveLpi, g.pitchMm);
  }
}

export const store = new Store();
