/*  KhốiCraft Online — máy chủ
 *  Chạy:  npm install  rồi  node server.js
 *  Mặc định cổng 3000 (hoặc biến môi trường PORT).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || '35', 10);
/* ⚠️ `let` chứ không phải `const`: đổi theo bản đồ đang xử lý (xem useWorld). */
let WORLD_R = 80, WORLD_H = 128, IS_V = false;
const VGY = 63;                 // cao độ nền bản đồ Làng — ⚠️ GIỐNG HỆT client
const MAPSPEC = {
  campus:  { R: 80,  H: 128, spawnY: 96 },
  village: { R: 100, H: 212, spawnY: 78 },
};
// Khu vực đặc biệt (GIỐNG HỆT client!)
const CAMPUS = {x0:-24, x1:24, z0:8, z1:46, H:60};   // 12 + GROUND_LIFT
const LAKE = {x:-45, z:-35, r:13, depth:5};
const TRACK = {x0:33, x1:75, z0:-1, z1:31, H:60, cx:54, cz:15, rx:18, rz:13};   // 12 + GROUND_LIFT

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const THREE_JS = fs.readFileSync(path.join(__dirname, 'public', 'three.min.js'));

// 🖼️ Texture HD: public/tex/256/*.webp, public/tex/512/*.webp — chỉ tải khi người chơi chọn Vừa/Cao.
// Đọc theo yêu cầu (không giữ RAM) + cho trình duyệt cache 30 ngày.
const TEX_DIR = path.join(__dirname, 'public', 'tex');
const MAPS_DIR = path.join(__dirname, 'public', 'maps');
const TEX_MIME = { '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.url.startsWith('/three.min.js')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=86400' });
    res.end(THREE_JS);
    return;
  }
  /* Dữ liệu bản đồ (maps/village.json ~936 KB). Cache 1 ngày: file này chỉ đổi
     khi mình dựng lại bản đồ, nhưng không đặt 'immutable' để còn sửa được. */
  if (req.url.startsWith('/maps/')) {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/maps\//, '');
    const file = path.join(MAPS_DIR, rel);
    if (!file.startsWith(MAPS_DIR + path.sep) || !/\.json$/.test(file)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                           'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
    return;
  }
  if (req.url.startsWith('/tex/')) {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/tex\//, '');
    const file = path.join(TEX_DIR, rel);
    if (!file.startsWith(TEX_DIR + path.sep) || !/\.(webp|png|json)$/.test(file)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': TEX_MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': path.extname(file) === '.json' ? 'no-cache' : 'public, max-age=2592000, immutable'
      });
      res.end(data);
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(INDEX);
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

const SEED = (Math.random() * 2147483647) | 0;

/* ═══════════ 🗺️ NHIỀU THẾ GIỚI ═══════════
   Mỗi bản đồ một hộp trạng thái riêng. `W` là thế giới ĐANG xử lý — mọi hàm bên
   dưới đọc/ghi qua `W.` nên không phải truyền tham số. Đổi bằng useWorld(). */
function newWorld(id) {
  const sp = MAPSPEC[id];
  return { id, R: sp.R, H: sp.H, spawnY: sp.spawnY,
    edits: new Map(),         // "x,y,z" -> mã khối (0 = đã phá)
    structure: new Map(),     // công trình server dựng (trường học / build của làng)
    mobs: new Map(),
    itemDrops: new Map(),
    hCache: new Map(),
    pads: [],                 // vùng san phẳng (bản đồ Làng), nạp từ maps/village.json
    mobNextId: 1, dropNextId: 1,
    matchStart: Date.now(), matchOver: false,
    animalT: 8, zombieT: 3, creeperT: 15, fishT: 6 };
}
const WORLDS = { campus: newWorld('campus'), village: newWorld('village') };
let W = WORLDS.campus;
function useWorld(id) {
  W = WORLDS[id] || WORLDS.campus;
  WORLD_R = W.R; WORLD_H = W.H; IS_V = (W.id === 'village');
}
/* Người chơi TRONG thế giới đang xử lý. Trả về MẢNG chứ không phải generator, vì
   nhiều chỗ vừa lặp vừa xoá phần tử. */
function wplayers() {
  const out = [];
  for (const p of players.values()) if (p.map === W.id) out.push(p);
  return out;
}
function wcount() { let n = 0; for (const p of players.values()) if (p.map === W.id) n++; return n; }
function mapCounts() {
  const c = {};
  for (const id in WORLDS) c[id] = 0;
  for (const p of players.values()) if (c[p.map] !== undefined) c[p.map]++;
  return c;
}
const START_TIME = Date.now();
/* `edits` giờ thuộc từng thế giới — xem newWorld() */
/* ⛏️ KHOÁNG SẢN trong lòng đất (giống hệt client!) */
const ORE_IT = { 12: 10, 13: 11, 14: 12, 15: 13 }; // khối quặng -> mã vật phẩm (than, sắt, vàng, hồng ngọc)
function hsh3(x, y, z) {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 915488749) + Math.imul(z, 668265263) + Math.imul(SEED, 974634733)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177); n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
function oreAt(x, y, z, h) {
  if (h === undefined) h = heightAt(x, z);
  if (y < 2 || y >= h - 2) return 0;
  const r = hsh3(x, y, z);
  if (r < 0.030) return 12;                 // than
  if (r < 0.048) return 13;                 // sắt
  if (y < h * 0.55 && r < 0.058) return 14;    // vàng — ⚠️ GIỐNG HỆT client: đổi sang
  if (y < h * 0.35 && r < 0.0625) return 15;   //   TỈ LỆ vì đất nay dày gấp 5
  return 0;
}
/* 🎮 VÁN CHƠI: 15 phút hoặc ai gom đủ 5 ĐÁ SỨC MẠNH 🔮 */
const MATCH_LEN = 15 * 60 * 1000;
const STONE_IT = 14, STONE_TOTAL = 5;
/* matchStart / matchOver: MỖI BẢN ĐỒ MỘT VÁN riêng — xem newWorld() */
const players = new Map();   // id -> {id, ws, name, x, y, z, yaw, hp}
/* 🏆 BẢNG VÀNG — thống kê theo TÊN (giữ nguyên khi vào lại) */
const stats = new Map();     // nameKey -> {name, esc, ans, caught}
function statOf(p) {
  const k = (p.name || '?').toLowerCase();
  let s = stats.get(k);
  if (!s) { s = { name: p.name || '?', esc: 0, ans: 0, caught: 0 }; stats.set(k, s); }
  return s;
}
function boardMsg() {
  const arr = [...stats.values()];
  const top = (f) => arr.filter(s => s[f] > 0).sort((a, b) => b[f] - a[f]).slice(0, 5).map(s => [s.name, s[f]]);
  return { type: 'board', esc: top('esc'), ans: top('ans'), caught: top('caught') };
}
let nextId = 1;

