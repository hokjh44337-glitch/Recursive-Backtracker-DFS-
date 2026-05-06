/* ═══════════════════════════════════════════════════════════════
   MAZE ESCAPE — script.js
   완성형 미로 탈출 게임
   ─ Recursive Backtracker 미로 생성
   ─ 팩맨 스타일 몬스터 (입 벌리기 애니메이션)
   ─ 난이도별 AI (배회 / 시야 추격 / 전체 알림 추격)
   ─ Canvas 풀 렌더링 + 네온 그래픽
   ─ 키보드 / 모바일 D-pad 지원
═══════════════════════════════════════════════════════════════ */
'use strict';

/* ══════════════════════════
   1. DOM 참조
══════════════════════════ */
const canvas        = document.getElementById('gameCanvas');
const ctx           = canvas.getContext('2d');
const menuScreen    = document.getElementById('menuScreen');
const clearScreen   = document.getElementById('clearScreen');
const deadScreen    = document.getElementById('deadScreen');
const pauseOverlay  = document.getElementById('pauseOverlay');
const hud           = document.getElementById('hud');
const dpad          = document.getElementById('dpad');
const pauseBtn      = document.getElementById('pauseBtn');
const hudTime       = document.getElementById('hudTime');
const hudBest       = document.getElementById('hudBest');
const alertBanner   = document.getElementById('alertBanner');
const diffBadge     = document.getElementById('diffBadge');
const menuBest      = document.getElementById('menuBest');

/* ══════════════════════════
   2. 난이도 설정
══════════════════════════ */
const DIFFICULTY = {
  easy: {
    label: 'EASY',
    color: '#00ff88',
    cols: 11, rows: 11,
    monsterCount: [2, 3],      // [min, max]
    monsterSpeed: 1.8,         // 셀/초
    aiMode: 'wander',          // 배회만
    chaseTime: 0,
    visionRange: 0,
    alertAll: false,
  },
  normal: {
    label: 'NORMAL',
    color: '#00cfff',
    cols: 17, rows: 17,
    monsterCount: [4, 5],
    monsterSpeed: 2.2,
    aiMode: 'chase',           // 시야 내 추격
    chaseTime: 7,              // 초
    visionRange: 5,            // 셀
    alertAll: false,
  },
  hard: {
    label: 'HARD',
    color: '#ff2255',
    cols: 23, rows: 23,
    monsterCount: [5, 6],
    monsterSpeed: 2.8,
    aiMode: 'alert',           // 한 마리 발견 → 전체 추격
    chaseTime: 9.5,
    visionRange: 6,
    alertAll: true,
  },
};

let currentDiff = 'normal';
let diffCfg     = DIFFICULTY[currentDiff];

