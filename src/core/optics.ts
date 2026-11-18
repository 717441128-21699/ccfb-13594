/**
 * 光栅光学模型
 *
 * 坐标系：透镜柱沿 Y 轴，分条发生在 X 轴；卡片法线为 Z 轴。
 * 观看角度 θ 为视线与法线夹角，右转为正。
 *
 * 关键公式（旁轴近似，行业通用）：
 *   印刷节距补偿  P_print = P_lens × (1 + t / (n·D))
 *   折射          sin φ = sin θ / n
 *   像面横向位移  x = t·tan φ
 *
 * 校准后用实测线数覆盖理论补偿，所以补偿公式只在没有实测数据时兜底。
 */
import type {
  CrosstalkReport,
  CrosstalkSample,
  LensParams,
  StereoAssessment
} from "./types.js";

export const MM_PER_INCH = 25.4;

/** 实际采用的线数 LPI：优先实测值，否则按观看距离做节距补偿反推 */
export function effectiveLpi(p: LensParams): number {
  if (p.measuredLpi !== undefined && Number.isFinite(p.measuredLpi) && p.measuredLpi > 0) {
    return p.measuredLpi;
  }
  const compensation = 1 + p.thicknessMm / (p.refractiveIndex * p.viewingDistanceMm);
  // 印刷节距被放大 compensation 倍 → 等效线数缩小
  return p.lpi / compensation;
}

/** 实际采用的透镜节距，毫米 */
export function pitchMm(p: LensParams): number {
  return MM_PER_INCH / effectiveLpi(p);
}

/** 透镜节距换算成印刷像素 */
export function pitchPx(p: LensParams): number {
  return (pitchMm(p) * p.printDpi) / MM_PER_INCH;
}

/** 单帧条纹宽度（印刷像素，浮点） */
export function stripWidthPx(p: LensParams): number {
  return pitchPx(p) / p.frameCount;
}

/**
 * 折射角 φ（弧度）：光线从空气进入透镜材料
 * sin φ = sin θ / n
 */
export function refractionAngle(thetaRad: number, n: number): number {
  const sinPhi = Math.sin(thetaRad) / n;
  return Math.asin(Math.min(1, Math.max(-1, sinPhi)));
}

/**
 * 像面横向位移折算成“跨过了多少个透镜周期”
 * 正值表示向帧序号增大的方向移动。
 */
export function shiftInPeriods(thetaRad: number, p: LensParams): number {
  const phi = refractionAngle(thetaRad, p.refractiveIndex);
  const xMm = p.thicknessMm * Math.tan(phi);
  return xMm / pitchMm(p);
}

/**
 * 给定观看角度与该透镜位置上的周期相位，返回各帧可见权重。
 *
 * 模型：理想情况下角度唯一决定一个帧位置 f（单位：条，0~N 循环）；
 * 透镜模糊让相邻帧漏光，用周期内循环高斯权重表达，σ 以条宽为单位。
 *
 * 帧序约定：θ>0（视线移向右侧/右眼位置）应看到序号更大的帧，
 * 立体模式下即右眼看到帧 1、左眼（θ<0）看到帧 0。物理位移 x 与该
 * 约定方向相反，故这里对位移取负。
 *
 * @param phasePeriods 印刷图案相对透镜的周期相位偏移（节距失配扫描用）
 */
export function frameWeights(
  thetaRad: number,
  p: LensParams,
  phasePeriods = 0
): number[] {
  const n = p.frameCount;
  const sigma = p.blurSigmaFraction ?? 0.18;
  const u = -(shiftInPeriods(thetaRad, p) + phasePeriods);
  // 帧位置落在 [0, n)，帧 k 的中心在 k + 0.5
  const f = ((u % 1) + 1) % 1 * n;
  const weights = new Array<number>(n).fill(0);
  const twoSigma2 = 2 * sigma * sigma;
  for (let k = 0; k < n; k++) {
    let d = Math.abs(f - (k + 0.5));
    // 周期循环距离（条宽为单位，周期长度 n）
    d = Math.min(d, n - d);
    weights[k] = Math.exp(-(d * d) / twoSigma2);
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  for (let k = 0; k < n; k++) weights[k] = weights[k] / sum;
  return weights;
}

function circularFrameDistance(a: number, b: number, n: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, n - d);
}