/* ---------- địa hình (giống hệt client, cùng seed) ---------- */
// 🪨 Nâng CẢ địa hình lên 48 khối -> từ mặt đất xuống đá gốc dày ~60 thay vì ~12
//    (gấp ~5). Hình dạng bề mặt KHÔNG đổi vì mọi mốc độ cao dời cùng nhau.
//    ⚠️ PHẢI GIỐNG HỆT client!
const GROUND_LIFT = 48;
const SEA = 58, DAY_LEN = 480;       // 10 + GROUND_LIFT
function hsh(x, z) {
  let n = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(SEED, 974634733)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177); n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
const smooth = t => t * t * (3 - 2 * t);
function vnoise(u, v) {
  const iu = Math.floor(u), iv = Math.floor(v), fu = smooth(u - iu), fv = smooth(v - iv);
  const a = hsh(iu, iv), b = hsh(iu + 1, iv), c = hsh(iu, iv + 1), d = hsh(iu + 1, iv + 1);
  return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
}
/* ═══════════ 🏘️ ĐỊA HÌNH BẢN ĐỒ LÀNG ═══════════
   ⚠️ PHẢI GIỐNG HỆT client (patch_maps.py -> heightAtVillage). Lệch một chữ là
   người chơi rơi xuyên mặt đất. tools/tsync.js so 200.000 ô để kiểm tra. */
function padDist(x, z) {
  const V = W.pads;
  let best = 1e9;
  for (let i = 0; i < V.length; i++) {
    const p = V[i];
    const dx = Math.max(0, Math.max(p[0] - x, x - p[1]));
    const dz = Math.max(0, Math.max(p[2] - z, z - p[3]));
    const d = dx > dz ? dx : dz;
    if (d < best) { best = d; if (d === 0) return 0; }
  }
  return best;
}
const VLAKE = { x: 78, z: 0, r: 16, depth: 6 };
const VTRACK = { x0: 22, x1: 62, z0: 46, z1: 86, H: 63, cx: 42, cz: 66, rx: 17, rz: 16 };
function heightAtVillage(x, z) {
  let a = 0, amp = 1, f = 0.021, tot = 0;
  for (let o = 0; o < 4; o++) { a += vnoise(x * f + 300, z * f + 300) * amp; tot += amp; amp *= 0.5; f *= 2.1; }
  let h = Math.floor(VGY - 5 + (a / tot) * 12);
  const L = VLAKE;
  const ldx = x - L.x, ldz = z - L.z, dl = Math.sqrt(ldx * ldx + ldz * ldz);
  if (dl < L.r) { const t = 1 - dl / L.r; h = SEA - 1 - Math.floor(L.depth * t); }
  else if (dl < L.r + 7) { const t = (dl - L.r) / 7; h = Math.round((SEA + 1) * (1 - t) + h * t); }
  const K2 = VTRACK;
  if (x >= K2.x0 - 4 && x <= K2.x1 + 4 && z >= K2.z0 - 4 && z <= K2.z1 + 4) {
    const dx = Math.max(0, Math.max(K2.x0 - x, x - K2.x1));
    const dz = Math.max(0, Math.max(K2.z0 - z, z - K2.z1));
    const d = Math.max(dx, dz);
    if (d === 0) h = K2.H; else { const t = d / 4; h = Math.round(K2.H * (1 - t) + h * t); }
  }
  const d = padDist(x, z);
  if (d === 0) h = VGY;
  else if (d <= 5) { const t = d / 5; h = Math.round(VGY * (1 - t) + h * t); }
  return h;
}
function heightAt(x, z) {
  if (IS_V) {
    const k = x * 100003 + z;
    const c = W.hCache.get(k);
    if (c !== undefined) return c;
    const h = heightAtVillage(x, z);
    W.hCache.set(k, h);
    return h;
  }
  return heightAtCampus(x, z);
}
function heightAtCampus(x, z) {
  const k = x + ',' + z;
  let h = W.hCache.get(k);
  if (h === undefined) {
    let a = 0, amp = 1, f = 0.028, tot = 0;
    for (let o = 0; o < 4; o++) { a += vnoise(x * f + 100, z * f + 100) * amp; tot += amp; amp *= 0.5; f *= 2.1; }
    h = Math.floor(3 + GROUND_LIFT + (a / tot) * 18);   // ⚠️ GIỐNG HỆT client!
    // hồ nước: lòng chảo
    const ldx = x - LAKE.x, ldz = z - LAKE.z, dl = Math.sqrt(ldx * ldx + ldz * ldz);
    if (dl < LAKE.r) { const t = 1 - dl / LAKE.r; h = SEA - 1 - Math.floor(LAKE.depth * t); }
    else if (dl < LAKE.r + 6) { const t = (dl - LAKE.r) / 6; h = Math.round((SEA + 1) * (1 - t) + h * t); }
    // sân trường: san phẳng, mép thoải
    if (x >= CAMPUS.x0 - 4 && x <= CAMPUS.x1 + 4 && z >= CAMPUS.z0 - 4 && z <= CAMPUS.z1 + 4) {
      const dx = Math.max(0, Math.max(CAMPUS.x0 - x, x - CAMPUS.x1));
      const dz = Math.max(0, Math.max(CAMPUS.z0 - z, z - CAMPUS.z1));
      const d = Math.max(dx, dz);
      if (d === 0) h = CAMPUS.H; else { const t = d / 4; h = Math.round(CAMPUS.H * (1 - t) + h * t); }
    }
    // đường đua: san phẳng
    if (x >= TRACK.x0 - 4 && x <= TRACK.x1 + 4 && z >= TRACK.z0 - 4 && z <= TRACK.z1 + 4) {
      const dx = Math.max(0, Math.max(TRACK.x0 - x, x - TRACK.x1));
      const dz = Math.max(0, Math.max(TRACK.z0 - z, z - TRACK.z1));
      const d = Math.max(dx, dz);
      if (d === 0) h = TRACK.H; else { const t = d / 4; h = Math.round(TRACK.H * (1 - t) + h * t); }
    }
    W.hCache.set(k, h);
  }
  return h;
}
/* ---------- kết cấu trường học (phần đặc, để mob đi lại đúng) ---------- */
/* `structure` giờ thuộc từng thế giới — xem newWorld() */
/* ⚠️ Dựng vào thế giới SÂN TRƯỜNG. Lúc này `W` vẫn đang trỏ vào campus (giá trị
   khởi tạo) nên đúng, nhưng gọi useWorld cho rõ ràng và chống lỗi về sau. */