/* ══════════════════════════
   3. 사운드 (Web Audio API)
══════════════════════════ */
let ac = null;
function ensureAudio() {
  if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
  if (ac.state === 'suspended') ac.resume();
}
function playTone(freq, type, dur, vol = 0.2, freqEnd = null) {
  try {
    ensureAudio();
    const o = ac.createOscillator(), g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.type = type; o.frequency.value = freq;
    if (freqEnd !== null) o.frequency.linearRampToValueAtTime(freqEnd, ac.currentTime + dur);
    g.gain.setValueAtTime(vol, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    o.start(); o.stop(ac.currentTime + dur);
  } catch(e){}
}
const SFX = {
  move()     { playTone(120, 'sine',    .06, .08); },
  coin()     { playTone(880, 'sine',    .07, .15); setTimeout(()=>playTone(1100,'sine',.07,.12),65); },
  die()      { [300,220,150,80].forEach((f,i)=>setTimeout(()=>playTone(f,'sawtooth',.25,.35),i*100)); },
  clear()    { [523,659,784,1047].forEach((f,i)=>setTimeout(()=>playTone(f,'sine',.3,.25),i*80)); },
  chase()    { playTone(200, 'sawtooth',.15,.2,100); },
  step()     { playTone(60,  'sine',    .04,.05); },
};

/* ══════════════════════════
   4. 화면 크기 / 셀 크기
══════════════════════════ */
let W = 0, H = 0, CELL = 0;
let MAZE_OFFSET_X = 0, MAZE_OFFSET_Y = 0;

function resize() {
  W = canvas.width  = window.innerWidth;
  H = canvas.height = window.innerHeight;
  if (gameState !== 'play') return;
  calcLayout();
}
window.addEventListener('resize', resize);

function calcLayout() {
  const { cols, rows } = diffCfg;
  const hudH   = 56;
  const margin = 8;
  const maxW   = W - margin * 2;
  const maxH   = H - hudH - margin * 2;
  CELL = Math.floor(Math.min(maxW / cols, maxH / rows));
  CELL = Math.max(CELL, 14);
  MAZE_OFFSET_X = Math.floor((W - CELL * cols) / 2);
  MAZE_OFFSET_Y = Math.floor((H - CELL * rows) / 2) + 10;
}

/* ══════════════════════════
   5. 미로 생성 (Recursive Backtracker DFS)
   
   셀 구조: 각 셀마다 4방향 벽 존재 여부 저장
   0:상 1:우 2:하 3:좌
══════════════════════════ */
// 전역 미로 배열: maze[row][col] = {walls:[T,T,T,T], visited:bool}
let maze = [];
let COLS = 0, ROWS = 0;
let exitCell = { row: 0, col: 0 };

const DIR = [
  { dr: -1, dc:  0, wall: 0, opp: 2 }, // 상
  { dr:  0, dc:  1, wall: 1, opp: 3 }, // 우
  { dr:  1, dc:  0, wall: 2, opp: 0 }, // 하
  { dr:  0, dc: -1, wall: 3, opp: 1 }, // 좌
];

function generateMaze(cols, rows) {
  COLS = cols; ROWS = rows;
  maze = [];
  for (let r = 0; r < rows; r++) {
    maze[r] = [];
    for (let c = 0; c < cols; c++) {
      maze[r][c] = { walls: [true, true, true, true], visited: false };
    }
  }
  // DFS 스택 기반 생성
  function carve(r, c) {
    maze[r][c].visited = true;
    const dirs = [...DIR].sort(() => Math.random() - .5);
    for (const d of dirs) {
      const nr = r + d.dr, nc = c + d.dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !maze[nr][nc].visited) {
        maze[r][c].walls[d.wall]  = false;
        maze[nr][nc].walls[d.opp] = false;
        carve(nr, nc);
      }
    }
  }
  const startR = Math.floor(rows / 2), startC = Math.floor(cols / 2);
  carve(startR, startC);

  // 출구: 가장자리 랜덤 선택
  const edges = [];
  for (let c = 0; c < cols; c++) { edges.push({row:0,col:c}); edges.push({row:rows-1,col:c}); }
  for (let r = 1; r < rows-1; r++) { edges.push({row:r,col:0}); edges.push({row:r,col:cols-1}); }
  exitCell = edges[Math.floor(Math.random() * edges.length)];

  // 출구 벽 뚫기
  const er = exitCell.row, ec = exitCell.col;
  if (er === 0)         maze[er][ec].walls[0] = false;
  else if (er === rows-1) maze[er][ec].walls[2] = false;
  else if (ec === 0)    maze[er][ec].walls[3] = false;
  else                  maze[er][ec].walls[1] = false;
}

/* ══════════════════════════
   6. BFS 경로 찾기 (몬스터 AI용)
══════════════════════════ */
function bfsPath(fromR, fromC, toR, toC) {
  const visited = Array.from({length: ROWS}, () => new Array(COLS).fill(false));
  const prev    = Array.from({length: ROWS}, () => new Array(COLS).fill(null));
  const queue   = [{r: fromR, c: fromC}];
  visited[fromR][fromC] = true;

  while (queue.length) {
    const {r, c} = queue.shift();
    if (r === toR && c === toC) {
      // 경로 역추적
      const path = [];
      let cur = {r, c};
      while (prev[cur.r][cur.c]) { path.unshift(cur); cur = prev[cur.r][cur.c]; }
      return path;
    }
    for (const d of DIR) {
      if (maze[r][c].walls[d.wall]) continue;
      const nr = r + d.dr, nc = c + d.dc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
      if (visited[nr][nc]) continue;
      visited[nr][nc] = true;
      prev[nr][nc] = {r, c};
      queue.push({r: nr, c: nc});
    }
  }
  return [];
}

/* 시야 확인: 몬스터 → 플레이어 직선 셀 (벽 없이 연결) */
function hasLineOfSight(mr, mc, pr, pc, range) {
  const dist = Math.abs(mr - pr) + Math.abs(mc - pc);
  if (dist > range) return false;
  // 같은 행 또는 열인 경우만 시야 처리
  if (mr !== pr && mc !== pc) return false;
  // 사이 벽 체크
  if (mr === pr) {
    const minC = Math.min(mc, pc), maxC = Math.max(mc, pc);
    for (let c = minC; c < maxC; c++) {
      if (maze[mr][c].walls[1]) return false; // 우측 벽
    }
    return true;
  } else {
    const minR = Math.min(mr, pr), maxR = Math.max(mr, pr);
    for (let r = minR; r < maxR; r++) {
      if (maze[r][mc].walls[2]) return false; // 하단 벽
    }
    return true;
  }
}

/* ══════════════════════════
   7. 게임 오브젝트
══════════════════════════ */
let player = {};
let monsters = [];
let particles = [];

function initPlayer() {
  const { cols, rows } = diffCfg;
  player = {
    row: Math.floor(rows / 2),
    col: Math.floor(cols / 2),
    x: 0, y: 0,            // 픽셀 (lerp용)
    targetX: 0, targetY: 0,
    moving: false,
    moveProgress: 0,
    moveDir: null,
    alive: true,
    // 이동 모션
    bobT: 0,
    lastMoveT: 0,
  };
  snapPlayerPos();
}

