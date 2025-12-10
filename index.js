/* =========================================================================
 * 1) Three.js로 3D 장면/FBX 렌더링
 * 2) Chart.js로 RPM/Feed/Torque 실시간 라인 차트
 * 3) MOCK 타이머 또는 WebSocket 실데이터 반영
 * -------------------------------------------------------------------------
*/

// === Three.js (ESM) =======================================================
import * as THREE from "https://esm.sh/three@0.160.0";
import { OrbitControls } from "https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js";
import { FBXLoader } from "https://esm.sh/three@0.160.0/examples/jsm/loaders/FBXLoader.js";

// === DOM 참조 =============================================================
const threeMount = document.getElementById("threeMount");
const clock = new THREE.Clock();

const rpmVal = document.getElementById("rpmVal");
const feedVal = document.getElementById("feedVal");
const torqVal = document.getElementById("torqVal");
const predVal = document.getElementById("predVal");
const hudLine = document.getElementById("hudLine");
const hudTool = document.getElementById("hudTool");
const hudState = document.getElementById("hudState");
const connState = document.getElementById("connState");
const lineSel = document.getElementById("lineSel");
const toolSel = document.getElementById("toolSel");
const btnMock = document.getElementById("btnMock");
const btnWs = document.getElementById("btnWs");
const wsUrlInput = document.getElementById("wsUrl"); // null일 수 있음

// === THREE 기본 장면 =======================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xF3F3F3);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
camera.position.set(4.3, 3.5, 5.8);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
threeMount.appendChild(renderer.domElement);

function resize() {
  const rect = threeMount.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener("resize", resize);
new ResizeObserver(resize).observe(threeMount);

const hemi = new THREE.HemisphereLight(0xaad1ff, 0x0b0f14, 0.9);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(3, 5, 2);
dir.castShadow = true;
scene.add(dir);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0xF3F3F3, metalness: 0.2, roughness: 0.8 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.5;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(40, 40, 0x1f2a36, 0x101720);
grid.position.y = -0.49;
scene.add(grid);

const axes = new THREE.AxesHelper(1.5);
axes.position.y = -0.49;
scene.add(axes);

const base = new THREE.Mesh(
  new THREE.BoxGeometry(3.8, 0.4, 2.4),
  new THREE.MeshStandardMaterial({ color: 0xF3F3F3, metalness: 0.1, roughness: 0.9 })
);
base.position.set(0, -0.3, 0);
base.castShadow = base.receiveShadow = true;
scene.add(base);

// === FBX 로드 및 이동 범위 ================================================
// 이동 기준점(앵커). 이동 범위는 basePos 기준 각 축 [0,1] AABB
const basePos = new THREE.Vector3(0, 2, -2.2);
const BOUNDS_MIN = basePos.clone();
const BOUNDS_MAX = basePos.clone().addScalar(1);

function clampToBounds(v) {
  v.x = Math.min(BOUNDS_MAX.x, Math.max(BOUNDS_MIN.x, v.x));
  v.y = Math.min(BOUNDS_MAX.y, Math.max(BOUNDS_MIN.y, v.y));
  v.z = Math.min(BOUNDS_MAX.z, Math.max(BOUNDS_MIN.z, v.z));
  return v;
}

let toolRoot = null;     // 주 모델(툴)
let productRoot = null;  // 추가 모델(제품)

const loader = new FBXLoader();

// 주 모델 로드
loader.load(
  "./assets/CNC_tool.fbx",
  (fbx) => {
    toolRoot = fbx;
    toolRoot.scale.set(0.01, 0.01, 0.01);
    // 경계 중앙에서 시작
    const startPos = new THREE.Vector3(
      (BOUNDS_MIN.x + BOUNDS_MAX.x) * 0.5,
      (BOUNDS_MIN.y + BOUNDS_MAX.y) * 0.5,
      (BOUNDS_MIN.z + BOUNDS_MAX.z) * 0.5
    );
    toolRoot.position.copy(startPos);
    toolRoot.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;

        // 👇 여기 추가: 임시 색상 지정
        o.material = new THREE.MeshStandardMaterial({
          color: 0x999999,   // 🔴 빨간색 (원하는 HEX 코드로 변경)
          metalness: 0.7,
          roughness: 0.4
        });
      }
    });
    scene.add(toolRoot);
  },
  undefined,
  (err) => console.error("FBX load error (CNC_tool):", err)
);

// 추가 모델 로드 — 이동 없음, Y+ 회전/정지만
loader.load(
  "./assets/CNC_product.fbx",
  (fbx) => {
    productRoot = fbx;
    productRoot.scale.set(0.01, 0.01, 0.01);
    // 툴과 약간 떨어뜨려 배치(겹침 방지)
    productRoot.position.set(0, 0, 0);
    productRoot.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    scene.add(productRoot);
  },
  undefined,
  (err) => console.error("FBX load error (CNC_product):", err)
);