useWorld('campus');
(function buildSchoolStructure() {
  const F = CAMPUS.H;
  const add = (x, y, z, t) => W.structure.set(x + ',' + y + ',' + z, t);
  const del = (x, y, z) => W.structure.delete(x + ',' + y + ',' + z);
  const box = (x0, y0, z0, x1, y1, z1, t) => { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) add(x, y, z, t); };
  const bld = (x0, x1, z0, z1, nf) => {
    for (let f = 0; f < nf; f++) {
      const b = F + 1 + f * 4;
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        add(x, b - 1, z, 3);
        const edge = (x === x0 || x === x1 || z === z0 || z === z1);
        if (edge) { for (let y = b; y <= b + 2; y++) add(x, y, z, 6); }
        else { for (let y = b; y <= b + 2; y++) del(x, y, z); }
      }
    }
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) add(x, F + nf * 4, z, 9);
    for (let x = x0; x <= x1; x++) { add(x, F + nf * 4 + 1, z0, 9); add(x, F + nf * 4 + 1, z1, 9); }
    for (let z = z0; z <= z1; z++) { add(x0, F + nf * 4 + 1, z, 9); add(x1, F + nf * 4 + 1, z, 9); }
  };
  bld(-20, 20, 40, 45, 4);
  bld(-21, -16, 14, 39, 3);
  bld(16, 21, 14, 39, 3);
  for (let x = -1; x <= 1; x++) for (let y = F + 1; y <= F + 2; y++) del(x, y, 40);
  for (let z = 25; z <= 27; z++) for (let y = F + 1; y <= F + 2; y++) { del(-16, y, z); del(16, y, z); }
  // cầu thang thông tầng + phòng học (GIỐNG client)
  for (let f = 0; f < 3; f++) {
    const Y = F + f * 4;
    for (let x = -19; x <= -17; x++) for (let z = 41; z <= 42; z++) del(x, Y + 4, z);
    for (let i = 0; i < 3; i++) for (let z = 41; z <= 42; z++) add(-19 + i, Y + 1 + i, z, 8);
  }
  for (let f = 0; f < 4; f++) {
    const b = F + 1 + f * 4;
    for (let x = -15; x <= 19; x++) {
      if (x === -13 || x === -5 || x === 5 || x === 13) { add(x, b + 2, 42, 8); continue; }
      for (let y = b; y <= b + 2; y++) add(x, y, 42, 8);
    }
    for (const wx of [-10, 0, 10]) for (let z = 43; z <= 44; z++) for (let y = b; y <= b + 2; y++) add(wx, y, z, 8);
    for (const [rx0, rx1] of [[-15,-11],[-9,-1],[1,9],[11,19]]) {
      const mid = Math.floor((rx0 + rx1) / 2);
      for (let x = mid - 1; x <= mid + 1; x++) for (let y = b + 1; y <= b + 2; y++) add(x, y, 44, 11);
      for (let x = rx0; x <= rx1; x += 2) if (x !== mid) add(x, b, 43, 8);
    }
  }
  for (const side of [-1, 1]) {
    const xi0 = side < 0 ? -20 : 17;
    for (let f = 0; f < 3; f++) {
      const b = F + 1 + f * 4;
      for (let x = xi0; x <= xi0 + 3; x++) {
        if (x === xi0 + 1) { add(x, b + 2, 26, 8); continue; }
        for (let y = b; y <= b + 2; y++) add(x, y, 26, 8);
      }
      for (const bz of [16, 37]) for (let y = b + 1; y <= b + 2; y++) for (let x = xi0 + 1; x <= xi0 + 2; x++) add(x, y, bz, 11);
      for (const z of [18, 21, 24, 29, 32, 35]) add(side < 0 ? -19 : 18, b, z, 8);
    }
  }
  for (let x = CAMPUS.x0; x <= CAMPUS.x1; x++) { if (Math.abs(x) > 3) add(x, F + 1, 8, 9); add(x, F + 1, 46, 9); }
  for (let z = 8; z <= 46; z++) { add(CAMPUS.x0, F + 1, z, 9); add(CAMPUS.x1, F + 1, z, 9); }
  box(-4, F + 1, 8, -4, F + 4, 8, 9); box(4, F + 1, 8, 4, F + 4, 8, 9);
  const goal = (z) => { box(-13, F + 1, z, -13, F + 2, z, 8); box(-7, F + 1, z, -7, F + 2, z, 8); box(-13, F + 3, z, -7, F + 3, z, 8); };
  goal(30); goal(38);
  const hoop = (z) => { box(10, F + 1, z, 10, F + 3, z, 4); add(10, F + 4, z, 8); };
  hoop(31); hoop(37);
  [[-8, 14], [8, 14], [-8, 30], [8, 30]].forEach(([x, z]) => add(x, F + 1, z, 3));
  // Kiosk căng tin + văn phòng phẩm (GIỐNG client)
  const kiosk = (x0, x1, z0, z1) => {
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      add(x, F, z, 8);
      for (let y = F + 1; y <= F + 3; y++) {
        const edge = x === x0 || x === x1 || z === z0 || z === z1;
        if (!edge) continue;
        const front = z === z1 && x > x0 && x < x1;
        if (front) { if (y === F + 1) add(x, y, z, 10); }
        else add(x, y, z, 8);
      }
      add(x, F + 4, z, 9);
    }
    for (let x = x0; x <= x1; x++) add(x, F + 4, z1 + 1, 9);
  };
  kiosk(6, 13, 9, 13);
  kiosk(-13, -6, 9, 13);
  kiosk(-23, -16, 9, 13); // Shop Thời Trang
  // đường đua tàu lượn: mặt ray 3D + lan can + trụ + cổng (GIỐNG client)
  {
    const H = TRACK.H;
    const PTS = [[72,15,0],[70,24,5],[64,27,13],[54,21,1],[44,27,7],[37,24,2],[35,15,10],[37,6,3],[44,3,8],[54,9,0],[64,3,5],[70,6,1]];
    const n = PTS.length, seg = Math.ceil(360 / n), pts = [];
    const cr = (a,b,c,d,t) => { const t2=t*t,t3=t2*t; return 0.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t2+(-a+3*b-3*c+d)*t3); };
    for (let i = 0; i < n; i++) {
      const p0 = PTS[(i-1+n)%n], p1 = PTS[i], p2 = PTS[(i+1)%n], p3 = PTS[(i+2)%n];
      for (let j = 0; j < seg; j++) {
        const t = j/seg;
        pts.push([cr(p0[0],p1[0],p2[0],p3[0],t), cr(p0[1],p1[1],p2[1],p3[1],t), Math.max(0, cr(p0[2],p1[2],p2[2],p3[2],t))]);
      }
    }
    const N = pts.length, deckMap = new Map();
    for (let i = 0; i < N; i++) {
      const [x,z,yo] = pts[i], [x2,z2] = pts[(i+1)%N];
      let dx = x2-x, dz = z2-z; const dl = Math.sqrt(dx*dx+dz*dz)||1; dx/=dl; dz/=dl;
      const nx = -dz, nz = dx;
      const dy = H + Math.round(yo);
      for (let off = -1.3; off <= 1.3; off += 0.45)
        deckMap.set(Math.round(x+nx*off)+','+Math.round(z+nz*off), dy);
    }
    for (const [k2, dy] of deckMap) {
      const [fx,fz] = k2.split(',').map(Number);
      if (dy > H) add(fx, dy, fz, 3); // sàn ray trên cao (phần dưới đất trùng mặt đất sẵn)
    }
    for (let i = 0; i < N; i++) {
      const [x,z,yo] = pts[i], [x2,z2] = pts[(i+1)%N];
      let dx = x2-x, dz = z2-z; const dl = Math.sqrt(dx*dx+dz*dz)||1; dx/=dl; dz/=dl;
      const nx = -dz, nz = dx;
      const dy = H + Math.round(yo);
      for (const off of [-2.2, 2.2]) {
        const cx2 = Math.round(x+nx*off), cz2 = Math.round(z+nz*off);
        if (deckMap.get(cx2+','+cz2) === undefined) add(cx2, dy+1, cz2, 9);
      }
      if (i % 4 === 0 && yo >= 1) {
        const cx2 = Math.round(x), cz2 = Math.round(z);
        for (let y = H+1; y < dy; y++) { const kk = cx2+','+y+','+cz2; if (!W.structure.has(kk)) W.structure.set(kk, 4); }
      }
    }
    const [sx,sz] = pts[0], [sx2,sz2] = pts[1];
    let dx = sx2-sx, dz = sz2-sz; const dl = Math.sqrt(dx*dx+dz*dz)||1; dx/=dl; dz/=dl;
    const nx = -dz, nz = dx;
    for (const off of [-2.4, 2.4]) {
      const px2 = Math.round(sx+nx*off), pz2 = Math.round(sz+nz*off);
      for (let y = H+1; y <= H+4; y++) add(px2, y, pz2, 9);
    }
    for (let off = -2.4; off <= 2.4; off += 0.5) add(Math.round(sx+nx*off), H+5, Math.round(sz+nz*off), 9);
  }
})();
/* ═══════════ 🕳️ HANG ĐỘNG — ⚠️ PHẢI GIỐNG HỆT client! ═══════════
   `vn3` là nhiễu mượt 3 chiều dựng từ `hsh3` (dùng chung SEED) nên hang ở hai bên
   nằm ĐÚNG cùng chỗ. Lệch một chữ là người chơi thấy hang mà server vẫn coi là đá
   đặc -> đi vào bị đẩy ra, hoặc ngược lại rơi xuyên đất.
   Hang = GIAO của hai vùng nhiễu khác tần số: một vùng thôi thì ra bọng tròn rời
   rạc, giao hai vùng cho ra đường hầm uốn lượn nối nhau. */