function snapPlayerPos() {
  player.x = player.targetX = cellPx(player.col);
  player.y = player.targetY = cellPy(player.row);
}

function cellPx(col) { return MAZE_OFFSET_X + col * CELL + CELL / 2; }
function cellPy(row) { return MAZE_OFFSET_Y + row * CELL + CELL / 2; }

/* ══════════════════════════
   8. 몬스터 초기화
══════════════════════════ */
const MONSTER_COLORS = ['#ff2255','#ff9900','#bf60ff','#ff60b0','#00cfff','#00ff88'];
const MONSTER_NAMES  = ['BLINKY','PINKY','INKY','CLYDE','SPEEDY','SHADOW'];

function initMonsters() {
  monsters = [];
  const { monsterCount, monsterSpeed, cols, rows } = diffCfg;
  const count = monsterCount[0] + Math.floor(Math.random() * (monsterCount[1] - monsterCount[0] + 1));

  // 플레이어 시작 셀에서 떨어진 위치에 배치
  const pR = Math.floor(rows / 2), pC = Math.floor(cols / 2);
  const corners = [
    {r:1,     c:1},
    {r:1,     c:cols-2},
    {r:rows-2,c:1},
    {r:rows-2,c:cols-2},
    {r:1,     c:Math.floor(cols/2)},
    {r:rows-2,c:Math.floor(cols/2)},
  ];

  for (let i = 0; i < count; i++) {
    const pos = corners[i % corners.length];
    monsters.push({
      row: pos.r, col: pos.c,
      x: cellPx(pos.c), y: cellPy(pos.r),
      targetX: cellPx(pos.c), targetY: cellPy(pos.r),
      moving: false,
      moveProgress: 0,
      moveDir: null,
      fromRow: pos.r, fromCol: pos.c,
      toRow:   pos.r, toCol:   pos.c,
      speed:   monsterSpeed,           // 셀/초
      color:   MONSTER_COLORS[i % MONSTER_COLORS.length],
      // 팩맨 입 애니
      mouthAngle: 0.3,
      mouthOpen:  true,
      mouthT:     i * 0.3,           // 위상 차
      // AI 상태
      aiState:    'wander',          // 'wander' | 'chase'
      chaseTimer: 0,
      wanderDir:  Math.floor(Math.random() * 4),
      wanderPath: [],
      facing:     1,                 // 0상1우2하3좌
      // 눈
      eyeAngle: Math.PI / 4,
    });
  }
}

/* ══════════════════════════
   9. 게임 상태 머신
══════════════════════════ */
let gameState   = 'menu';   // 'menu' | 'play' | 'pause' | 'clear' | 'dead'
let elapsed     = 0;        // 초
let bestTime    = {};       // {easy:0, normal:0, hard:0} — 낮을수록 좋음
let globalChase = false;    // 고급: 전체 추격 상태
let globalChaseTimer = 0;
let stepSoundT  = 0;

/* ══════════════════════════
   10. 게임 시작
══════════════════════════ */
function startGame() {
  ensureAudio();
  diffCfg = DIFFICULTY[currentDiff];

  W = canvas.width  = window.innerWidth;
  H = canvas.height = window.innerHeight;
  calcLayout();

  generateMaze(diffCfg.cols, diffCfg.rows);
  initPlayer();
  initMonsters();

  particles = [];
  elapsed = 0;
  globalChase = false;
  globalChaseTimer = 0;
  stepSoundT = 0;

  // HUD
  hud.classList.remove('hidden');
  const bd = bestTime[currentDiff];
  hudBest.textContent = bd ? formatTime(bd) : '–';
  menuBest.textContent = bd ? formatTime(bd) : '–';
  diffBadge.textContent = diffCfg.label;
  diffBadge.style.color = diffCfg.color;
  diffBadge.style.borderColor = diffCfg.color;
  alertBanner.className = 'alert-banner hidden';

  dpad.classList.remove('hidden');
  pauseBtn.classList.remove('hidden');

  // 화면 전환
  menuScreen.classList.remove('active');
  clearScreen.classList.remove('visible');
  deadScreen.classList.remove('visible');
  pauseOverlay.classList.remove('visible');

  gameState = 'play';
  lastTS = performance.now();
  if (animId) cancelAnimationFrame(animId);
  animId = requestAnimationFrame(loop);
}

function goMenu() {
  gameState = 'menu';
  cancelAnimationFrame(animId);
  hud.classList.add('hidden');
  dpad.classList.add('hidden');
  pauseBtn.classList.add('hidden');
  clearScreen.classList.remove('visible');
  deadScreen.classList.remove('visible');
  pauseOverlay.classList.remove('visible');
  menuScreen.classList.add('active');
  const bd = bestTime[currentDiff];
  menuBest.textContent = bd ? formatTime(bd) : '–';
}