// === 컨트롤 ================================================================
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.15, 0);

// === 상태 값(차트/표시) ====================================================
// ⚠️ 이제 rpm/feed/torq 는 “제품” 기준
let rpm = 0, feed = 0, torq = 0;
let state = "Ready";

// 도우미: 제품 회전 각속도(rad/s)를 rpm에서 계산 (스케일/클램프)
function rpmToRadPerSec(rpmVal) {
  // 대략 rpm 0~3000 -> 0~약 2.5 rad/s
  return Math.max(0, Math.min(2.5, rpmVal / 1200));
}

// 툴 고정 회전 속도(Z축, rad/s)
const TOOL_ROT_SPEED = 0.8;

// 시간/속도 프리셋
const TOOL_ROTATE_TIME   = [1.5, 2.5];
const TOOL_MOVE_TIME     = [1.2, 2.0];
const TOOL_PAUSE_TIME    = [0.5, 1.0];

const PRODUCT_ROTATE_TIME = [0.8, 1.6];
const PRODUCT_PAUSE_TIME  = [0.6, 1.2];

// ------ 주 모델(툴) 상태 ------
const toolState = {
  mode: "pause",               // "pause" | "rotate" | "move"
  moveAxis: "z",               // "y" | "z" (x 금지)
  moveDir: 1,                  // +1 | -1
  moveStart: new THREE.Vector3(),
  moveTarget: new THREE.Vector3(),
  timer: 0,
  dur: 0
};

function randRange(min, max) { return min + Math.random() * (max - min); }

function toolSetPause() {
  toolState.mode = "pause";
  toolState.timer = 0;
  toolState.dur = randRange(TOOL_PAUSE_TIME[0], TOOL_PAUSE_TIME[1]);
  hudState.textContent = "상태: pause";
}

function toolSetRotate() {
  toolState.mode = "rotate";
  toolState.timer = 0;
  toolState.dur = randRange(TOOL_ROTATE_TIME[0], TOOL_ROTATE_TIME[1]);
  hudState.textContent = "상태: rotate";
}

// ★ 이동값 랜덤 X: 축/방향에 맞춘 ‘경계(0 또는 1)’로 직행
function toolSetMove(axis, dir) {
  if (!toolRoot) { toolSetPause(); return; }
  toolState.mode = "move";
  toolState.timer = 0;
  toolState.dur = randRange(TOOL_MOVE_TIME[0], TOOL_MOVE_TIME[1]);

  toolState.moveAxis = axis; // "y" | "z"
  toolState.moveDir  = dir;  // +1 | -1

  toolState.moveStart.copy(toolRoot.position);
  clampToBounds(toolState.moveStart);

  toolState.moveTarget.copy(toolState.moveStart);
  if (axis === "y") {
    const targetY = dir > 0 ? BOUNDS_MAX.y : BOUNDS_MIN.y;
    const finalY = (Math.abs(toolState.moveStart.y - targetY) < 1e-6)
      ? (dir > 0 ? BOUNDS_MIN.y : BOUNDS_MAX.y)
      : targetY;
    toolState.moveTarget.y = finalY;
  } else { // z
    const targetZ = dir > 0 ? BOUNDS_MAX.z : BOUNDS_MIN.z;
    const finalZ = (Math.abs(toolState.moveStart.z - targetZ) < 1e-6)
      ? (dir > 0 ? BOUNDS_MIN.z : BOUNDS_MAX.z)
      : targetZ;
    toolState.moveTarget.z = finalZ;
  }
  clampToBounds(toolState.moveTarget);

  hudState.textContent = `상태: move (${axis} ${dir > 0 ? "+" : "-"})`;
}

// ------ 추가 모델(제품) 상태 ------
const productState = {
  mode: "pause",              // "pause" | "rotate"
  timer: 0,
  dur: 0
};

function productSetPause() {
  productState.mode = "pause";
  productState.timer = 0;
  productState.dur = randRange(PRODUCT_PAUSE_TIME[0], PRODUCT_PAUSE_TIME[1]);
}

function productSetRotate() {
  productState.mode = "rotate";
  productState.timer = 0;
  productState.dur = randRange(PRODUCT_ROTATE_TIME[0], PRODUCT_ROTATE_TIME[1]);
}