function vn3(u, v, w) {
  const iu = Math.floor(u), iv = Math.floor(v), iw = Math.floor(w);
  const fu = smooth(u - iu), fv = smooth(v - iv), fw = smooth(w - iw);
  const c000 = hsh3(iu, iv, iw),         c100 = hsh3(iu + 1, iv, iw);
  const c010 = hsh3(iu, iv + 1, iw),     c110 = hsh3(iu + 1, iv + 1, iw);
  const c001 = hsh3(iu, iv, iw + 1),     c101 = hsh3(iu + 1, iv, iw + 1);
  const c011 = hsh3(iu, iv + 1, iw + 1), c111 = hsh3(iu + 1, iv + 1, iw + 1);
  const x00 = c000 + (c100 - c000) * fu, x10 = c010 + (c110 - c010) * fu;
  const x01 = c001 + (c101 - c001) * fu, x11 = c011 + (c111 - c011) * fu;
  const y0 = x00 + (x10 - x00) * fv,     y1 = x01 + (x11 - x01) * fv;
  return y0 + (y1 - y0) * fw;
}
function caveAt(x, y, z, h) {
  if (y < 4) return false;        // chừa 4 lớp đáy: hang không thông xuống đá gốc
  if (y > h - 7) return false;    // không đục thủng mặt đất
  const a = vn3(x * 0.045, y * 0.075, z * 0.045);
  const b = vn3(x * 0.028 + 70.5, y * 0.05 + 70.5, z * 0.028 + 70.5);
  return a > 0.615 && b > 0.555;
}
function solidAt(x, y, z) {
  if (y <= 0) return true;
  const k = x + ',' + y + ',' + z;
  const e = W.edits.get(k);
  if (e !== undefined) return e > 0 && e !== 7;
  const s = W.structure.get(k);
  if (s !== undefined) return true;
  const h = heightAt(x, z);
  if (y > h) return false;
  return !caveAt(x, y, z, h);          // ⚠️ khoét hang — client khoét y hệt
}
function topAt(x, z) {
  /* Trước quét từ WORLD_H-1. WORLD_H tăng gấp đôi VÀ solidAt nay còn gọi caveAt
     (16 lần băm) nên quét cả cột rất tốn. Bắt đầu từ mặt đất + 24 là đủ trùm mái
     trường và cầu vượt đường đua, tiết kiệm ~100 vòng mỗi lần gọi. */
  const start = Math.min(WORLD_H - 1, heightAt(x, z) + 24);
  for (let y = start; y >= 0; y--) if (solidAt(x, y, z)) return y;
  return 0;
}
const sunH = () => Math.sin(((Date.now() / 1000 % DAY_LEN) / DAY_LEN) * Math.PI * 2);