/* ══════════════════════════
   11. 메인 루프
══════════════════════════ */
let animId = null;
let lastTS = 0;

function loop(ts) {
  if (gameState !== 'play') return;
  const dt = Math.min((ts - lastTS) / 1000, 0.05);
  lastTS = ts;
  elapsed += dt;

  update(dt);
  render();

  animId = requestAnimationFrame(loop);
}

/* ══════════════════════════
   12. 업데이트 로직
══════════════════════════ */
// 이동 큐
const moveQueue = [];
const MOVE_SPEED = 8.0; // 셀/초

function update(dt) {
  // 플레이어 이동
  updatePlayer(dt);
  // 몬스터 이동 + AI
  updateMonsters(dt);
  // 파티클
  updateParticles(dt);
  // 타이머 HUD
  hudTime.textContent = formatTime(elapsed);
  // 글로벌 추격 타이머
  if (globalChase) {
    globalChaseTimer -= dt;
    if (globalChaseTimer <= 0) {
      globalChase = false;
      monsters.forEach(m => { m.aiState = 'wander'; m.chaseTimer = 0; });
      showAlert('안전', 'safe');
    }
  }
  // 발걸음 소리
  stepSoundT -= dt;
  if (player.moving && stepSoundT <= 0) { SFX.step(); stepSoundT = 0.3; }
}

/* ── 플레이어 업데이트 ── */
function updatePlayer(dt) {
  if (player.moving) {
    player.moveProgress += dt * MOVE_SPEED;
    if (player.moveProgress >= 1) {
      player.row = player.toRow ?? player.row;
      player.col = player.toCol ?? player.col;
      player.x = player.targetX;
      player.y = player.targetY;
      player.moving = false;
      player.moveProgress = 0;
      checkExit();
      checkMonsterCollision();
    } else {
      const t = easeInOut(player.moveProgress);
      player.x = lerp(player.fromX, player.targetX, t);
      player.y = lerp(player.fromY, player.targetY, t);
    }
  } else if (moveQueue.length > 0) {
    const dir = moveQueue.shift();
    tryMovePlayer(dir);
  }
  player.bobT += dt * 8;
}

function tryMovePlayer(dirIdx) {
  const d = DIR[dirIdx];
  const nr = player.row + d.dr;
  const nc = player.col + d.dc;
  if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) return;
  if (maze[player.row][player.col].walls[d.wall]) return;
  // 이동 시작
  player.fromX = player.x;
  player.fromY = player.y;
  player.toRow = nr; player.toCol = nc;
  player.targetX = cellPx(nc);
  player.targetY = cellPy(nr);
  player.moving = true;
  player.moveProgress = 0;
  player.facing = dirIdx;
  SFX.move();
}

function checkExit() {
  if (player.row === exitCell.row && player.col === exitCell.col) {
    triggerClear();
  }
}

function checkMonsterCollision() {
  for (const m of monsters) {
    if (m.row === player.row && m.col === player.col) {
      triggerDead(); return;
    }
  }
}

/* ── 몬스터 업데이트 ── */
function updateMonsters(dt) {
  for (const m of monsters) {
    // 입 애니메이션
    m.mouthT += dt * 6;
    m.mouthAngle = 0.25 + Math.abs(Math.sin(m.mouthT)) * 0.35;

    // 이동
    if (m.moving) {
      m.moveProgress += dt * m.speed;
      if (m.moveProgress >= 1) {
        m.row = m.toRow;
        m.col = m.toCol;
        m.x = m.targetX;
        m.y = m.targetY;
        m.moving = false;
        m.moveProgress = 0;
        // 플레이어 충돌
        if (m.row === player.row && m.col === player.col) { triggerDead(); return; }
        // 다음 이동 예약
        decideNextMove(m);
      } else {
        const t = easeInOut(m.moveProgress);
        m.x = lerp(m.fromX, m.targetX, t);
        m.y = lerp(m.fromY, m.targetY, t);
      }
    } else {
      decideNextMove(m);
    }

    // AI 상태 판단
    updateMonsterAI(m, dt);
  }
}

function updateMonsterAI(m, dt) {
  const { aiMode, visionRange, chaseTime, alertAll } = diffCfg;
  if (aiMode === 'wander') return; // 초급: 항상 배회

  // 추격 타이머 감소
  if (m.aiState === 'chase') {
    m.chaseTimer -= dt;
    if (m.chaseTimer <= 0) {
      m.aiState = 'wander';
      m.chaseTimer = 0;
      if (!globalChase) showAlert('', '');
    }
  }

  // 글로벌 추격 모드 (고급)
  if (globalChase && m.aiState !== 'chase') {
    m.aiState = 'chase';
    m.chaseTimer = globalChaseTimer; // 남은 시간 동기화
  }

  // 시야 내 플레이어 감지
  if (m.aiState === 'wander') {
    if (hasLineOfSight(m.row, m.col, player.row, player.col, visionRange)) {
      m.aiState = 'chase';
      m.chaseTimer = chaseTime;
      SFX.chase();
      if (alertAll) {
        // 고급: 전체 몬스터 추격
        globalChase = true;
        globalChaseTimer = chaseTime;
        showAlert('⚠ 몬스터가 당신을 발견했다! 도망쳐라!', 'chase');
      } else {
        showAlert('⚠ 몬스터 추격 중!', 'chase');
      }
    }
  }
}