// ------ 고정 시퀀스(요청 흐름) --------------------------------------------
// 0) 제품 정지 + 툴 회전
// 1) 툴 정지
// 2) 툴 z+ 이동
// 3) 툴 정지
// 4) 툴 y- 이동
// 5) 툴 정지
// 6) 제품 회전
// 7) 제품 정지
// 8) 툴 y+ 이동
// 9) 툴 정지
// 10) 툴 z- 이동
// 11) 툴 정지
// 12) 툴 회전  → 루프
const STEPS = [
  { product: {mode: "pause"},  tool: {mode: "rotate"} },
  { tool:    {mode: "pause"} },
  { tool:    {mode: "move", axis: "z", dir: +1} },
  { tool:    {mode: "pause"} },
  { tool:    {mode: "move", axis: "y", dir: -1} },
  { tool:    {mode: "pause"} },
  { product: {mode: "rotate"} },
  { product: {mode: "pause"} },
  { tool:    {mode: "move", axis: "y", dir: +1} },
  { tool:    {mode: "pause"} },
  { tool:    {mode: "move", axis: "z", dir: -1} },
  { tool:    {mode: "pause"} },
  { tool:    {mode: "rotate"} },
];

let stepIndex = 0;
let stepTimer = 0;
let stepDur = 0;

function computeStepDuration(def) {
  let dur = 0;
  if (def.tool) {
    if (def.tool.mode === "rotate") dur = Math.max(dur, randRange(TOOL_ROTATE_TIME[0], TOOL_ROTATE_TIME[1]));
    if (def.tool.mode === "move")   dur = Math.max(dur, randRange(TOOL_MOVE_TIME[0], TOOL_MOVE_TIME[1]));
    if (def.tool.mode === "pause")  dur = Math.max(dur, randRange(TOOL_PAUSE_TIME[0], TOOL_PAUSE_TIME[1]));
  }
  if (def.product) {
    if (def.product.mode === "rotate") dur = Math.max(dur, randRange(PRODUCT_ROTATE_TIME[0], PRODUCT_ROTATE_TIME[1]));
    if (def.product.mode === "pause")  dur = Math.max(dur, randRange(PRODUCT_PAUSE_TIME[0], PRODUCT_PAUSE_TIME[1]));
  }
  return Math.max(0.4, dur);
}

function applyStep(def) {
  if (def.tool) {
    const m = def.tool.mode;
    if (m === "pause")  toolSetPause();
    if (m === "rotate") toolSetRotate();
    if (m === "move")   toolSetMove(def.tool.axis, def.tool.dir);
  }
  if (def.product) {
    const m = def.product.mode;
    if (m === "pause")  productSetPause();
    if (m === "rotate") productSetRotate();
  }
  stepTimer = 0;
  stepDur = computeStepDuration(def);
}

// 최초 적용
applyStep(STEPS[stepIndex]);

/* -----------------------------------------------------------------------
 * 제품 색 업데이트(부하율 torq → 색상)
 * ---------------------------------------------------------------------*/
function updateProductMaterial() {
  if (!productRoot) return;
  const t01 = Math.max(0, Math.min(1, torq / 10)); // 0~10 → 0~1
  const hue = 140 * (1 - t01); // green→red
  const color = new THREE.Color(`hsl(${hue}, 80%, 55%)`);
  productRoot.traverse((o) => {
    if (o.isMesh && o.material && "color" in o.material) {
      o.material.color.copy(color);
    }
  });
}

// === 렌더 루프 =============================================================
function animate() {
  requestAnimationFrame(animate);
  controls.update();

  const dt = clock.getDelta();

  // ----- 주 모델(툴) 업데이트 -----
  if (toolRoot) {
    toolState.timer += dt;

    if (toolState.mode === "rotate") {
      // X/Y 회전 금지 → Z축만 회전 (고정 속도)
      toolRoot.rotation.set(
        0,
        toolRoot.rotation.y + TOOL_ROT_SPEED * dt,                      // Y 유지
        toolRoot.rotation.z 
      );
    } else if (toolState.mode === "move") {
      const t01 = Math.min(1, toolState.timer / toolState.dur);
      toolRoot.position.lerpVectors(toolState.moveStart, toolState.moveTarget, t01);
      clampToBounds(toolRoot.position);
    }
    // pause는 그대로 유지
  }

  // ----- 추가 모델(제품) 업데이트 -----
  if (productRoot) {
    productState.timer += dt;
    if (productState.mode === "rotate") {
      // RPM → 각속도(rad/s)로 변환, +Y 한 방향 회전
      productRoot.rotation.y += rpmToRadPerSec(rpm) * dt;
    }
  }

  // ----- 스텝 진행 -----
  stepTimer += dt;
  if (stepTimer >= stepDur) {
    stepIndex = (stepIndex + 1) % STEPS.length;
    applyStep(STEPS[stepIndex]);
  }

  renderer.render(scene, camera);
}
animate();
resize();

// === Chart.js ==============================================================
const ctx = document.getElementById("lineChart")?.getContext("2d");
const maxPoints = 60;
const labels = [];
const rpmData = [];
const feedData = [];
const torqData = [];

