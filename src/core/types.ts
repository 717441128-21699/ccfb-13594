/**
 * 光栅卡核心类型定义
 *
 * 约定：
 * - 所有长度单位在同一组参数内自洽（内部统一用毫米，印刷像素单独换算）
 * - 光栅条纹沿垂直方向延伸，分条发生在水平 X 轴
 * - 图像一律 RGBA8，每个像素 4 字节，行优先、紧密排列（无行对齐填充）
 */

/** 光栅板与观看条件参数 */
export interface LensParams {
  /** 光栅板标称线数 LPI（每英寸透镜柱数） */
  lpi: number;
  /** 透镜板材厚度，毫米 */
  thicknessMm: number;
  /** 材料折射率（PET 常见 1.57 左右） */
  refractiveIndex: number;
  /** 设计观看距离，毫米 */
  viewingDistanceMm: number;
  /** 交错帧数：2~6（左右眼立体图固定为 2 帧） */
  frameCount: number;
  /** 印刷输出分辨率，DPI */
  printDpi: number;
  /** 校准后实测线数 LPI；不给则按标称线数 + 观看距离补偿计算 */
  measuredLpi?: number;
  /** 是否左右眼立体模式（影响模拟时双眼位置的评估） */
  stereo?: boolean;
  /** 瞳距，毫米，仅立体模式使用，默认 63 */
  eyeSeparationMm?: number;
  /** 透镜光学模糊（半周期分数，0=理想透镜，越大串光越重），默认 0.18 */
  blurSigmaFraction?: number;
}

/** 一张 8 位 RGBA 位图 */
export interface RgbaImage {
  width: number;
  height: number;
  /** 长度必须等于 width * height * 4，由 ArrayBuffer 支撑（非 SharedArrayBuffer） */
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** 分条方式 */
export type DitherMode = "hash" | "error" | "floor";

/** 交错器：给定输出列号，返回取自哪一帧、该帧的哪一列 */
export interface Interlacer {
  /** 输出图宽度（印刷像素） */
  widthPx: number;
  /** 每个输出列对应的源帧索引 */
  frameOfColumn: Uint8Array;
  /** 每个输出列对应的源帧内列号 */
  sourceColumn: Uint32Array;
  /** 实际分条统计：宽度（印刷像素）出现次数 */
  stripWidthHistogram: Map<number, number>;
  /** 设计条纹宽（印刷像素，浮点） */
  idealStripWidthPx: number;
  /** 设计透镜节距（印刷像素，浮点） */
  pitchPx: number;
  /** 实际采用的物理节距，毫米 */
  pitchMm: number;
  /** 实际采用的线数 LPI */
  effectiveLpi: number;
  /** 帧宽（源帧统一缩放到此宽度），印刷像素 */
  frameWidthPx: number;
}

/** 串帧评估中单个角度的采样结果 */
export interface CrosstalkSample {
  /** 卡片法线与视线的夹角，度，负值=左转，正值=右转 */
  angleDeg: number;
  /** 各帧的可见权重，和为 1 */
  weights: number[];
  /** 主导帧索引 */
  dominantFrame: number;
  /** 漏帧：非主导帧权重之和，0~1 */
  leakage: number;
  /** 鬼影：与主导帧相隔 >=2 个位置的帧权重之和，0~1 */
  ghost: number;
}

/** 串帧分析结果 */
export interface CrosstalkReport {
  /** 单调采样序列 */
  samples: CrosstalkSample[];
  /** 鬼影最重的采样点 */
  worstGhost: CrosstalkSample;
  /** 漏帧最重的采样点 */
  worstLeakage: CrosstalkSample;
  /** 立体模式下双眼同时看到的串帧评估；非立体为 null */
  stereo: StereoAssessment | null;
}

/** 立体模式双眼评估 */
export interface StereoAssessment {
  /** 左眼对应角度（度） */
  leftEyeAngleDeg: number;
  /** 右眼对应角度（度） */
  rightEyeAngleDeg: number;
  /** 左眼看到的帧权重 */
  leftWeights: number[];
  /** 右眼看到的帧权重 */
  rightWeights: number[];
  /** 左眼本应看到帧 0 的纯净度（帧0权重） */
  leftPurity: number;
  /** 右眼本应看到帧 1 的纯净度（帧1权重） */
  rightPurity: number;
  /** 双眼平均鬼影 */
  averageGhost: number;
}

/** 校准图块定义 */
export interface CalibrationBlock {
  /** 块编号（从 1 开始） */
  index: number;
  /** 该块测试的线数 LPI */
  lpi: number;
  /** 相对标称线数的偏差百分比 */
  deviationPct: number;
}