/* ---------- mob ---------- */
const MOB_HP = { 1: 6, 2: 8, 3: 6, 4: 3, 5: 12, 6: 10, 7: 2 };
const DROP_OF = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8 }; // mob -> mã vật phẩm
function waterAt(x, y, z) {
  const k = Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z);
  if (W.edits.has(k) || W.structure.has(k)) return false;
  const fy = Math.floor(y);
  return fy >= 1 && fy <= SEA && fy > heightAt(Math.floor(x), Math.floor(z));
}
/* mobs / itemDrops / mobNextId / dropNextId — xem newWorld() */
function countMobs(zombie) { let n = 0; for (const m of W.mobs.values()) { if (zombie ? (m.tc === 5) : (m.tc < 5)) n++; } return n; }
function countTc(tc) { let n = 0; for (const m of W.mobs.values()) if (m.tc === tc) n++; return n; }
function spawnDrop(it, x, y, z) {
  const id = W.dropNextId++;
  W.itemDrops.set(id, { it, x, y, z, t0: Date.now() });
  broadcast({ type: 'drop', id, it, x: Math.round(x * 100) / 100, y, z: Math.round(z * 100) / 100 });
}
function stonesLeft() { let n = 0; for (const d of W.itemDrops.values()) if (d.it === STONE_IT) n++; return n; }
function spawnStones() {
  for (let i = 0; i < STONE_TOTAL; i++) {
    for (let t = 0; t < 60; t++) {
      const x = ((Math.random() * 2 - 1) * (WORLD_R - 8)) | 0, z = ((Math.random() * 2 - 1) * (WORLD_R - 8)) | 0;
      const h = topAt(x, z);
      if (h <= SEA) continue;
      spawnDrop(STONE_IT, x + .5, h + 1, z + .5);
      break;
    }
  }
  console.log('🔮 ' + W.id + ': đã giấu ' + stonesLeft() + ' Đá Sức Mạnh');
}
function matchMsg(p) {
  return { type: 'match', start: W.matchStart, len: MATCH_LEN, left: stonesLeft(), mine: (p && p.stones) || 0 };
}
function endMatch(winnerP, reason) {
  if (W.matchOver) return;
  W.matchOver = true;
  const counts = [...wplayers()].map(p => [p.name, p.stones || 0]).sort((a, b) => b[1] - a[1]);
  let winner = winnerP ? winnerP.name : null;
  if (!winner && counts.length && counts[0][1] > 0 && (counts.length < 2 || counts[0][1] > counts[1][1])) winner = counts[0][0];
  broadcast({ type: 'gameover', winner, reason, counts: counts.slice(0, 8) });
  console.log('🏁 Hết ván (' + reason + ') — thắng: ' + (winner || 'hòa'));
  setTimeout(resetMatch, 12000);
}
function resetMatch() {
  W.edits.clear();
  W.itemDrops.clear();
  for (const p of wplayers()) p.stones = 0;
  W.matchStart = Date.now(); W.matchOver = false;
  spawnStones();
  broadcast({ type: 'reset' });
  console.log('🔄 Ván mới bắt đầu!');
}
function mobDeath(m) {
  W.mobs.delete(m.id);
  broadcast({ type: 'mobdie', id: m.id });
  const it = DROP_OF[m.tc];
  if (it) spawnDrop(it, m.x, m.y, m.z);
}
function boom(cx, cy, cz, r) {
  const rr = r * r;
  for (let x = Math.floor(cx - r); x <= Math.floor(cx + r); x++)
    for (let y = Math.max(1, Math.floor(cy - r)); y <= Math.floor(cy + r); y++)
      for (let z = Math.floor(cz - r); z <= Math.floor(cz + r); z++) {
        const dx = x + .5 - cx, dy = y + .5 - cy, dz = z + .5 - cz;
        if (dx * dx + dy * dy + dz * dz > rr) continue;
        W.edits.set(x + ',' + y + ',' + z, 0);
      }
  broadcast({ type: 'boom', x: cx, y: cy, z: cz, r });
  for (const p of wplayers()) {
    if (p.hp <= 0 || Date.now() - p.spawnAt < 8000) continue;
    const d = Math.sqrt((p.x - cx) ** 2 + (p.y + .9 - cy) ** 2 + (p.z - cz) ** 2);
    if (d < 4.5) {
      let dmg = Math.round(12 * (1 - d / 4.5));
      if (p.armor) dmg = Math.ceil(dmg / 2);
      p.hp = Math.max(0, p.hp - dmg);
      if (p.ws.readyState === 1) p.ws.send(enc({ type: 'hurt', hp: p.hp }));
    }
  }
}
function spawnMob(tc, x, y, z) {
  const id = W.mobNextId++;
  W.mobs.set(id, { id, tc, x, y, z, yaw: 0, hp: MOB_HP[tc], ai: { state: 0, timer: Math.random() * 2, dx: 0, dz: 0, hitCd: 0, fleeT: 0, target: 0 } });
}
function spawnAnimal() {
  for (let i = 0; i < 12; i++) {
    const x = ((Math.random() * 2 - 1) * (WORLD_R - 4)) | 0, z = ((Math.random() * 2 - 1) * (WORLD_R - 4)) | 0;
    const h = topAt(x, z);
    if (h > SEA + 1) { spawnMob(1 + ((Math.random() * 4) | 0), x + .5, h + 1, z + .5); return; }
  }
}
function spawnZombieNear(p) {
  for (let i = 0; i < 12; i++) {
    const ang = Math.random() * Math.PI * 2, d = 11 + Math.random() * 9;
    const x = Math.floor(p.x + Math.sin(ang) * d), z = Math.floor(p.z + Math.cos(ang) * d);
    if (x <= -WORLD_R + 2 || x >= WORLD_R - 2 || z <= -WORLD_R + 2 || z >= WORLD_R - 2) continue;
    const h = topAt(x, z);
    if (h > SEA) { spawnMob(5, x + .5, h + 1, z + .5); return; }
  }
}
function spawnFish() {
  for (let i = 0; i < 24; i++) {
    const x = ((Math.random() * 2 - 1) * (WORLD_R - 4)) | 0, z = ((Math.random() * 2 - 1) * (WORLD_R - 4)) | 0;
    const h = heightAt(x, z);
    if (h >= SEA - 1) continue;
    const y = h + 1.5 + Math.random() * (SEA - h - 1.5);
    spawnMob(7, x + .5, y, z + .5);
    return;
  }
}
function spawnCreeperNear(p) {
  for (let i = 0; i < 12; i++) {
    const ang = Math.random() * Math.PI * 2, d = 16 + Math.random() * 12;
    const x = Math.floor(p.x + Math.sin(ang) * d), z = Math.floor(p.z + Math.cos(ang) * d);
    if (x <= -WORLD_R + 2 || x >= WORLD_R - 2 || z <= -WORLD_R + 2 || z >= WORLD_R - 2) continue;
    const h = topAt(x, z);
    if (h > SEA) { spawnMob(6, x + .5, h + 1, z + .5); return; }
  }
}
/* sinh quái ban đầu chuyển xuống cuối file, chạy cho TỪNG thế giới */

/* Bộ đếm sinh quái nằm TRONG từng thế giới (xem newWorld) — nếu để toàn cục thì
   hai bản đồ tranh nhau một bộ đếm, bản đồ nào cũng sinh quái nửa vời. */
