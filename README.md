# 光栅交错图工作室（Lenticular Studio）

面向文创光栅卡的交错图生成工具。解决两个生产痛点：

1. **叠图鬼影**——由光学分条与透镜参数不匹配、串帧控制不佳造成，工具按板材参数与观看距离计算条纹，并量化每个角度的串帧/鬼影。
2. **周期亮带**——浮点条纹宽直接取整会让误差同向累积，每隔一段距离多出一整列。工具用**随机化误差扩散**把误差抖散且无空间周期。

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 导入 2~6 帧 / 左右眼立体图 | Web 文件导入（`platform/browser.ts`），CLI 多帧入参；立体模式按瞳距评估双眼 |
| 按线数/厚度/折射率/观看距离算条纹 | `core/optics.ts`：折射定律 + 像移公式 + 印刷节距补偿 |
| 先打测线数校准图，用实测线数微调 | `core/calibration.ts` 生成多 LPI 摩尔纹块；`measuredLpi` 回填后覆盖理论值 |
| 屏幕模拟手持左右转动画面 | `web/preview.ts`，three.js 平面绕 Y 轴旋转，可拖拽/自动摆动 |
| 串帧最重角度提示 | `crosstalkReport` 定位 worstGhost / worstLeakage，UI 红/黄告警 + 曲线标记 |
| 条纹对齐印刷分辨率，除不尽误差抖散、无亮带 | `core/dither.ts` 随机化误差扩散，相位漂移锁在 ±1px、无周期自相关（有测试） |
| A4 @2400dpi ≤ 8 秒 | 融合式单遍缩放+交错引擎，实测纯合成约 5~6 秒（见下文基准） |
| TypeScript | 全量严格模式，`tsc --noEmit` 零错误 |
| 预览 three.js | `three@0.171` |

## 快速开始

```bash
npm install
npm run dev          # Web 工作室（默认 5173）
npm test             # 39 个单元/端到端测试
npm run bench        # A4@2400dpi 性能基准
```

### Web 工作流

1. 选择「2~6 帧变图」或「左右眼立体对」，导入素材（或点「生成演示帧」）。
2. 填入光栅板 LPI、厚度、折射率、观看距离、印刷 DPI。
3. 点「导出校准图」，100% 打印后把光栅板平贴其上轻转，找到摩尔纹静止的块块，把该块 LPI 填入「实测线数」。
4. 拖拽卡片或开「自动摆动」预览转动效果；右侧查看各帧权重曲线与串帧告警。
5. 「生成并下载交错图 PNG」。超大图（>约 900MB 成品）请改用 CLI。

### CLI

```bash
# 校准图（务必 1:1 打印，关闭缩放）
npx tsx src/cli/export.ts calibration --out calib.png --lpi 100 --dpi 2400

# 交错图（实测线数 99.6）
npx tsx src/cli/export.ts interlace \
  --frames f1.png f2.png f3.png f4.png f5.png f6.png \
  --out card.png --lpi 100 --dpi 2400 \
  --thickness 0.58 --index 1.57 --distance 350 \
  --measured-lpi 99.6 --width-mm 297 --height-mm 210
# 加 --tiff 输出无损 LZW TIFF（印刷交付）；大图自动走流式管道
```

## 核心原理

### 光学模型（旁轴近似）

- 折射：`sin φ = sin θ / n`
- 像面横移：`x = t·tan φ`，折算成透镜周期数决定当前看到哪一帧
- 印刷节距补偿：`P_print = P_lens·(1 + t/(n·D))`；有实测 LPI 时以实测为准
- 透镜模糊用周期内循环高斯权重表达，σ 可调，对应邻帧漏光

### 为什么不会有亮带

直接取整时，每条都欠/余固定小数，误差单调累积（`floor` 模式测试可见漂移超过一个完整节距）。
随机化误差扩散在每条的取整阈值上叠加**累积相位误差反馈**：

- 哈希决策 → 条宽序列无长程自相关周期（实测 lag≥2 相关 < 0.2，对照的确定性取整 > 0.99）
- 误差反馈 → 条纹相对透镜的相位漂移始终 < 1px，不会跨卡累积

### 性能

A4@2400dpi 成品约 28063×19843（2.1GB RGBA）。引擎：

- 每帧垂直预缩只做一次，避免按条带重复插值
- 缩放与交错**融合单遍**：每个输出条的源列恒定，一次双线性取值写满整条
- 条带缓冲复用、零逐带分配；超大图经 `Readable.from + pipeline` 流式编码，成品不全幅驻留

实测（本机，6 帧，纯合成不含编码）：最快约 4.8~5.8s，目标 8s。

## 目录结构

```
src/core/      纯 TS 核心（无 DOM 依赖，可单测）
  optics.ts        光学公式、串帧扫描、立体评估
  dither.ts        分条规划与随机化误差扩散
  scaler.ts        两级缩放
  engine.ts        融合式分块交错引擎 + BandSink
  calibration.ts   校准图渲染（自带点阵字库）
  simulation.ts    角度画面混合
  image.ts         双线性缩放
src/platform/  node.ts（sharp）/ browser.ts（canvas）适配
src/web/       three.js 预览、串帧曲线、UI
src/cli/       bench.ts 性能基准、export.ts 生产导出
test/          vitest 单元与端到端测试
```