function evaluateAngle(
  angleDeg: number,
  p: LensParams,
  mismatchPeriodsPerLens: number,
  averageLenses: number
): CrosstalkSample {
  const theta = (angleDeg * Math.PI) / 180;
  const n = p.frameCount;
  let weights: number[];

  if (mismatchPeriodsPerLens === 0 || averageLenses <= 1) {
    weights = frameWeights(theta, p, 0);
  } else {
    // 节距失配：第 j 个透镜处累积相位漂移 j·δ，整卡平均后就是眼睛看到的混合画面
    const acc = new Array<number>(n).fill(0);
    for (let j = 0; j < averageLenses; j++) {
      const w = frameWeights(theta, p, j * mismatchPeriodsPerLens);
      for (let k = 0; k < n; k++) acc[k] += w[k];
    }
    weights = acc.map((v) => v / averageLenses);
  }

  let dominantFrame = 0;
  for (let k = 1; k < n; k++) {
    if (weights[k] > weights[dominantFrame]) dominantFrame = k;
  }
  const leakage = 1 - weights[dominantFrame];
  let ghost = 0;
  for (let k = 0; k < n; k++) {
    if (circularFrameDistance(k, dominantFrame, n) >= 2) ghost += weights[k];
  }
  return { angleDeg, weights, dominantFrame, leakage, ghost };
}

export interface CrosstalkOptions {
  /** 角度扫描半幅，度，默认 50 */
  halfRangeDeg?: number;
  /** 角度采样步长，度，默认 0.5 */
  stepDeg?: number;
  /** 模拟印刷节距相对透镜节距的偏差百分比（正数=印宽了），默认 0 */
  mismatchPct?: number;
  /** 失配评估时跨多少个透镜做相位平均，默认 200 */
  averageLenses?: number;
}

/** 全角度串帧扫描，并定位鬼影/漏帧最严重的角度 */
export function crosstalkReport(p: LensParams, opts: CrosstalkOptions = {}): CrosstalkReport {
  const half = opts.halfRangeDeg ?? 50;
  const step = opts.stepDeg ?? 0.5;
  const mismatchPct = opts.mismatchPct ?? 0;
  const averageLenses = opts.averageLenses ?? 200;
  // 每经过一个透镜，印刷与透镜的相位差累积 δ（周期数）
  const mismatchPeriodsPerLens = mismatchPct / 100;

  const samples: CrosstalkSample[] = [];
  const count = Math.round((half * 2) / step) + 1;
  for (let i = 0; i < count; i++) {
    const angleDeg = -half + i * step;
    samples.push(evaluateAngle(angleDeg, p, mismatchPeriodsPerLens, averageLenses));
  }

  let worstGhost = samples[0];
  let worstLeakage = samples[0];
  for (const s of samples) {
    if (s.ghost > worstGhost.ghost) worstGhost = s;
    if (s.leakage > worstLeakage.leakage) worstLeakage = s;
  }

  return {
    samples,
    worstGhost,
    worstLeakage,
    stereo: p.stereo ? assessStereo(p, mismatchPeriodsPerLens, averageLenses) : null
  };
}

/** 立体模式：双眼在设计距离上各占一个角度，评估左右眼画面纯净度 */
export function assessStereo(
  p: LensParams,
  mismatchPeriodsPerLens = 0,
  averageLenses = 200
): StereoAssessment {
  const eyeSep = p.eyeSeparationMm ?? 63;
  const halfAngleRad = Math.atan(eyeSep / 2 / p.viewingDistanceMm);
  const halfAngleDeg = (halfAngleRad * 180) / Math.PI;

  const left = evaluateAngle(-halfAngleDeg, p, mismatchPeriodsPerLens, averageLenses);
  const right = evaluateAngle(halfAngleDeg, p, mismatchPeriodsPerLens, averageLenses);

  // 约定帧 0 = 左眼图，帧 1 = 右眼图
  const leftPurity = left.weights[0] ?? 0;
  const rightPurity = right.weights[1] ?? 0;
  return {
    leftEyeAngleDeg: -halfAngleDeg,
    rightEyeAngleDeg: halfAngleDeg,
    leftWeights: left.weights,
    rightWeights: right.weights,
    leftPurity,
    rightPurity,
    averageGhost: (left.ghost + right.ghost) / 2
  };
}