function mobTick(s) {
  let animalT = W.animalT -= s, zombieT = W.zombieT -= s,
      creeperT = W.creeperT -= s, fishT = W.fishT -= s;
  if (animalT <= 0) { W.animalT = 8; if (countMobs(false) < 24) spawnAnimal(); }
  if (fishT <= 0) { W.fishT = 6; if (countTc(7) < 16) spawnFish(); }
  if (zombieT <= 0) {
    W.zombieT = 5;
    const cap = Math.min(4 + wcount() * 2, 30);
    if (sunH() < -0.05 && wcount() > 0 && countMobs(true) < cap) {
      const list = [...wplayers()];
      spawnZombieNear(list[(Math.random() * list.length) | 0]);
    }
  }
  if (creeperT <= 0) {
    W.creeperT = 18;
    const cap = Math.min(2 + Math.ceil(wcount() / 2), 8);
    if (wcount() > 0 && countTc(6) < cap) {
      const list = [...wplayers()];
      spawnCreeperNear(list[(Math.random() * list.length) | 0]);
    }
  }
  // vật phẩm: nhặt & hết hạn (Đá Sức Mạnh không bao giờ hết hạn)
  const now = Date.now();
  if (!W.matchOver && now - W.matchStart > MATCH_LEN) endMatch(null, 'time');
  for (const [id, d] of [...W.itemDrops]) {
    if (d.it !== STONE_IT && now - d.t0 > 60000) { W.itemDrops.delete(id); broadcast({ type: 'took', id, by: 0 }); continue; }
    if (W.matchOver) continue;
    for (const p of wplayers()) {
      if (p.hp <= 0) continue;
      const dd = Math.sqrt((p.x - d.x) ** 2 + (p.z - d.z) ** 2);
      if (dd < 1.5 && Math.abs(p.y - d.y) < 2.2) {
        W.itemDrops.delete(id);
        broadcast({ type: 'took', id, by: p.id });
        if (d.it === STONE_IT) {
          p.stones = (p.stones || 0) + 1;
          broadcast({ type: 'stone', id: p.id, name: p.name, n: p.stones, left: stonesLeft() });
          if (p.stones >= STONE_TOTAL) endMatch(p, 'stones');
        }
        break;
      }
    }
  }
  const day = sunH() > 0.02;
  for (const m of [...W.mobs.values()]) {
    const a = m.ai; a.timer -= s; if (a.hitCd > 0) a.hitCd -= s; if (a.fleeT > 0) a.fleeT -= s;
    let speed = 0;
    if (m.tc === 7) { // cá bơi tự do trong nước
      if (a.timer <= 0) {
        a.timer = 1 + Math.random() * 2.5;
        const ang = Math.random() * Math.PI * 2;
        a.dx = Math.sin(ang); a.dz = Math.cos(ang); a.dy = (Math.random() - .5) * .7;
      }
      const sp = (a.fleeT > 0 ? 2.8 : 1.1) * s;
      const nx = m.x + a.dx * sp, ny = m.y + (a.dy || 0) * sp, nz = m.z + a.dz * sp;
      if (waterAt(nx, ny + .2, nz) && waterAt(nx, ny, nz)) {
        m.x = nx; m.y = ny; m.z = nz;
        m.yaw = Math.atan2(-a.dx, -a.dz);
      } else { a.timer = 0; a.dx = -a.dx; a.dz = -a.dz; a.dy = -(a.dy || 0); }
      continue;
    }
    if (m.tc === 6) { // creeper
      let best = null, bd = 1e9;
      for (const p of wplayers()) {
        if (p.hp <= 0 || p.fly) continue; // đang bay = creeper không rình
        const d = Math.sqrt((p.x - m.x) ** 2 + (p.z - m.z) ** 2);
        if (d < bd) { bd = d; best = p; }
      }
      if (a.fuse > 0) {
        a.fuse -= s;
        if (bd > 4.8) { a.fuse = 0; }
        else if (a.fuse <= 0) {
          W.mobs.delete(m.id);
          broadcast({ type: 'mobdie', id: m.id });
          boom(m.x, m.y + 1, m.z, 2.8);
          continue;
        }
      } else if (best && bd < 2.3) { a.fuse = 1.4; }
      else if (best && bd < 12) { a.dx = (best.x - m.x) / (bd || 1); a.dz = (best.z - m.z) / (bd || 1); speed = 2.6; }
      else {
        if (a.timer <= 0) {
          if (Math.random() < 0.6) { a.state = 0; a.timer = 1 + Math.random() * 2; }
          else { a.state = 1; const ang = Math.random() * Math.PI * 2; a.dx = Math.sin(ang); a.dz = Math.cos(ang); a.timer = 1.5 + Math.random() * 2; }
        }
        speed = a.state === 1 ? 1.2 : 0;
      }
    } else if (m.tc === 5) {
      if (day) { W.mobs.delete(m.id); broadcast({ type: 'mobdie', id: m.id, burn: 1 }); continue; }
      let best = null, bd = 40;
      for (const p of wplayers()) {
        if (p.fly) continue; // đang bay = zombie không đuổi
        const d = Math.hypot(p.x - m.x, p.z - m.z);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) {
        a.dx = (best.x - m.x) / (bd || 1); a.dz = (best.z - m.z) / (bd || 1); speed = 2.3;
        if (bd < 1.35 && a.hitCd <= 0 && best.hp > 0 && Date.now() - best.spawnAt > 8000) {
          a.hitCd = 1.1;
          best.hp = Math.max(0, best.hp - (best.armor ? 2 : 3));
          if (best.ws.readyState === 1) best.ws.send(enc({ type: 'hurt', hp: best.hp }));
        }
      }
    } else {
      if (a.fleeT > 0) speed = 3.4;
      else {
        if (a.timer <= 0) {
          if (Math.random() < 0.5) { a.state = 0; a.timer = 1 + Math.random() * 2; }
          else { a.state = 1; const ang = Math.random() * Math.PI * 2; a.dx = Math.sin(ang); a.dz = Math.cos(ang); a.timer = 1.5 + Math.random() * 2.5; }
        }
        speed = a.state === 1 ? (m.tc === 4 ? 1.0 : 1.3) : 0;
      }
    }
    if (a.slowT > 0) { a.slowT -= s; speed *= 0.45; } // hiệu ứng Kiếm Băng
    if (speed > 0) {
      const nx = m.x + a.dx * speed * s, nz = m.z + a.dz * speed * s;
      const fx = Math.floor(nx), fz = Math.floor(nz);
      if (fx > -WORLD_R && fx < WORLD_R - 1 && fz > -WORLD_R && fz < WORLD_R - 1) {
        const ty = topAt(fx, fz);
        if ((m.tc === 5 || ty > SEA) && ty + 1 - m.y <= 1.25) {
          m.x = nx; m.z = nz; m.y = ty + 1; m.yaw = Math.atan2(-a.dx, -a.dz);
        } else { a.timer = 0; a.fleeT = 0; a.dx = -a.dx; a.dz = -a.dz; }
      } else { a.dx = -a.dx; a.dz = -a.dz; }
    }
  }
}

const enc = (o) => JSON.stringify(o);
/* CHỈ gửi cho người trong bản đồ đang xử lý — nếu không, khối xây ở làng sẽ hiện
   ra giữa sân trường của người khác. */