function decideNextMove(m) {
  const { aiMode } = diffCfg;
  if (m.aiState === 'chase' || (globalChase && aiMode !== 'wander')) {
    chaseMove(m);
  } else {
    wanderMove(m);
  }
}

/* 추격 이동: BFS 경로 따라가기 */
function chaseMove(m) {
  const path = bfsPath(m.row, m.col, player.row, player.col);
  if (path.length === 0) { wanderMove(m); return; }
  const next = path[0];
  const dr = next.r - m.row, dc = next.c - m.col;
  const dirIdx = DIR.findIndex(d => d.dr === dr && d.dc === dc);
  if (dirIdx >= 0) executeMonsterMove(m, dirIdx);
}

/* 배회: 현재 방향 유지, 막히면 랜덤 */
function wanderMove(m) {
  // 가능한 방향들
  const available = DIR.map((d,i)=>({...d,i})).filter(d =>
    !maze[m.row][m.col].walls[d.wall] &&
    m.row + d.dr >= 0 && m.row + d.dr < ROWS &&
    m.col + d.dc >= 0 && m.col + d.dc < COLS
  );
  if (available.length === 0) return;

  // 온 방향 제외 (역방향)
  const opp = DIR[m.wanderDir]?.opp;
  const preferred = available.filter(d => d.i !== opp);
  const choices = preferred.length > 0 ? preferred : available;

  // 현재 방향 유지 우선 (직진)
  const straight = choices.find(d => d.i === m.wanderDir);
  const pick = (straight && Math.random() > 0.25) ? straight : choices[Math.floor(Math.random() * choices.length)];

  m.wanderDir = pick.i;
  executeMonsterMove(m, pick.i);
}

function executeMonsterMove(m, dirIdx) {
  const d = DIR[dirIdx];
  const nr = m.row + d.dr, nc = m.col + d.dc;
  if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) return;
  if (maze[m.row][m.col].walls[d.wall]) return;
  m.fromX = m.x; m.fromY = m.y;
  m.toRow = nr;  m.toCol = nc;
  m.targetX = cellPx(nc); m.targetY = cellPy(nr);
  m.moving = true; m.moveProgress = 0;
  m.facing = dirIdx;
}

