/**
 * Node 平台适配：sharp 解码/编码，支持超大图流式 PNG。
 */
import sharp from "sharp";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { RgbaImage } from "../core/types.js";
import type { BandSink } from "../core/engine.js";

/** 任意 sharp 可读输入（文件路径或 Buffer）解码为 RGBA8 */
export async function loadImage(input: string | Buffer): Promise<RgbaImage> {
  const img = sharp(input, { limitInputPixels: 1_000_000_000 }).ensureAlpha();
  const { data, info } = await img
    .rotate() // 遵循 EXIF 方向
    .raw()
    .toBuffer({ resolveWithObject: true });
  // sharp 总是返回由普通 ArrayBuffer 支撑的 Buffer；拷贝一份并显式收窄类型
  const buffer = new ArrayBuffer(info.width * info.height * 4);
  new Uint8Array(buffer).set(data.subarray(0, info.width * info.height * 4));
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(buffer)
  };
}

/** 内存位图编码 PNG（中小图） */
export async function encodePng(img: RgbaImage): Promise<Uint8Array> {
  const buf = Buffer.from(img.data.buffer.slice(0));
  return sharp(buf, { raw: { width: img.width, height: img.height, channels: 4 }, limitInputPixels: 1_000_000_000 })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/** 内存位图编码 TIFF（印刷交付，无损 LZW） */
export async function encodeTiff(img: RgbaImage): Promise<Uint8Array> {
  const buf = Buffer.from(img.data.buffer.slice(0));
  return sharp(buf, { raw: { width: img.width, height: img.height, channels: 4 }, limitInputPixels: 1_000_000_000 })
    .tiff({ compression: "lzw" })
    .toBuffer();
}

/**
 * 流式 PNG sink：分带收集后用 Readable.from + pipeline 交给 sharp，
 * 成品位图本身从不整幅驻留（仅各条带缓冲排队，约一个高水位的内存量）。
 *
 * 注意：不能用 PassThrough 手动 write/end——sharp 对该流的结束信号
 * 处理存在挂起问题（实测 done() 不返回）；Readable.from + pipeline 可靠。
 *
 * 用法：
 *   const { sink, done } = createStreamingPngSink(w, h, outPath);
 *   composeToSink(frames, interlacer, h, sink);
 *   await done();
 */
export function createStreamingPngSink(
  width: number,
  height: number,
  outPath: string
): {
  sink: BandSink;
  done: () => Promise<void>;
} {
  // 每条带拷贝成独立 Buffer（条带缓冲在引擎内会被复用，必须复制）
  const chunks: Buffer[] = [];
  const sink: BandSink = {
    writeBand(band: RgbaImage) {
      const copy = Buffer.allocUnsafe(band.data.byteLength);
      new Uint8Array(copy.buffer).set(
        new Uint8Array(band.data.buffer, band.data.byteOffset, band.data.byteLength)
      );
      chunks.push(copy);
    }
  };
  return {
    sink,
    async done() {
      await pipeline(
        Readable.from(chunks),
        // sharp 默认输入上限约 2.68 亿像素，A4@2400dpi ≈ 5.57 亿，需放开到 10 亿
        sharp({ raw: { width, height, channels: 4 }, limitInputPixels: 1_000_000_000 })
          .png({ compressionLevel: 6 }),
        createWriteStream(outPath)
      );
    }
  };
}