function broadcast(obj, exceptId) {
  const s = enc(obj);
  for (const p of players.values())
    if (p.map === W.id && p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
}
/* Gửi cho TẤT CẢ, bất kể bản đồ — Bảng Vàng và số người mỗi bản đồ dùng chung. */
function broadcastAll(obj, exceptId) {
  const s = enc(obj);
  for (const p of players.values())
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
}
function pushCounts() { broadcastAll({ type: 'counts', c: mapCounts() }); }
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) {
    ws.send(enc({ type: 'full' }));
    ws.close();
    return;
  }
  const id = nextId++;
  /* `map` phải có giá trị NGAY từ đầu: wplayers()/broadcast lọc theo nó, nếu
     undefined thì người chơi này vô hình với mọi người. 'hello' sẽ đổi sau. */
  const p = { id, ws, map: 'campus', name: 'Người chơi ' + id, x: 0.5, y: 96, z: 0.5, yaw: 0, hp: 20, lastAtk: 0, spawnAt: Date.now() };
  players.set(id, p);
  let saidHello = false;
  p.blockCount = 0; p.chatCount = 0;

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'hello') {
      if (saidHello) return;
      saidHello = true;
      /* Bản đồ: chỉ nhận tên có trong WORLDS. Tên lạ -> về sân trường, và client
         được biết bằng trường `map` trong 'init' nên hai bên không lệch nhau. */
      p.map = (typeof m.map === 'string' && WORLDS[m.map]) ? m.map : 'campus';
      useWorld(p.map);
      p.y = W.spawnY;
      p.name = String(m.name || p.name).slice(0, 16).replace(/[<>]/g, '') || ('Người chơi ' + id);
      ws.send(enc({
        type: 'init', id, seed: SEED, time: Date.now(), map: p.map,
        edits: [...W.edits.entries()],
        players: [...wplayers()].map(q => ({ id: q.id, name: q.name, x: q.x, y: q.y, z: q.z, yaw: q.yaw, app: q.app })),
        drops: [...W.itemDrops.entries()].map(([di, d]) => [di, d.it, d.x, d.y, d.z]),
      }));
      ws.send(JSON.stringify(boardMsg())); // gửi Bảng Vàng hiện tại cho người mới
      ws.send(JSON.stringify(matchMsg(p))); // và trạng thái ván chơi
      broadcast({ type: 'join', p: { id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, app: p.app } }, id);
      pushCounts();
      console.log(`[+] ${p.name} (#${id}) vào ${W.id} — ${players.size}/${MAX_PLAYERS}`);
      return;
    }
    if (!saidHello) return;
    /* ⭐ CỬA VÀO 1: từ đây trở xuống mọi hàm đều đọc/ghi `W`, nên phải trỏ `W` vào
       thế giới của NGƯỜI GỬI. Thiếu dòng này là lỗi nặng nhất có thể xảy ra:
       người ở làng đặt khối thì khối rơi vào thế giới sân trường. */
    useWorld(p.map);

    if (m.type === 'pos') {
      if (!isNum(m.x) || !isNum(m.y) || !isNum(m.z) || !isNum(m.yaw)) return;
      p.x = Math.max(-WORLD_R - 2, Math.min(WORLD_R + 2, m.x));
      p.y = Math.max(-30, Math.min(WORLD_H + 30, m.y));
      p.z = Math.max(-WORLD_R - 2, Math.min(WORLD_R + 2, m.z));
      p.yaw = m.yaw;
      p.fly = !!m.f; // đang bay = quái vật không tấn công
      p.drv = !!m.d; // đang lái xe (để vẽ xe cho người khác thấy)
      return;
    }
    if (m.type === 'frozen') { // bị phạt bất động → bảo vệ khỏi quái 60 giây
      p.spawnAt = Date.now() + 52000;
      return;
    }
    if (m.type === 'block') {
      if (W.matchOver) return; // hết ván — chờ ván mới
      if (p.blockCount++ > 40) return; // chống spam (reset mỗi giây)
      if (!Number.isInteger(m.x) || !Number.isInteger(m.y) || !Number.isInteger(m.z)) return;
      if (m.x < -WORLD_R || m.x >= WORLD_R || m.z < -WORLD_R || m.z >= WORLD_R) return;
      if (m.y < 1 || m.y >= WORLD_H) return; // y=0 là đá gốc, không sửa được
      const t = m.t | 0;
      // 🧱 Mã khối được phép ĐẶT.
      //   1–10  khối cơ bản (cỏ, đất, đá, gỗ, lá, cát, nước, ván, gạch, kính)
      //   11    đá gốc  — CẤM, để không ai bịt đáy thế giới
      //   12–15 quặng   — CẤM, phải đào mới có, không được tự đặt ra
      //   16–24 khối trang trí worldgen dùng (sa thạch, gạch đá, đá cuội, bạch dương,
      //         thông, sỏi, đá cuội rêu) — CHO phép đặt từ giai đoạn 3
      //   25–48 bảng khối xây dựng mở rộng (len, bê tông, quartz, kính màu, băng,
      //         tuyết, đá phát sáng, khối kim cương…) — thêm ở giai đoạn 3
      // Server KHÔNG cần biết khối trông thế nào: nó chỉ lưu mã và phát lại cho
      // mọi người; hình ảnh do client quyết định. Nhưng nếu không mở khoá ở đây thì
      // người chơi đặt xong khối sẽ "bật lại" vì server không lưu và không phát đi.
      /* ═══ Mã khối được phép đặt ═══
         Trước là 48 — đúng bằng số khối đang có. Nay nâng lên 250 và CHỪA SẴN dải
         mã, để lần sau thêm khối xây dựng chỉ cần cập nhật Netlify, KHÔNG phải sửa
         và deploy lại server nữa (mỗi lần deploy là một lần bạn phải làm tay).
         Server không cần biết khối trông thế nào — nó chỉ lưu con số rồi phát lại.
         Danh sách CẤM thì vẫn phải giữ nguyên ý nghĩa:
           11        = đá gốc (lớp đáy thế giới, cho đặt thì bịt hoặc phá được đáy)
           12–15     = 4 loại quặng (phải ĐÀO mới có, cho đặt là quặng vô hạn)
           49–99     = chừa cho khối tương lai NHƯNG chưa có ảnh -> tạm cấm để
                       không ai đặt được khối trắng trơn rồi tưởng game lỗi */
      const T_MAX = 250;
      const T_BANNED = (t === 11) || (t >= 12 && t <= 15) || (t >= 49 && t <= 99);
      if (t < 0 || t > T_MAX || T_BANNED) return;
      const k = m.x + ',' + m.y + ',' + m.z;
      if (t === 0) { // đào: nếu khối gốc là QUẶNG thì rơi nguyên liệu
        const prev = W.edits.get(k);
        if (prev === undefined && !W.structure.has(k) && m.y <= heightAt(m.x, m.z)) {
          const ore = oreAt(m.x, m.y, m.z);
          if (ore) spawnDrop(ORE_IT[ore], m.x + .5, m.y, m.z + .5);
        }
      }
      W.edits.set(k, t);
      broadcast({ type: 'block', x: m.x, y: m.y, z: m.z, t }, id);
      return;
    }
    if (m.type === 'attack') {
      const now = Date.now();
      if (now - p.lastAtk < 190) return;
      p.lastAtk = now;
      const mob = W.mobs.get(m.id | 0);
      if (!mob) { if (process.env.DEBUG) console.log('atk: no mob', m.id); return; }
      const w = m.w | 0; // 0 tay/cuốc, 1 kiếm, 2 tên, 3 thước kẻ, 4 compa, 5 kiếm lửa, 6 kiếm băng, 7 cung sấm, 8 kiếm sắt, 9 kiếm vàng, 10 cung hồng ngọc
      const DMG = { 0: 2, 1: 8, 2: 6, 3: 14, 4: 10, 5: 16, 6: 14, 7: 14, 8: 18, 9: 22, 10: 18 };
      if (DMG[w] === undefined) return;
      const d = Math.hypot(mob.x - p.x, mob.z - p.z);
      if (d > ((w === 2 || w === 4 || w === 7 || w === 10) ? 32 : 6.5)) { if (process.env.DEBUG) console.log('atk: too far', d.toFixed(1)); return; }
      mob.hp -= DMG[w];
      if (w === 6) mob.ai.slowT = 2.5; // Kiếm Băng làm chậm
      broadcast({ type: 'mobhurt', id: mob.id });
      if (mob.hp <= 0) { mobDeath(mob); return; }
      // đẩy lùi + bỏ chạy (động vật)
      const dx = (mob.x - p.x) / (d || 1), dz = (mob.z - p.z) / (d || 1);
      if (mob.tc !== 7) {
        mob.x = Math.max(-WORLD_R + 1, Math.min(WORLD_R - 2, mob.x + dx * 1.3));
        mob.z = Math.max(-WORLD_R + 1, Math.min(WORLD_R - 2, mob.z + dz * 1.3));
        mob.y = topAt(Math.floor(mob.x), Math.floor(mob.z)) + 1;
      }
      if (mob.tc !== 5 && mob.tc !== 6) { mob.ai.fleeT = 3; mob.ai.dx = dx; mob.ai.dz = dz; }
      return;
    }
    if (m.type === 'respawn') {
      p.hp = 20; p.spawnAt = Date.now();
      if (p.ws.readyState === 1) p.ws.send(enc({ type: 'hp', hp: 20 }));
      return;
    }
    if (m.type === 'arrow') {
      if (p.arrowCount === undefined) p.arrowCount = 0;
      if (p.arrowCount++ > 6) return;
      if (!isNum(m.x) || !isNum(m.y) || !isNum(m.z) || !isNum(m.dx) || !isNum(m.dy) || !isNum(m.dz)) return;
      broadcast({ type: 'arrow', x: m.x, y: m.y, z: m.z, dx: m.dx, dy: m.dy, dz: m.dz }, id);
      return;
    }
    if (m.type === 'gear') {
      p.armor = !!m.armor;
      return;
    }
    if (m.type === 'caught') { // 📣 học sinh bị cô/bác/mẹ tóm — báo toàn server
      const k = m.k === 'teacher' ? 'teacher' : 'guard';
      const t = Math.max(0, Math.min(4, m.t | 0));
      if (!p.caughtCd || Date.now() - p.caughtCd > 5000) { // chống spam
        p.caughtCd = Date.now();
        statOf(p).caught++;
        broadcast({ type: 'caught', id, k, t }, id);
        broadcastAll(boardMsg());
      }
      return;
    }
    if (m.type === 'stat') { // 🏆 thống kê Bảng Vàng: esc = thoát truy đuổi, ans = số câu đúng
      const now = Date.now();
      if (m.k === 'esc') {
        if (!p.escCd || now - p.escCd > 8000) { p.escCd = now; statOf(p).esc++; broadcastAll(boardMsg()); }
      } else if (m.k === 'ans') {
        const n = Math.max(1, Math.min(10, m.n | 0));
        if (!p.ansCd || now - p.ansCd > 2000) { p.ansCd = now; statOf(p).ans += n; broadcastAll(boardMsg()); }
      }
      return;
    }
    if (m.type === 'skin') { // ngoại hình chibi + pet
      if (m.app && typeof m.app === 'object') {
        const a = {};
        for (const k of ['sk','hr','hc','sh','pa','ht','pet','st']) a[k] = Math.max(0, Math.min(12, m.app[k] | 0));
        p.app = a;
        broadcast({ type: 'skin', id, app: a }, id);
      }
      return;
    }
    if (m.type === 'starve') { // 🍗 đói lả — mất máu từ từ
      const now2 = Date.now();
      if (p.hp > 0 && (!p.starveCd || now2 - p.starveCd > 2400)) {
        p.starveCd = now2;
        p.hp = Math.max(0, p.hp - 1);
        try { ws.send(JSON.stringify({ type: 'hurt', hp: p.hp })); } catch (e) {}
      }
      return;
    }
    if (m.type === 'heal') {
      const n = m.n | 0;
      if (n < 1 || n > 20) return;
      if (p.hp > 0 && p.hp < 20) {
        p.hp = Math.min(20, p.hp + n);
        if (p.ws.readyState === 1) p.ws.send(enc({ type: 'hp', hp: p.hp }));
      }
      return;
    }
    if (m.type === 'chat') {
      if (p.chatCount++ > 3) return;
      const text = String(m.text || '').slice(0, 120).trim();
      if (!text) return;
      broadcast({ type: 'chat', name: p.name, text }, id);
      return;
    }
  });

  ws.on('close', () => {
    players.delete(id);
    if (saidHello) {
      useWorld(p.map);              // ⭐ CỬA VÀO 3: 'leave' chỉ gửi trong bản đồ đó
      broadcast({ type: 'leave', id });
      pushCounts();
      console.log(`[-] ${p.name} (#${id}) rời ${p.map} — ${players.size}/${MAX_PLAYERS}`);
    }
  });
  ws.on('error', () => {});
});