/* ══════════════════════════
   13. 파티클
══════════════════════════ */
function spawnParticles(x, y, color, count = 8) {
  for (let i = 0; i < count; i++) {
    const a = (Math.PI * 2 * i / count) + Math.random() * 0.5;
    const v = 40 + Math.random() * 80;
    particles.push({ x, y, vx: Math.cos(a)*v, vy: Math.sin(a)*v, r: 3+Math.random()*4, color, life: 1 });
  }
}
function updateParticles(dt) {
  for (let i = particles.length-1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vy += 120 * dt; p.life -= dt * 1.8;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

/* ══════════════════════════
   14. 렌더링
══════════════════════════ */
// 색상 팔레트
const C = {
  bg:          '#04080f',
  mazeBg:      '#070f1c',
  wall:        '#0e2a4a',
  wallGlow:    'rgba(0,207,255,0.55)',
  wallTop:     '#1a4a80',
  wallInner:   'rgba(0,100,180,0.2)',
  floor:       '#050d18',
  floorLine:   'rgba(0,207,255,0.04)',
  player:      '#00cfff',
  playerGlow:  'rgba(0,207,255,0.5)',
  exit:        '#00ff88',
  exitGlow:    'rgba(0,255,136,0.6)',
  coin:        '#ffe040',
};

function render() {
  ctx.clearRect(0, 0, W, H);

  // 배경
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // 미로 영역 배경
  const mw = COLS * CELL, mh = ROWS * CELL;
  ctx.fillStyle = C.mazeBg;
  ctx.fillRect(MAZE_OFFSET_X, MAZE_OFFSET_Y, mw, mh);

  // 바닥 그리드 패턴
  drawFloorPattern();

  // 출구
  drawExit();

  // 벽
  drawWalls();

  // 파티클
  drawParticles();

  // 몬스터
  for (const m of monsters) drawMonster(m);

  // 플레이어
  drawPlayer();

  // 미로 외곽 테두리
  drawMazeBorder();
}

function drawFloorPattern() {
  const mw = COLS * CELL, mh = ROWS * CELL;
  ctx.save();
  ctx.strokeStyle = C.floorLine;
  ctx.lineWidth = 0.5;
  for (let r = 0; r <= ROWS; r++) {
    ctx.beginPath();
    ctx.moveTo(MAZE_OFFSET_X, MAZE_OFFSET_Y + r * CELL);
    ctx.lineTo(MAZE_OFFSET_X + mw, MAZE_OFFSET_Y + r * CELL);
    ctx.stroke();
  }
  for (let c = 0; c <= COLS; c++) {
    ctx.beginPath();
    ctx.moveTo(MAZE_OFFSET_X + c * CELL, MAZE_OFFSET_Y);
    ctx.lineTo(MAZE_OFFSET_X + c * CELL, MAZE_OFFSET_Y + mh);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWalls() {
  const lw = Math.max(2, CELL * 0.1);
  ctx.save();
  ctx.lineCap = 'square';

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x1 = MAZE_OFFSET_X + c * CELL;
      const y1 = MAZE_OFFSET_Y + r * CELL;
      const x2 = x1 + CELL;
      const y2 = y1 + CELL;
      const walls = maze[r][c].walls;

      // 각 벽 그리기 (중복 방지: 상·좌 벽만 그리고, 하·우는 인접 셀의 상·좌)
      // 상 벽
      if (walls[0]) drawWallLine(x1, y1, x2, y1, lw);
      // 좌 벽
      if (walls[3]) drawWallLine(x1, y1, x1, y2, lw);
      // 우 벽 (오른쪽 끝 열)
      if (c === COLS-1 && walls[1]) drawWallLine(x2, y1, x2, y2, lw);
      // 하 벽 (아래쪽 끝 행)
      if (r === ROWS-1 && walls[2]) drawWallLine(x1, y2, x2, y2, lw);
    }
  }
  ctx.restore();
}

function drawWallLine(x1, y1, x2, y2, lw) {
  // 글로우 레이어
  ctx.shadowBlur  = 6;
  ctx.shadowColor = C.wallGlow;
  ctx.strokeStyle = C.wallTop;
  ctx.lineWidth   = lw;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

  // 코어 라인
  ctx.shadowBlur  = 0;
  ctx.strokeStyle = C.wallGlow;
  ctx.lineWidth   = lw * 0.4;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}

function drawMazeBorder() {
  const mw = COLS * CELL, mh = ROWS * CELL;
  ctx.save();
  ctx.strokeStyle = 'rgba(0,207,255,0.4)';
  ctx.lineWidth   = 2;
  ctx.shadowBlur  = 12;
  ctx.shadowColor = 'rgba(0,207,255,0.5)';
  ctx.strokeRect(MAZE_OFFSET_X, MAZE_OFFSET_Y, mw, mh);
  ctx.restore();
}

function drawExit() {
  const ex = MAZE_OFFSET_X + exitCell.col * CELL;
  const ey = MAZE_OFFSET_Y + exitCell.row * CELL;
  const pulse = 0.6 + Math.abs(Math.sin(elapsed * 2)) * 0.4;

  ctx.save();
  // 출구 배경 강조
  ctx.fillStyle = `rgba(0,255,136,${0.15 * pulse})`;
  ctx.fillRect(ex, ey, CELL, CELL);

  // 출구 화살표 / 별 아이콘
  const cx = ex + CELL/2, cy = ey + CELL/2;
  ctx.shadowBlur  = 16 * pulse;
  ctx.shadowColor = C.exitGlow;
  ctx.fillStyle   = `rgba(0,255,136,${pulse})`;
  ctx.font        = `${CELL * 0.55}px serif`;
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🚪', cx, cy);

  // 출구 테두리 점선
  ctx.strokeStyle = `rgba(0,255,136,${0.5 * pulse})`;
  ctx.lineWidth   = 2; ctx.setLineDash([4, 4]);
  ctx.strokeRect(ex + 2, ey + 2, CELL - 4, CELL - 4);
  ctx.setLineDash([]);
  ctx.restore();
}

/* ── 플레이어 그리기 ── */
function drawPlayer() {
  if (!player.alive) return;
  const x = player.x, y = player.y;
  const r = CELL * 0.34;

  // 이동 잔상 (bobbing)
  const bob = Math.sin(player.bobT) * (player.moving ? 2 : 0.5);

  ctx.save();
  ctx.translate(x, y + bob);

  // 외곽 글로우
  const glow = ctx.createRadialGradient(0, 0, r*0.2, 0, 0, r*2.2);
  glow.addColorStop(0,   'rgba(0,207,255,0.4)');
  glow.addColorStop(0.4, 'rgba(0,207,255,0.15)');
  glow.addColorStop(1,   'rgba(0,207,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(0, 0, r*2.2, 0, Math.PI*2); ctx.fill();

  // 플레이어 구체
  const grad = ctx.createRadialGradient(-r*0.3, -r*0.3, r*0.05, 0, 0, r);
  grad.addColorStop(0, '#80e8ff');
  grad.addColorStop(0.5, '#00cfff');
  grad.addColorStop(1, '#0060a0');
  ctx.shadowBlur  = 12;
  ctx.shadowColor = C.playerGlow;
  ctx.fillStyle   = grad;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.fill();

  // 하이라이트
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath(); ctx.arc(-r*0.28, -r*0.28, r*0.28, 0, Math.PI*2); ctx.fill();

  // 이동 방향 표시 (이동 중)
  if (player.moving) {
    const facingAngles = [-Math.PI/2, 0, Math.PI/2, Math.PI];
    const fa = facingAngles[player.facing] ?? 0;
    ctx.rotate(fa);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.moveTo(r*1.2, 0);
    ctx.lineTo(r*0.7, -r*0.3);
    ctx.lineTo(r*0.7,  r*0.3);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

/* ── 몬스터 그리기 (팩맨 스타일) ── */
function drawMonster(m) {
  const x = m.x, y = m.y;
  const r = CELL * 0.36;

  // 이동 방향 (facing angle)
  const facingAngles = [-Math.PI/2, 0, Math.PI/2, Math.PI];
  const angle = facingAngles[m.facing] ?? 0;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  // 글로우
  ctx.shadowBlur  = m.aiState === 'chase' ? 18 : 8;
  ctx.shadowColor = m.aiState === 'chase' ? '#ff2255' : m.color;

  // 몸체 (팩맨: 입 열린 원)
  const halfMouth = m.mouthAngle;
  ctx.fillStyle = m.color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, r, halfMouth, Math.PI*2 - halfMouth);
  ctx.closePath();
  ctx.fill();

  // 추격 중이면 더 밝게 깜빡
  if (m.aiState === 'chase') {
    const flash = 0.3 + Math.abs(Math.sin(elapsed * 8)) * 0.3;
    ctx.fillStyle = `rgba(255,255,255,${flash})`;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, halfMouth, Math.PI*2 - halfMouth);
    ctx.closePath();
    ctx.fill();
  }

  // 눈 (입 반대 방향에)
  ctx.rotate(-angle); // 눈은 항상 위쪽
  ctx.fillStyle = 'white';
  const eyeOffX = r * 0.25, eyeOffY = -r * 0.35;
  const eyeR = r * 0.18;
  ctx.beginPath(); ctx.arc(-eyeOffX, eyeOffY, eyeR, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( eyeOffX, eyeOffY, eyeR, 0, Math.PI*2); ctx.fill();

  // 눈동자 (플레이어 방향으로)
  const dx = player.x - m.x, dy = player.y - m.y;
  const len = Math.sqrt(dx*dx + dy*dy) || 1;
  const pupilX = (dx/len) * eyeR*0.5;
  const pupilY = (dy/len) * eyeR*0.5;
  ctx.fillStyle = m.aiState === 'chase' ? '#ff2255' : '#1a3a60';
  ctx.beginPath(); ctx.arc(-eyeOffX+pupilX, eyeOffY+pupilY, eyeR*0.5, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( eyeOffX+pupilX, eyeOffY+pupilY, eyeR*0.5, 0, Math.PI*2); ctx.fill();

  ctx.restore();

  // 추격 중: 추격 타이머 표시
  if (m.aiState === 'chase' && m.chaseTimer > 0) {
    ctx.save();
    ctx.fillStyle = '#ff2255';
    ctx.font = `bold ${Math.max(8, CELL*0.22)}px Orbitron, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.globalAlpha = 0.85;
    ctx.fillText(`${Math.ceil(m.chaseTimer)}s`, x, y - r - 4);
    ctx.restore();
  }
}

function drawParticles() {
  ctx.save();
  for (const p of particles) {
    ctx.globalAlpha = p.life;
    ctx.fillStyle   = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* ══════════════════════════
   15. 클리어 / 사망 처리
══════════════════════════ */
function triggerClear() {
  if (gameState !== 'play') return;
  gameState = 'clear';
  cancelAnimationFrame(animId);
  SFX.clear();
  spawnParticles(cellPx(exitCell.col), cellPy(exitCell.row), C.exit, 20);
  render(); // 마지막 프레임

  const t = elapsed;
  const bd = bestTime[currentDiff];
  const isNew = !bd || t < bd;
  if (isNew) bestTime[currentDiff] = t;

  document.getElementById('clearTime').textContent = formatTime(t);
  document.getElementById('clearBest').textContent = isNew ? formatTime(t) : formatTime(bd);
  const nr = document.getElementById('newRec');
  isNew ? nr.classList.remove('hidden') : nr.classList.add('hidden');

  hud.classList.add('hidden');
  dpad.classList.add('hidden');
  pauseBtn.classList.add('hidden');
  clearScreen.classList.add('visible');
}

function triggerDead() {
  if (gameState !== 'play') return;
  gameState = 'dead';
  cancelAnimationFrame(animId);
  player.alive = false;
  SFX.die();
  spawnParticles(player.x, player.y, C.player, 16);
  render();

  document.getElementById('deadTime').textContent = formatTime(elapsed);
  hud.classList.add('hidden');
  dpad.classList.add('hidden');
  pauseBtn.classList.add('hidden');
  setTimeout(() => deadScreen.classList.add('visible'), 500);
}

/* ══════════════════════════
   16. 일시정지
══════════════════════════ */
function pauseGame() {
  if (gameState !== 'play') return;
  gameState = 'pause';
  cancelAnimationFrame(animId);
  pauseOverlay.classList.add('visible');
}
function resumeGame() {
  if (gameState !== 'pause') return;
  gameState = 'play';
  pauseOverlay.classList.remove('visible');
  lastTS = performance.now();
  animId = requestAnimationFrame(loop);
}

/* ══════════════════════════
   17. 유틸리티
══════════════════════════ */
function lerp(a, b, t)     { return a + (b - a) * t; }
function easeInOut(t)      { return t < .5 ? 2*t*t : -1+(4-2*t)*t; }
function formatTime(s)     {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}

let alertTimeout = null;
function showAlert(msg, type) {
  clearTimeout(alertTimeout);
  if (!msg) { alertBanner.className = 'alert-banner hidden'; return; }
  alertBanner.textContent = msg;
  alertBanner.className = `alert-banner ${type}`;
  if (type === 'safe') {
    alertTimeout = setTimeout(() => alertBanner.className='alert-banner hidden', 2000);
  }
}

/* ══════════════════════════
   18. 입력 처리
══════════════════════════ */
const dirMap = { ArrowUp:0, ArrowRight:1, ArrowDown:2, ArrowLeft:3,
                 w:0, d:1, s:2, a:3, W:0, D:1, S:2, A:3 };

window.addEventListener('keydown', e => {
  if (gameState === 'play') {
    if (e.key in dirMap) {
      e.preventDefault();
      if (moveQueue.length < 2) moveQueue.push(dirMap[e.key]);
    }
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') pauseGame();
  } else if (gameState === 'pause') {
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') resumeGame();
  }
});

// D-pad
document.querySelectorAll('.dpad-btn').forEach(btn => {
  const push = () => {
    if (gameState !== 'play') return;
    ensureAudio();
    const dMap = { up:0, right:1, down:2, left:3 };
    const d = dMap[btn.dataset.dir];
    if (d !== undefined && moveQueue.length < 2) moveQueue.push(d);
  };
  btn.addEventListener('touchstart', push, { passive: true });
  btn.addEventListener('mousedown', push);
});

// 터치 스와이프 (캔버스)
let swipeX = 0, swipeY = 0;
canvas.addEventListener('touchstart', e => { swipeX=e.touches[0].clientX; swipeY=e.touches[0].clientY; }, {passive:true});
canvas.addEventListener('touchend', e => {
  if (gameState !== 'play') return;
  const dx = e.changedTouches[0].clientX - swipeX;
  const dy = e.changedTouches[0].clientY - swipeY;
  const ad = Math.abs(dx), ay = Math.abs(dy);
  if (ad < 12 && ay < 12) return;
  if (ad > ay) moveQueue.push(dx > 0 ? 1 : 3);
  else         moveQueue.push(dy > 0 ? 2 : 0);
}, {passive:true});

/* ══════════════════════════
   19. 버튼 이벤트
══════════════════════════ */
// 난이도 카드 선택
document.querySelectorAll('.diff-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.diff-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    currentDiff = card.dataset.diff;
  });
});

document.getElementById('startBtn').addEventListener('click', startGame);
document.getElementById('retryBtn') ?.addEventListener('click', startGame);
document.getElementById('homeBtn')  ?.addEventListener('click', goMenu);
document.getElementById('clearRetry')?.addEventListener('click', startGame);
document.getElementById('clearMenu') ?.addEventListener('click', goMenu);
document.getElementById('deadRetry') ?.addEventListener('click', startGame);
document.getElementById('deadMenu')  ?.addEventListener('click', goMenu);
document.getElementById('resumeBtn') ?.addEventListener('click', resumeGame);
document.getElementById('quitBtn')   ?.addEventListener('click', goMenu);
pauseBtn.addEventListener('click', pauseGame);

/* ══════════════════════════
   20. 초기 화면 렌더
══════════════════════════ */
// 메뉴에서도 캔버스에 간단한 미로 미리보기 표시
(function initMenu() {
  W = canvas.width  = window.innerWidth;
  H = canvas.height = window.innerHeight;
  // 배경 미리보기 (간단한 그리드)
  ctx.fillStyle = '#04080f';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(0,207,255,0.04)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 32) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y < H; y += 32) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  // 최고기록 표시
  const bd = bestTime[currentDiff];
  menuBest.textContent = bd ? formatTime(bd) : '–';
})();
