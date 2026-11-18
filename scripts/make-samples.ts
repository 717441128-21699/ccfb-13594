/** 生成端到端测试用的 6 张素材帧到 samples/（独立目录，与代码隔离） */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRgba } from "../src/core/image.js";
import { encodePng } from "../src/platform/node.js";

const dir = join(process.cwd(), "samples");
mkdirSync(dir, { recursive: true });

const palette: [number, number, number][] = [
  [220, 70, 70], [70, 170, 90], [70, 110, 220],
  [220, 170, 60], [170, 90, 200], [70, 190, 200]
];

for (let f = 0; f < 6; f++) {
  const w = 800, h = Math.round(w / Math.SQRT2);
  const img = createRgba(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const wave = Math.sin(x / 22 + f * 1.7) + Math.sin(y / 17 + f);
      const k = wave > 0 ? 1 : 0.55;
      img.data[idx] = palette[f][0] * k;
      img.data[idx + 1] = palette[f][1] * k;
      img.data[idx + 2] = palette[f][2] * k;
      img.data[idx + 3] = 255;
    }
  }
  const bytes = await encodePng(img);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, `frame${f + 1}.png`), bytes);
  console.log(`samples/frame${f + 1}.png ${w}×${h}`);
}