const chart = ctx ? new Chart(ctx, {
  type: "line",
  data: {
    labels,
    datasets: [
      { label: "RPM", data: rpmData, borderWidth: 2, tension: 0.25 },
      { label: "Feed", data: feedData, borderWidth: 2, tension: 0.25 },
      { label: "Torque", data: torqData, borderWidth: 2, tension: 0.25 },
    ]
  },
  options: {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { ticks: { color: "#99a3ad" }, grid: { color: "rgba(255,255,255,0.04)" } },
      y: { ticks: { color: "#99a3ad" }, grid: { color: "rgba(255,255,255,0.04)" } },
    },
    plugins: { legend: { labels: { color: "#e9eef4" } } }
  }
}) : null;

function pushPoint(ts, rpmV, feedV, torqV) {
  if (!chart) return;
  labels.push(new Date(ts).toLocaleTimeString());
  rpmData.push(rpmV); feedData.push(feedV); torqData.push(torqV);
  if (labels.length > maxPoints) { labels.shift(); rpmData.shift(); feedData.shift(); torqData.shift(); }
  chart.update();
}

// === UI 유틸 ===============================================================
function setConn(status) {
  if (status === "ok") connState.innerHTML = '<span class="statusDot ok"></span>연결됨';
  else if (status === "warn") connState.innerHTML = '<span class="statusDot warn"></span>연결 대기';
  else connState.innerHTML = '<span class="statusDot bad"></span>연결 안 됨';
}

function applyState() {
  rpmVal.textContent = Math.round(rpm).toLocaleString();
  feedVal.textContent = Math.round(feed).toLocaleString();
  torqVal.textContent = torq.toFixed(2);
  updateProductMaterial();  // 제품 색상만 갱신
}

lineSel.addEventListener("change", () => { hudLine.textContent = "라인: " + lineSel.value; });
toolSel.addEventListener("change", () => { hudTool.textContent = "툴: " + toolSel.value; });

// === MOCK ===============================================================
let mockTimer = null;
function startMock() {
  stopWs();
  setConn("warn");
  if (mockTimer) clearInterval(mockTimer);
  mockTimer = setInterval(() => {
    const now = new Date();
    const active = Math.random() > 0.2;
    state = active ? "cutting" : "idle";

    // ⚠️ 제품 기준 데이터 생성
    rpm  = active ? 1800 + Math.random()*800  : 300 + Math.random()*100;
    feed = active ? 120  + Math.random()*80   : 20  + Math.random()*10;
    torq = active ? 2.0  + Math.random()*4.0  : 0.3 + Math.random()*0.5;

    const s = new Date(now.getTime() + 24*3600*1000);
    const e = new Date(now.getTime() + 36*3600*1000);
    predVal.textContent = `${s.toLocaleString()} ~ ${e.toLocaleString()}`;
    applyState();
    pushPoint(now.toISOString(), rpm, feed, torq);
  }, 1000);
}

// === WebSocket ============================================================
let ws = null;
function startWs(url) {
  if (mockTimer) { clearInterval(mockTimer); mockTimer = null; }
  stopWs();
  setConn("warn");
  try {
    ws = new WebSocket(url);
    ws.addEventListener("open",  () => setConn("ok"));
    ws.addEventListener("close", () => setConn("bad"));
    ws.addEventListener("error", () => setConn("bad"));
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.line) hudLine.textContent = "라인: " + msg.line;
        if (msg.tool_num != null) hudTool.textContent = "툴: " + msg.tool_num;
        if (msg.state) state = msg.state;

        // ⚠️ 제품 기준 데이터 입력
        if (typeof msg.rpm  === "number") rpm  = msg.rpm;
        if (typeof msg.feed === "number") feed = msg.feed;
        if (typeof msg.troq === "number") torq = msg.troq;

        if (msg.prediction && Array.isArray(msg.prediction.replace_window)) {
          const [s, e] = msg.prediction.replace_window;
          predVal.textContent = `${new Date(s).toLocaleString()} ~ ${new Date(e).toLocaleString()}`;
        }
        applyState();
        pushPoint(msg.ts || Date.now(), rpm, feed, torq);
      } catch(e) { console.warn("WS parse error", e); }
    });
  } catch(e) { console.error(e); setConn("bad"); }
}

function stopWs() { if (ws) { try { ws.close(); } catch(e){} ws = null; } }

// === 버튼 ================================================================
btnMock.addEventListener("click", startMock);
btnWs.addEventListener("click", () => {
  const fallback = "ws://localhost:8765/lines/1";
  const url = wsUrlInput && wsUrlInput.value ? wsUrlInput.value : fallback;
  startWs(url);
});

// 초기 MOCK 시작
startMock();

