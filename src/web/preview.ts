/**
 * three.js 手持转动预览
 *
 * - 卡片平面绕 Y 轴旋转，旋转角即观看角（度）
 * - 贴图随角度在预渲染的各帧权重混合画面间切换
 * - 可拖拽、自动摆动；最差鬼影/漏帧角度用彩色标记与标线提示
 */
import * as THREE from "three";
import type { LensParams, RgbaImage } from "../core/types.js";
import { renderViewSequence } from "../core/simulation.js";
import type { CrosstalkReport } from "../core/types.js";

const ANGLE_HALF = 50;
const ANGLE_STEP = 1;
const PREVIEW_W = 640;

export interface PreviewHandle {
  setFrames(frames: RgbaImage[], params: LensParams): void;
  setReport(report: CrosstalkReport): void;
  setAngle(deg: number): void;
  getAngle(): number;
  setAutoSwing(on: boolean): void;
  dispose(): void;
  onAngleChange(cb: (deg: number) => void): void;
}

export function createPreview(container: HTMLElement): PreviewHandle {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161c);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 7);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";

  // 灯光（标准材质需要）
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 1.5);
  dir.position.set(2, 3, 5);
  scene.add(dir);

  // 卡片：2.8 宽 × 比例高
  const CARD_W = 3.2;
  const cardGroup = new THREE.Group();
  scene.add(cardGroup);

  const geometry = new THREE.PlaneGeometry(CARD_W, CARD_W * 0.707);
  const placeholder = makePlaceholderTexture();
  const material = new THREE.MeshStandardMaterial({ map: placeholder, roughness: 0.55, metalness: 0.05 });
  const card = new THREE.Mesh(geometry, material);
  cardGroup.add(card);

  // 卡片边框（模拟光栅板厚度）
  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0x6aa0ff })
  );
  card.add(frame);

  // ---- 角度标记（场景内小指示条，位于卡片下方） ----
  const markerGroup = new THREE.Group();
  markerGroup.position.y = -CARDW() * 0.42;
  cardGroup.add(markerGroup);
  function CARDW() { return CARD_W * 0.707; }

  const ghostMarker = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.18, 0.02),
    new THREE.MeshBasicMaterial({ color: 0xff5d5d })
  );
  const leakMarker = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.18, 0.02),
    new THREE.MeshBasicMaterial({ color: 0xffb02e })
  );
  markerGroup.add(ghostMarker, leakMarker);
  ghostMarker.visible = false;
  leakMarker.visible = false;

  // ---- 状态 ----
  let textures: THREE.Texture[] = [];
  let angles: number[] = [];
  let report: CrosstalkReport | null = null;
  let angle = 0;
  let autoSwing = false;
  let dragging = false;
  let lastX = 0;
  const angleCallbacks = new Set<(deg: number) => void>();

  function makePlaceholderTexture(): THREE.Texture {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 362;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#222632";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#8a93a6";
    ctx.font = "24px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("导入 2~6 帧后在此预览", c.width / 2, c.height / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function textureFromImage(img: RgbaImage): THREE.Texture {
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  function clearTextures(): void {
    for (const t of textures) t.dispose();
    textures = [];
  }

  function applyAngle(deg: number): void {
    angle = Math.max(-ANGLE_HALF, Math.min(ANGLE_HALF, deg));
    cardGroup.rotation.y = (angle * Math.PI) / 180;
    if (textures.length) {
      const idx = Math.round((angle + ANGLE_HALF) / ANGLE_STEP);
      const tex = textures[Math.min(textures.length - 1, Math.max(0, idx))];
      if (tex) material.map = tex;
      material.needsUpdate = true;
    }
    for (const cb of angleCallbacks) cb(angle);
  }

  // ---- 交互：拖拽转动 ----
  const dom = renderer.domElement;
  dom.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    dom.setPointerCapture(e.pointerId);
  });
  dom.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    applyAngle(angle + (e.clientX - lastX) * 0.4);
    lastX = e.clientX;
  });
  dom.addEventListener("pointerup", () => (dragging = false));
  dom.addEventListener("pointercancel", () => (dragging = false));
  dom.addEventListener("wheel", (e) => {
    e.preventDefault();
    applyAngle(angle + Math.sign(e.deltaY) * 2);
  }, { passive: false });

  // ---- 尺寸自适应 ----
  function resize(): void {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 480;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // ---- 渲染循环 ----
  let raf = 0;
  let last = performance.now();
  function tick(now: number): void {
    const dt = (now - last) / 1000;
    last = now;
    if (autoSwing && !dragging) {
      // 0.5Hz 正弦摆动，幅度 ±40°
      const t = now / 1000;
      applyAngle(Math.sin(t * Math.PI) * 40);
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  return {
    setFrames(frames, params) {
      clearTextures();
      angles = [];
      for (let a = -ANGLE_HALF; a <= ANGLE_HALF + 1e-6; a += ANGLE_STEP) angles.push(Number(a.toFixed(2)));
      const seq = renderViewSequence(frames, params, angles, PREVIEW_W);
      textures = seq.map(textureFromImage);
      applyAngle(angle);
    },
    setReport(r) {
      report = r;
      const place = (marker: THREE.Mesh, deg: number, visible: boolean) => {
        marker.visible = visible;
        // 标记水平位置映射到 ±45° 的可视范围
        marker.position.x = (deg / ANGLE_HALF) * CARD_W * 0.9;
      };
      place(ghostMarker, r.worstGhost.angleDeg, r.worstGhost.ghost > 0.02);
      place(leakMarker, r.worstLeakage.angleDeg, r.worstLeakage.leakage > 0.05);
    },
    setAngle(deg) { applyAngle(deg); },
    getAngle() { return angle; },
    setAutoSwing(on) { autoSwing = on; },
    onAngleChange(cb) { angleCallbacks.add(cb); return () => angleCallbacks.delete(cb); },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      clearTextures();
      placeholder.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      dom.remove();
    }
  };
}