// Mô phỏng mob + gửi vị trí 10 lần/giây
const r2 = v => Math.round(v * 100) / 100;
setInterval(() => {
  if (players.size === 0) return;
  /* ⭐ CỬA VÀO 2: quét từng thế giới. Bản đồ không có ai thì BỎ QUA hẳn — quan
     trọng với gói Render Free: nếu vẫn mô phỏng quái ở bản đồ trống thì tốn CPU
     gấp đôi mà không ai thấy. */
  for (const id in WORLDS) {
    useWorld(id);
    if (wcount() === 0) continue;
    mobTick(0.1);
    broadcast({ type: 'pos', p: wplayers().map(p => [p.id, p.x, p.y, p.z, p.yaw, p.drv ? 1 : 0, p.fly ? 1 : 0]) });
    broadcast({ type: 'mobs', m: [...W.mobs.values()].map(m => [m.id, m.tc, r2(m.x), r2(m.y), r2(m.z), r2(m.yaw)]) });
  }
}, 100);

// Reset bộ đếm chống spam + hồi máu
setInterval(() => {
  /* chống spam & hồi máu áp dụng cho MỌI người, không phân biệt bản đồ */
  for (const p of players.values()) { p.blockCount = 0; p.chatCount = 0; p.arrowCount = 0; }
}, 1000);
setInterval(() => {
  for (const p of players.values()) {
    if (p.hp > 0 && p.hp < 20) {
      p.hp++;
      if (p.ws.readyState === 1) p.ws.send(enc({ type: 'hp', hp: p.hp }));
    }
  }
}, 3000);

/* ═══════════ 🏗️ DỰNG TỪNG THẾ GIỚI LÚC KHỞI ĐỘNG ═══════════
   Sân trường: công trình do buildStructure() dựng bằng code (như trước).
   Làng: 97.860 khối đọc từ public/maps/village.json — CÙNG file mà client tải, nên
   hai bên không thể lệch nhau. Không có file thì server vẫn chạy, chỉ là quái vật
   đi xuyên nhà (server không biết nhà ở đâu) — không làm người chơi rơi, vì va chạm
   do client tính. */
function loadVillage() {
  const f = path.join(__dirname, 'public', 'maps', 'village.json');
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const w = WORLDS.village;
    w.pads = d.pads || [];
    let n = 0;
    for (const t in d.b) {
      const a = d.b[t], tt = t | 0;
      for (let i = 0; i < a.length; i += 3) { w.structure.set(a[i] + ',' + a[i + 1] + ',' + a[i + 2], tt); n++; }
    }
    console.log('🏘️  Làng Khởi Đầu: ' + n + ' khối, ' + w.pads.length + ' vùng san nền');
  } catch (e) {
    console.log('⚠️  Không đọc được public/maps/village.json (' + e.code + ') — bản đồ Làng vẫn chơi được, nhưng quái vật sẽ đi xuyên nhà.');
  }
}
loadVillage();
for (const id in WORLDS) { useWorld(id); spawnStones(); for (let i = 0; i < 22; i++) spawnAnimal(); for (let i = 0; i < 14; i++) spawnFish(); }
useWorld('campus');
server.listen(PORT, () => {
  console.log('==========================================');
  console.log('  KhốiCraft Online — máy chủ đã sẵn sàng!');
  console.log(`  Mở trình duyệt:  http://localhost:${PORT}`);
  console.log(`  Tối đa ${MAX_PLAYERS} người chơi · Seed: ${SEED}`);
  console.log('==========================================');
});
