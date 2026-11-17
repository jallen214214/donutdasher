/* Flag Dash engine v1, shared by donutdasher.com and partner league sites.
 * Steer with arrow keys / A-D, the mouse, or by dragging a finger on the field.
 * Space or the Spin button = spin move (a moment where nobody can pull your flags).
 * Extras: defender types, power-ups, sounds (made in the browser, no audio files) and badges.
 * No libraries; best score, badges and the sound setting are kept in this browser only.
 *
 * Each site sets these on the <canvas id="dash-canvas">:
 *   data-board    leaderboard name ("" = no leaderboard)
 *   data-api      leaderboard address (default /game-api.php, on the page's own site)
 *   data-endzone  word painted in the end zone (default SOCAL)
 * The score form decides what's sent: every named field in #dash-form is submitted and
 * remembered on this device as "flagdash-<field name>".
 * Do not edit a released version: copy it to flag-dash.v2.js and change that.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('dash-canvas');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var overlay = document.getElementById('dash-overlay');
  var overlayTitle = document.getElementById('dash-title');
  var overlayText = document.getElementById('dash-text');
  var playBtn = document.getElementById('dash-play');
  var spinBtn = document.getElementById('dash-spin');
  var form = document.getElementById('dash-form');
  var formMsg = document.getElementById('dash-form-msg');
  var topList = document.getElementById('dash-top');
  var emptyMsg = document.getElementById('dash-empty');
  var meBox = document.getElementById('dash-me');
  var soundBtn = document.getElementById('dash-sound');
  var badgeList = document.getElementById('dash-badges');
  var badgeCount = document.getElementById('dash-badge-count');
  var playerBox = document.getElementById('dash-player');
  var lockerBox = document.getElementById('dash-locker');
  var boardName = canvas.getAttribute('data-board') || '';
  var API = canvas.getAttribute('data-api') || '/game-api.php';
  var ENDZONE = (canvas.getAttribute('data-endzone') || 'SOCAL').toUpperCase();
  var token = null;          // signed start time for this game, from the server
  var lastGame = null;       // score of the game that just ended

  // Players who turn on "reduce motion" on their device get no screen shake, no slow-motion,
  // no flashing runner and less confetti.
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var W = 360, H = 560;      // game units; the canvas is scaled to fit
  var YD = 22;               // game units per yard
  var PY = Math.round(H * 0.74); // where the runner stays on screen
  var EDGE = 26;             // sideline margin
  var C = {
    grass1: '#2F8F3E', grass2: '#2A8338', out: '#23702F', line: 'rgba(255,255,255,0.85)',
    red: '#EB2D3C', navy: '#141E60', gold: '#FFC629', white: '#FFFFFF',
    zig: '#3D7BD9', blitz: '#F26B21', wall: '#5B2A86',
    skin: ['#F1C7A1', '#D9A06F', '#A86B43', '#7A4A2B'], hair: ['#2B1B10', '#5A3A1E', '#111111', '#C98E3B']
  };

  var scale = 1;
  function resize() {
    var r = canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.width * H / W * dpr));
    scale = canvas.width / W;
  }
  window.addEventListener('resize', resize);
  resize();

  var best = 0;
  try { best = parseInt(localStorage.getItem('flagdash-best'), 10) || 0; } catch (e) { /* storage blocked */ }
  function saveBest() {
    try { localStorage.setItem('flagdash-best', String(best)); } catch (e) { /* storage blocked */ }
  }

  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  // ---------- Game state ----------
  var st;
  function newGame() {
    st = { mode: 'play', pts: 0, tds: 0, flags: 3, drive: 1, t: 0, look: randomLook(),
           donuts: 0, dodges: 0, powers: 0, seen: {}, newBadges: [], toasts: [],
           near: 0, combo: 0, bestCombo: 0, slow: 0, shake: 0, yardsBefore: 0, passedBest: false, trailT: 0 };
    st.look.num = Math.floor(rand(1, 99));
    newDrive();
    sound('whistle');
  }
  function newDrive() {
    st.dist = 0;                      // how far the runner has gone this drive
    st.goal = 80 * YD;                // from the 20-yard line to the end zone
    st.x = W / 2; st.vx = 0; st.target = null;
    st.def = []; st.items = []; st.parts = [];
    st.spawn = 1.0; st.itemT = 1.6;
    st.inv = 1.0; st.spin = 0; st.spinCd = 0; st.td = 0; st.dying = 0;
    st.speed = Math.min(150 + st.drive * 14, 260);   // must match lb_min_seconds() in includes/leaderboard.php
    st.msg = 'Drive ' + st.drive; st.msgT = 1.4;
    st.pows = []; st.powT = rand(4, 7); st.wallCd = 2;
    st.turbo = 0; st.magnet = 0; st.clean = true;
  }
  function randomLook() {
    var i = Math.floor(Math.random() * C.skin.length);
    return { skin: C.skin[i], hair: pick(C.hair), num: Math.floor(rand(1, 99)) };
  }
  function idleState() {
    st = { mode: 'idle', pts: 0, tds: 0, flags: 3, drive: 1, t: 0, look: randomLook(),
           donuts: 0, dodges: 0, powers: 0, seen: {}, newBadges: [], toasts: [],
           near: 0, combo: 0, bestCombo: 0, slow: 0, shake: 0, yardsBefore: 0, passedBest: true, trailT: 0 };
    newDrive();
    st.msgT = 0;
    st.speed = 70;
  }

  function screenY(w) { return PY - (w - st.dist); }

  // Defender types: chaser (follows you), zig-zagger (weaves), blitzer (drive 2+, charges straight
  // at where you are), and the wall (drive 4+, a line across the field with one gap).
  var TYPE_INFO = {
    zig: { color: C.zig, intro: 'Zig-zagger!' },
    blitz: { color: C.blitz, intro: 'Blitzer!' },
    wall: { color: C.wall, intro: 'The wall!' }
  };
  function addDefender(o) {
    var base = { x: rand(EDGE + 10, W - EDGE - 10), w: st.dist + PY + 40, v: 40, sx: 80, zig: 0,
                 type: 'chaser', look: randomLook(), ph: rand(0, 6), hit: false };
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) base[k] = o[k];
    st.def.push(base);
    if (st.mode === 'play' && TYPE_INFO[base.type] && !st.seen[base.type]) {
      st.seen[base.type] = true;
      if (st.msgT <= 0.3) { st.msg = 'Watch out: ' + TYPE_INFO[base.type].intro; st.msgT = 1.4; }
    }
  }
  function spawnDefender() {
    var d = st.drive;
    var r = Math.random();
    st.wallCd -= 1;
    if (d >= 4 && st.wallCd <= 0 && r < 0.16) {
      st.wallCd = 6;
      var lanes = 5, gap = Math.floor(rand(0, lanes)), laneW = (W - 2 * EDGE) / lanes;
      for (var i = 0; i < lanes; i++) {
        if (i === gap) continue;
        addDefender({ type: 'wall', x: EDGE + laneW * (i + 0.5), v: 30 + d * 4, sx: 0 });
      }
      return;
    }
    if (d >= 2 && r < 0.14 + Math.min(d, 8) * 0.02) {
      addDefender({ type: 'blitz', x: Math.max(EDGE, Math.min(W - EDGE, st.x + rand(-25, 25))),
                    v: 150 + d * 10, sx: 0 });
      return;
    }
    if (r < 0.32) {
      addDefender({ type: 'zig', v: rand(30, 65) + d * 8, sx: 60 + d * 6,
                    zig: (Math.random() < 0.5 ? -1 : 1) * rand(80, 130) });
      return;
    }
    addDefender({ v: rand(25, 70) + d * 8, sx: Math.min(rand(60, 95) + d * 12, 175) });
  }

  // ---------- Power-ups ----------
  var POWER_INFO = {
    turbo: { label: 'Turbo!', color: C.gold },
    magnet: { label: 'Donut magnet!', color: '#E8455A' },
    flag: { label: 'Extra flag!', color: C.gold }
  };
  function spawnPower() {
    var kinds = ['turbo', 'magnet'];
    if (st.flags < 3) kinds.push('flag');
    st.pows.push({ x: rand(EDGE + 16, W - EDGE - 16), w: st.dist + PY + 30, kind: pick(kinds), got: false });
  }
  function getPower(pw) {
    pw.got = true;
    st.powers++;
    if (pw.kind === 'turbo') st.turbo = 5;
    if (pw.kind === 'magnet') st.magnet = 6;
    if (pw.kind === 'flag') st.flags = Math.min(3, st.flags + 1);
    pop(pw.x, screenY(pw.w), POWER_INFO[pw.kind].label, POWER_INFO[pw.kind].color);
    sound('power');
    if (st.powers >= 3) award('powered-up');
    checkDaily();
  }

  function closeCall(c) {
    st.near++;
    st.combo++; st.bestCombo = Math.max(st.bestCombo, st.combo);
    st.slow = reduceMotion ? 0 : 0.3;
    pop(st.x, PY - 40, st.combo > 1 ? 'Close call! x' + st.combo : 'Close call!', C.gold);
    sound('spin');
    checkDaily();
  }

  // Trail behind the runner (unlocked in the locker room)
  function emitTrail(dt) {
    var trail = myLook().trail;
    if (trail === 'none' || st.td > 0 || st.dying > 0) return;
    st.trailT -= dt;
    if (st.trailT > 0) return;
    st.trailT = 0.03;
    if (trail === 'sparkle') {
      st.parts.push({ x: st.x + rand(-8, 8), y: PY + 12, vx: rand(-20, 20), vy: st.speed * 0.9, life: 0.5, max: 0.5,
                      color: pick([C.gold, C.white, '#9FE3FF']), size: rand(2, 4), rot: rand(0, 6) });
    } else if (trail === 'fire') {
      st.parts.push({ x: st.x + rand(-6, 6), y: PY + 12, vx: rand(-15, 15), vy: st.speed * 0.8, life: 0.45, max: 0.45,
                      color: pick(['#FF4D1A', '#FF9A1A', '#FFD23F']), size: rand(4, 7), round: true });
    }
  }

  function spin() {
    if (!st || st.mode !== 'play' || st.spinCd > 0 || st.td > 0 || st.dying > 0) return;
    st.spin = 0.55; st.spinCd = 2.2;
    sound('spin');
  }

  function pop(x, y, text, color) {
    st.parts.push({ x: x, y: y, vx: 0, vy: -40, life: 1.1, max: 1.1, text: text, color: color });
  }
  function confetti(n) {
    if (reduceMotion) n = Math.round(n / 4);
    for (var i = 0; i < n; i++) {
      st.parts.push({ x: rand(0, W), y: rand(-40, 0), vx: rand(-40, 40), vy: rand(80, 200), life: rand(1.4, 2.2), max: 2.2,
        color: pick([C.red, C.white, C.gold, C.navy]), size: rand(3, 6), rot: rand(0, 6) });
    }
  }

  function flagPulled(d) {
    d.hit = true;
    st.flags--;
    st.inv = 1.4;
    st.clean = false;
    st.combo = 0;
    st.shake = reduceMotion ? 0 : 0.35;
    sound('pull');
    st.parts.push({ x: st.x + 10, y: PY, vx: rand(40, 90) * (d.x < st.x ? 1 : -1), vy: -160, life: 1, max: 1, flag: true });
    if (st.flags <= 0) {
      st.msg = 'Flag pulled!'; st.msgT = 1.2; st.dying = 1.1;
    } else {
      st.msg = 'Flag pulled!'; st.msgT = 1.0;
    }
  }

  function touchdown() {
    st.tds++; st.pts += 7; st.td = 2.2;
    st.msg = 'Touchdown! +7'; st.msgT = 2.0;
    confetti(120);
    sound('touchdown');
    award('first-td');
    if (st.tds >= 3) award('hat-trick');
    if (st.clean) award('untouchable');
    if (st.pts >= 50) award('big-game');
    checkDaily();
  }

  function gameOver() {
    st.mode = 'over';
    var isBest = st.pts > best;
    if (isBest) { best = st.pts; saveBest(); }
    overlayTitle.textContent = isBest && st.pts > 0 ? 'New best score!' : (st.tds > 0 ? 'Great run!' : 'Nice try!');
    var games = (parseInt(remember('flagdash-games'), 10) || 0) + 1;
    remember('flagdash-games', String(games));
    if (games >= 10) award('never-quit');
    checkDaily();

    // best distance, XP, donut bank
    var yardsNow = Math.floor(st.yardsBefore + st.dist / YD);
    if (yardsNow > bestYards) { bestYards = yardsNow; remember('flagdash-bestyards', String(bestYards)); }
    var xpBefore = num('flagdash-xp'), bankBefore = num('flagdash-bank');
    var gained = 10 + st.pts * 2 + st.near * 2 + st.dodges * 3 + st.bestCombo * 2;
    remember('flagdash-xp', String(xpBefore + gained));
    remember('flagdash-bank', String(bankBefore + st.donuts));
    lookCache = null;
    var lvlBefore = levelFor(xpBefore), lvlNow = levelFor(xpBefore + gained);
    var newUnlocks = unlocksBetween(bankBefore, bankBefore + st.donuts);

    var lines = [st.pts + (st.pts === 1 ? ' point' : ' points') + ' \u00b7 Best ' + best + ' \u00b7 +' + gained + ' XP'];
    if (lvlNow.name !== lvlBefore.name) { lines.push('Level up: ' + lvlNow.name + '!'); }
    if (newUnlocks.length) lines.push('Unlocked: ' + newUnlocks.join(', ') + '!');
    if (st.newBadges.length) lines.push('New ' + (st.newBadges.length === 1 ? 'badge' : 'badges') + ': ' + st.newBadges.join(', ') + '!');
    var hint = nearlyThere();
    if (hint && lines.length < 3) lines.push(hint);
    if (playSeconds >= 20 * 60 && !breakShown) { breakShown = true; lines.push('You\u2019ve played 20 minutes. Water break? \uD83D\uDCA7'); }
    overlayText.textContent = lines.join('\n');
    sound(lvlNow.name !== lvlBefore.name || newUnlocks.length ? 'badge' : 'over');
    renderPlayer();
    renderLocker();
    playBtn.textContent = 'Play again';
    lastGame = { score: st.pts, tds: st.tds, token: token, badges: st.newBadges.slice(), lines: lines.slice(1) };
    token = null;
    showForm(boardName !== '' && st.pts > 0 && lastGame.token !== null);
    showOverlay(true);
  }

  // ---------- Update ----------
  var keys = { left: false, right: false };

  function update(dt) {
    st.t += dt;
    if (st.msgT > 0) st.msgT -= dt;
    updateParts(dt);

    if (st.mode === 'play' && st.td > 0) {        // touchdown celebration
      st.td -= dt;
      if (st.td <= 0) {
        st.drive++;
        st.yardsBefore += 80;
        newDrive();
        sound('whistle');
        if (st.drive >= 5) award('iron-legs');
        checkDaily();
      }
      return;
    }
    if (st.mode === 'play' && st.dying > 0) {     // last flag pulled
      st.dying -= dt;
      if (st.dying <= 0) gameOver();
      return;
    }

    // steering
    var maxV = st.turbo > 0 ? 400 : 240;
    if (st.mode === 'play') {
      var ax = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      if (ax) { st.vx = ax * maxV; st.target = null; }
      else if (st.target !== null) { st.vx = Math.max(-maxV, Math.min(maxV, (st.target - st.x) * 9)); }
      else { st.vx *= 0.8; }
    } else {                                      // idle field behind the start screen
      st.vx = Math.sin(st.t * 0.9) * 60;
    }
    st.x = Math.max(EDGE, Math.min(W - EDGE, st.x + st.vx * dt));
    st.dist += st.speed * dt;

    if (st.inv > 0) st.inv -= dt;
    if (st.spin > 0) st.spin -= dt;
    if (st.spinCd > 0) st.spinCd -= dt;
    if (st.turbo > 0) st.turbo -= dt;
    if (st.magnet > 0) st.magnet -= dt;
    if (st.mode === 'play') {
      playSeconds += dt;
      var yardsNow = st.yardsBefore + st.dist / YD;
      if (!st.passedBest && bestYards > 0 && yardsNow > bestYards) {
        st.passedBest = true;
        pop(W / 2, PY - 70, 'NEW BEST!', C.gold);
        confetti(40);
        sound('badge');
      }
      emitTrail(dt);
    }
    for (var q = 0; q < st.toasts.length; q++) st.toasts[q].t -= dt;
    st.toasts = st.toasts.filter(function (b) { return b.t > 0; });

    // new defenders and donuts (none right before the end zone)
    st.spawn -= dt;
    if (st.spawn <= 0 && st.dist < st.goal - 6 * YD) {
      spawnDefender();
      var gap = Math.max(0.42, 1.2 - st.drive * 0.11);
      st.spawn = gap * rand(0.7, 1.3);
    }
    st.itemT -= dt;
    if (st.itemT <= 0 && st.dist < st.goal - 8 * YD) {
      st.items.push({ x: rand(EDGE + 14, W - EDGE - 14), w: st.dist + PY + 30, got: false });
      st.itemT = rand(1.8, 3.6);
    }
    if (st.mode === 'play') {
      st.powT -= dt;
      if (st.powT <= 0 && st.dist < st.goal - 10 * YD) {
        spawnPower();
        st.powT = rand(9, 14);
      }
    }
    if (st.magnet > 0) {                         // pull nearby donuts toward the runner
      for (var m = 0; m < st.items.length; m++) {
        var mi = st.items[m], my = screenY(mi.w);
        if (Math.abs(mi.x - st.x) < 170 && my > PY - 230 && my < PY + 20) {
          mi.x += (st.x - mi.x) * 5 * dt;
          mi.w += (st.dist - mi.w) * 5 * dt;
        }
      }
    }

    for (var i = 0; i < st.def.length; i++) {
      var d = st.def[i];
      var sy = screenY(d.w);
      if (!d.hit && sy < PY + 6) {                 // chase until they've passed the runner
        var dx = st.x - d.x;
        d.x += Math.max(-d.sx, Math.min(d.sx, dx * 2.2)) * dt;
      }
      if (d.zig) {
        d.x += d.zig * dt;
        if (d.x < EDGE || d.x > W - EDGE) d.zig = -d.zig;
      }
      d.x = Math.max(EDGE - 6, Math.min(W - EDGE + 6, d.x));
      d.w -= d.v * dt;
      d.ph += dt * 11;
    }

    if (st.mode === 'play') {
      for (var j = 0; j < st.def.length; j++) {
        var e = st.def[j];
        if (e.hit || e.dodged) continue;
        var ex = e.x - st.x, ey = screenY(e.w) - PY;
        if (ex * ex + ey * ey < 22 * 22) {
          if (st.spin > 0) {                       // spun right past them
            e.dodged = true;
            st.dodges++;
            st.combo++; st.bestCombo = Math.max(st.bestCombo, st.combo);
            pop(e.x, screenY(e.w) - 16, st.combo > 1 ? 'Nice spin! x' + st.combo : 'Nice spin!', C.white);
            if (st.dodges >= 3) award('spin-doctor');
            checkDaily();
          } else if (st.inv <= 0) {
            flagPulled(e);
            break;
          }
        }
      }
      // close calls: a defender went right past without pulling a flag
      for (var n = 0; n < st.def.length; n++) {
        var c = st.def[n];
        if (c.hit || c.dodged || c.passed) continue;
        var cy = screenY(c.w) - PY;
        if (Math.abs(cy) < 30) c.minD = Math.min(c.minD === undefined ? 99 : c.minD, Math.abs(c.x - st.x));
        if (cy > 26) {
          c.passed = true;
          if (c.minD !== undefined && c.minD < 40 && st.inv <= 0 && st.spin <= 0 && st.dying <= 0) closeCall(c);
        }
      }
      for (var pi = 0; pi < st.pows.length; pi++) {
        var pw = st.pows[pi];
        var px = pw.x - st.x, py = screenY(pw.w) - PY;
        if (!pw.got && px * px + py * py < 26 * 26) getPower(pw);
      }
      for (var k = 0; k < st.items.length; k++) {
        var it = st.items[k];
        var ix = it.x - st.x, iy = screenY(it.w) - PY;
        if (!it.got && ix * ix + iy * iy < 24 * 24) {
          it.got = true; st.pts += 1; st.donuts++;
          pop(it.x, screenY(it.w), '+1 donut', C.gold);
          sound('crunch');
          if (st.donuts >= 10) award('donut-master');
          if (st.pts >= 50) award('big-game');
          checkDaily();
        }
      }
      if (st.dist >= st.goal) touchdown();
    } else if (st.dist >= st.goal) {
      st.dist = 0; st.def = []; st.items = [];
    }

    st.def = st.def.filter(function (d) { return screenY(d.w) < H + 40; });
    st.items = st.items.filter(function (it) { return !it.got && screenY(it.w) < H + 30; });
    if (st.pows) st.pows = st.pows.filter(function (pw) { return !pw.got && screenY(pw.w) < H + 30; });
  }

  function updateParts(dt) {
    for (var i = 0; i < st.parts.length; i++) {
      var p = st.parts[i];
      p.life -= dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.flag) p.vy += 420 * dt;
      if (p.rot !== undefined) p.rot += dt * 6;
    }
    st.parts = st.parts.filter(function (p) { return p.life > 0; });
  }

  // ---------- Drawing ----------
  function font(size, weight) {
    return (weight || 900) + ' ' + size + 'px "Barlow Condensed", "Arial Narrow", sans-serif';
  }

  function drawField() {
    ctx.fillStyle = C.out;
    ctx.fillRect(0, 0, W, H);

    var topW = st.dist + PY, botW = st.dist - (H - PY);
    // 5-yard stripes
    var first = Math.floor(botW / (5 * YD)) - 1, last = Math.ceil(topW / (5 * YD)) + 1;
    for (var b = first; b <= last; b++) {
      var y1 = screenY((b + 1) * 5 * YD), y2 = screenY(b * 5 * YD);
      ctx.fillStyle = (b % 2 === 0) ? C.grass1 : C.grass2;
      ctx.fillRect(12, y1, W - 24, y2 - y1);
    }
    // end zone
    var gz = screenY(st.goal), gzTop = screenY(st.goal + 10 * YD);
    if (gz > -10) {
      ctx.fillStyle = C.red;
      ctx.fillRect(12, gzTop, W - 24, gz - gzTop);
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      var ezSize = 56;
      ctx.font = font(ezSize);
      while (ezSize > 24 && ctx.measureText(ENDZONE).width > W - 60) { ezSize -= 2; ctx.font = font(ezSize); }
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ENDZONE, W / 2, (gz + gzTop) / 2);
      ctx.restore();
    }
    // yard lines and numbers (drive starts on your own 20)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var yd = 0; yd <= 80; yd += 5) {
      var w = yd * YD, sy = screenY(w);
      if (sy < -20 || sy > H + 20) continue;
      ctx.fillStyle = C.line;
      ctx.fillRect(12, sy - (yd === 80 ? 2 : 1), W - 24, yd === 80 ? 4 : 2);
      var fieldYd = 20 + yd;
      if (fieldYd % 10 === 0 && fieldYd < 100) {
        var label = String(fieldYd <= 50 ? fieldYd : 100 - fieldYd);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = font(20, 800);
        ctx.fillText(label, 36, sy + 14);
        ctx.fillText(label, W - 36, sy + 14);
      }
    }
    // "your best" marker
    if (st.mode === 'play' && !st.passedBest && bestYards > 0) {
      var bw = (bestYards - st.yardsBefore) * YD, by = screenY(bw);
      if (bw > 0 && by > 40 && by < H) {
        ctx.save();
        ctx.strokeStyle = C.gold; ctx.lineWidth = 3; ctx.setLineDash([10, 7]);
        ctx.beginPath(); ctx.moveTo(14, by); ctx.lineTo(W - 14, by); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = font(14, 800); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = C.gold; ctx.fillText('YOUR BEST', W / 2, by - 4);
        ctx.restore();
      }
    }
    // sidelines
    ctx.fillStyle = C.white;
    ctx.fillRect(10, 0, 3, H);
    ctx.fillRect(W - 13, 0, 3, H);
  }

  function drawPlayer(x, y, jersey, look, phase, opts) {
    opts = opts || {};
    ctx.save();
    ctx.translate(x, y);
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.ellipse(2, 6, 14, 8, 0, 0, Math.PI * 2); ctx.fill();
    if (opts.rot) ctx.rotate(opts.rot);
    // legs
    var stride = Math.sin(phase) * 6;
    ctx.fillStyle = '#1B1B1B';
    ctx.beginPath(); ctx.ellipse(-5, 6 + stride, 3.5, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(5, 6 - stride, 3.5, 5, 0, 0, Math.PI * 2); ctx.fill();
    // arms (defenders reach toward the runner)
    ctx.fillStyle = look.skin;
    var reach = opts.reach || 0;
    ctx.beginPath(); ctx.ellipse(-12 - reach * 0.3, -2 - stride * 0.5 + reach, 3.5, 6 + reach * 0.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(12 + reach * 0.3, -2 + stride * 0.5 + reach, 3.5, 6 + reach * 0.4, 0, 0, Math.PI * 2); ctx.fill();
    // flags on the belt
    if (opts.flags) {
      var sway = Math.sin(phase * 0.8) * 3;
      ctx.fillStyle = C.gold;
      ctx.fillRect(-15, 2, 5, 12 + sway);
      ctx.fillRect(10, 2, 5, 12 - sway);
    }
    // jersey
    ctx.fillStyle = jersey;
    ctx.beginPath(); ctx.ellipse(0, 0, 11, 9.5, 0, 0, Math.PI * 2); ctx.fill();
    if (opts.stripe) { ctx.fillStyle = opts.stripe; ctx.fillRect(-11, -2, 22, 3); }
    ctx.fillStyle = opts.numColor || C.white;
    ctx.font = font(10, 800);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(look.num), 0, 2);
    // head
    ctx.fillStyle = look.skin;
    ctx.beginPath(); ctx.arc(0, -9, 6.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = look.hair;
    ctx.beginPath(); ctx.arc(0, -10.5, 6.5, Math.PI, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawDonut(x, y) {
    var bob = Math.sin(st.t * 4 + x) * 2;
    ctx.save();
    ctx.translate(x, y + bob);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(1, 9, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#D39A55';
    ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#F7A8C4';
    ctx.beginPath(); ctx.arc(0, -1, 9, 0, Math.PI * 2); ctx.fill();
    var sprinkles = ['#FFFFFF', '#2B6CD6', '#FFC629', '#4CC26A'];
    for (var i = 0; i < 6; i++) {
      var a = i * 1.05 + 0.4;
      ctx.fillStyle = sprinkles[i % 4];
      ctx.fillRect(Math.cos(a) * 6 - 1, Math.sin(a) * 6 - 2, 2, 3.5);
    }
    ctx.fillStyle = C.grass2;
    ctx.beginPath(); ctx.arc(0, -1, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawPower(pw) {
    var y = screenY(pw.w) + Math.sin(st.t * 5 + pw.x) * 2;
    var pulse = 1 + Math.sin(st.t * 8) * 0.08;
    ctx.save();
    ctx.translate(pw.x, y);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.arc(0, 0, 17 * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = pw.kind === 'magnet' ? '#FFFFFF' : C.navy;
    ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.fill();
    if (pw.kind === 'turbo') {                    // lightning bolt
      ctx.fillStyle = C.gold;
      ctx.beginPath();
      ctx.moveTo(2, -10); ctx.lineTo(-6, 2); ctx.lineTo(-1, 2); ctx.lineTo(-3, 10); ctx.lineTo(6, -3); ctx.lineTo(1, -3); ctx.closePath();
      ctx.fill();
    } else if (pw.kind === 'magnet') {            // horseshoe magnet
      ctx.lineWidth = 5; ctx.strokeStyle = '#E8455A';
      ctx.beginPath(); ctx.arc(0, -1, 6, Math.PI, 0, true); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-6, -1); ctx.lineTo(-6, -7); ctx.moveTo(6, -1); ctx.lineTo(6, -7); ctx.stroke();
      ctx.strokeStyle = '#C9CDD6';
      ctx.beginPath(); ctx.moveTo(-6, -7); ctx.lineTo(-6, -10); ctx.moveTo(6, -7); ctx.lineTo(6, -10); ctx.stroke();
    } else {                                      // flag on a little pole
      ctx.fillStyle = C.white; ctx.fillRect(-5, -9, 2, 18);
      ctx.fillStyle = C.gold; ctx.fillRect(-3, -9, 10, 8);
    }
    ctx.restore();
  }

  function drawFlagIcon(x, y, on) {
    ctx.fillStyle = on ? C.gold : 'rgba(255,255,255,0.25)';
    ctx.fillRect(x, y, 6, 16);
  }

  function drawHud() {
    ctx.fillStyle = 'rgba(20,30,96,0.88)';
    ctx.fillRect(0, 0, W, 38);
    ctx.textBaseline = 'middle';
    ctx.font = font(20);
    ctx.fillStyle = C.white;
    ctx.textAlign = 'left';
    ctx.fillText('PTS ' + st.pts, 12, 20);
    ctx.textAlign = 'center';
    var togo = Math.max(0, Math.ceil((st.goal - st.dist) / YD));
    ctx.font = font(16, 800);
    ctx.fillStyle = '#FFA0A7';
    ctx.fillText(st.td > 0 ? 'TOUCHDOWN' : togo + ' YDS TO GO', W / 2, 20);
    for (var i = 0; i < 3; i++) drawFlagIcon(W - 24 - i * 12, 11, i < st.flags);
    ctx.textAlign = 'right';
    ctx.font = font(14, 800);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('FLAGS', W - 64, 20);
    if (st.combo >= 2 && st.mode === 'play') {
      ctx.save();
      ctx.font = font(18); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 4; ctx.strokeStyle = C.navy; ctx.fillStyle = C.gold;
      ctx.strokeText('COMBO x' + st.combo, W - 10, 56); ctx.fillText('COMBO x' + st.combo, W - 10, 56);
      ctx.restore();
    }
    // active power-ups, under the bar
    var tags = [];
    if (st.turbo > 0) tags.push(['TURBO', st.turbo, C.gold]);
    if (st.magnet > 0) tags.push(['MAGNET', st.magnet, '#FF8A9B']);
    for (var t = 0; t < tags.length; t++) {
      ctx.fillStyle = 'rgba(20,30,96,0.8)';
      ctx.fillRect(8, 44 + t * 24, 92, 20);
      ctx.fillStyle = tags[t][2];
      ctx.fillRect(8, 44 + t * 24, 92 * Math.min(1, tags[t][1] / 6), 3);
      ctx.font = font(14, 800); ctx.textAlign = 'left';
      ctx.fillText(tags[t][0] + ' ' + Math.ceil(tags[t][1]), 14, 55 + t * 24);
    }
  }

  function drawToasts() {
    for (var i = 0; i < st.toasts.length; i++) {
      var b = st.toasts[i];
      var a = Math.min(1, b.t * 2, (3 - b.t) * 4);
      var y = H - 70 - i * 52;
      ctx.save();
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = 'rgba(20,30,96,0.92)';
      ctx.fillRect(30, y, W - 60, 44);
      ctx.fillStyle = C.gold; ctx.fillRect(30, y, 5, 44);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = '24px sans-serif';
      ctx.fillText(b.icon, 44, y + 23);
      ctx.fillStyle = C.gold; ctx.font = font(13, 800);
      ctx.fillText(b.label || 'BADGE UNLOCKED', 80, y + 14);
      ctx.fillStyle = C.white; ctx.font = font(20);
      ctx.fillText(b.name.toUpperCase(), 80, y + 31);
      ctx.restore();
    }
  }

  function drawParts() {
    for (var i = 0; i < st.parts.length; i++) {
      var p = st.parts[i];
      var a = Math.max(0, Math.min(1, p.life / (p.max * 0.5)));
      ctx.save();
      ctx.globalAlpha = a;
      if (p.text) {
        ctx.font = font(18);
        ctx.textAlign = 'center';
        ctx.fillStyle = p.color;
        ctx.strokeStyle = C.navy; ctx.lineWidth = 3;
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillText(p.text, p.x, p.y);
      } else if (p.flag) {
        ctx.translate(p.x, p.y);
        ctx.rotate(p.life * 8);
        ctx.fillStyle = C.gold;
        ctx.fillRect(-3, -8, 6, 16);
      } else if (p.round) {
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * Math.max(0.2, p.life / p.max), 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      }
      ctx.restore();
    }
  }

  function drawMessage() {
    if (st.mode !== 'play' || st.msgT <= 0) return;
    var a = Math.min(1, st.msgT * 2);
    ctx.save();
    ctx.globalAlpha = a;
    var text = st.msg.toUpperCase();
    var size = st.msg.indexOf('Touchdown') === 0 && !reduceMotion ? Math.round(44 * (1 + Math.sin(st.t * 12) * 0.07)) : 44;
    ctx.font = font(size);
    while (size > 22 && ctx.measureText(text).width > W - 30) { size -= 2; ctx.font = font(size); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 6; ctx.strokeStyle = C.navy;
    ctx.fillStyle = (st.msg.indexOf('Flag') === 0 || st.msg.indexOf('Watch') === 0) ? C.gold : C.white;
    ctx.strokeText(text, W / 2, H * 0.36);
    ctx.fillText(text, W / 2, H * 0.36);
    ctx.restore();
  }

  function draw() {
    var sx = 0, sy = 0;
    if (st.shake > 0) { var amt = 5 * st.shake / 0.35; sx = rand(-amt, amt); sy = rand(-amt, amt); }
    ctx.setTransform(scale, 0, 0, scale, sx * scale, sy * scale);
    drawField();
    for (var i = 0; i < st.items.length; i++) drawDonut(st.items[i].x, screenY(st.items[i].w));
    if (st.pows) for (var pp = 0; pp < st.pows.length; pp++) drawPower(st.pows[pp]);
    if (st.turbo > 0 && st.mode === 'play') {     // speed lines behind the runner
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 2;
      for (var sl = 0; sl < 4; sl++) {
        var lx = st.x - 12 + sl * 8, ly = PY + 16 + ((st.t * 300 + sl * 23) % 30);
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx, ly + 14); ctx.stroke();
      }
    }
    if (st.magnet > 0 && st.mode === 'play') {
      ctx.strokeStyle = 'rgba(255,138,155,' + (0.35 + Math.sin(st.t * 10) * 0.15) + ')'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(st.x, PY, 30 + (st.t * 40) % 20, 0, Math.PI * 2); ctx.stroke();
    }

    // defenders and runner, drawn back to front
    var list = st.def.map(function (d) { return { d: d, y: screenY(d.w) }; });
    var me = { me: true, y: PY };
    list.push(me);
    list.sort(function (a, b) { return a.y - b.y; });
    for (var j = 0; j < list.length; j++) {
      var o = list[j];
      if (o.me) {
        var blink = !reduceMotion && st.inv > 0 && st.mode === 'play' && Math.floor(st.t * 12) % 2 === 0;
        if (reduceMotion && st.inv > 0 && st.mode === 'play') ctx.globalAlpha = 0.5;   // fade instead of flashing
        if (!blink) {
          var rot = st.spin > 0 ? (1 - st.spin / 0.55) * Math.PI * 2 : 0;
          var rx = st.x, ry = PY, dance = st.td > 0 ? myLook().dance : 'none';
          if (dance === 'spin') rot = (2.2 - st.td) * 9;
          if (dance === 'jump') ry = PY - Math.abs(Math.sin(st.t * 9)) * 18;
          if (dance === 'wiggle') { rx = st.x + Math.sin(st.t * 18) * 7; rot = Math.sin(st.t * 18) * 0.35; }
          var jer = jerseyInfo();
          drawPlayer(rx, ry, jer.color, st.look, st.td > 0 ? st.t * 20 : st.t * 14,
                     { flags: st.flags > 0, rot: rot, stripe: jer.stripe, numColor: jer.light ? C.navy : C.white });
        }
        ctx.globalAlpha = 1;
      } else {
        var d = o.d;
        var near = Math.abs(o.y - PY) < 70 && Math.abs(d.x - st.x) < 70 && !d.hit;
        var jersey = TYPE_INFO[d.type] ? TYPE_INFO[d.type].color : C.navy;
        drawPlayer(d.x, o.y, jersey, d.look, d.ph, { reach: near ? -5 : 0 });
      }
    }
    if (st.spin > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(st.x, PY, 20, 0, Math.PI * 2); ctx.stroke();
    }
    drawParts();
    if (st.mode !== 'idle') drawHud();
    drawMessage();
    if (st.toasts) drawToasts();
  }

  // ---------- Loop ----------
  var last = 0;
  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    if (st.shake > 0) st.shake -= dt;
    if (st.slow > 0) { st.slow -= dt; dt *= 0.35; }   // slow-motion moment after a close call
    if (st.mode !== 'over') update(dt);
    draw();
    updateSpinButton();
    requestAnimationFrame(frame);
  }

  function updateSpinButton() {
    if (!spinBtn) return;
    var ready = st.mode === 'play' && st.spinCd <= 0;
    spinBtn.disabled = !ready;
  }

  function showOverlay(on) {
    overlay.hidden = !on;
    if (on) playBtn.focus({ preventScroll: true });
  }

  // ---------- Controls ----------
  function toGameX(clientX) {
    var r = canvas.getBoundingClientRect();
    return (clientX - r.left) / r.width * W;
  }
  var dragging = false;
  canvas.addEventListener('pointerdown', function (e) {
    if (st.mode !== 'play') return;
    dragging = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    st.target = toGameX(e.clientX);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (st.mode !== 'play') return;
    if (dragging || e.pointerType === 'mouse') st.target = toGameX(e.clientX);
  });
  function endDrag(e) {
    dragging = false;
    if (e.pointerType !== 'mouse' && st) st.target = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && st) st.target = null; });

  // Double-tap the field = spin move
  var lastTap = 0;
  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse') return;
    var now = Date.now();
    if (now - lastTap < 280) spin();
    lastTap = now;
  });

  window.addEventListener('keydown', function (e) {
    if (st && st.mode === 'over' && !overlay.hidden && (e.key === ' ' || e.key === 'Enter')) {
      var tag = (e.target && e.target.tagName) || '';
      if (!/INPUT|SELECT|TEXTAREA|BUTTON|A/.test(tag)) { e.preventDefault(); playBtn.click(); }
      return;
    }
    if (!st || st.mode !== 'play') return;
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keys.left = true; e.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keys.right = true; e.preventDefault(); }
    else if (k === ' ' || k === 'ArrowUp' || k === 'w' || k === 'W') { spin(); e.preventDefault(); }
    else if (k === 'ArrowDown') { e.preventDefault(); }
  });
  window.addEventListener('keyup', function (e) {
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = false;
    if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = false;
  });
  window.addEventListener('blur', function () { keys.left = keys.right = false; });

  if (spinBtn) spinBtn.addEventListener('click', spin);
  playBtn.addEventListener('click', function () {
    newGame();
    showForm(false);
    showOverlay(false);
    startToken();
  });

  // ---------- Sounds (made with the Web Audio API, no files) ----------
  var audio = null;
  var muted = false;
  try { muted = localStorage.getItem('flagdash-muted') === '1'; } catch (e) { /* storage blocked */ }
  function ac() {
    if (muted) return null;
    if (!audio) {
      var A = window.AudioContext || window.webkitAudioContext;
      if (!A) return null;
      try { audio = new A(); } catch (e) { return null; }
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }
  function tone(a, freq, start, dur, type, vol, slideTo) {
    var o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, start);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g); g.connect(a.destination);
    o.start(start); o.stop(start + dur + 0.05);
    return o;
  }
  function noise(a, start, dur, vol, filterType, freq, freqTo, attack) {
    var len = Math.max(1, Math.floor(a.sampleRate * dur));
    var buf = a.createBuffer(1, len, a.sampleRate), data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    var src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf;
    f.type = filterType; f.frequency.setValueAtTime(freq, start);
    if (freqTo) f.frequency.exponentialRampToValueAtTime(freqTo, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + (attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(f); f.connect(g); g.connect(a.destination);
    src.start(start); src.stop(start + dur);
  }
  function sound(name) {
    var a = ac();
    if (!a) return;
    var t = a.currentTime + 0.01;
    try {
      if (name === 'whistle') {
        var o = tone(a, 2900, t, 0.5, 'sine', 0.12);
        var lfo = a.createOscillator(), lg = a.createGain();
        lfo.frequency.value = 32; lg.gain.value = 140;
        lfo.connect(lg); lg.connect(o.frequency); lfo.start(t); lfo.stop(t + 0.55);
      } else if (name === 'touchdown') {
        noise(a, t, 1.8, 0.22, 'bandpass', 900, 1200, 0.25);
        [523, 659, 784, 1047].forEach(function (f, i) { tone(a, f, t + i * 0.11, 0.35, 'triangle', 0.18); });
      } else if (name === 'crunch') {
        noise(a, t, 0.08, 0.25, 'highpass', 2500);
        tone(a, 900, t, 0.08, 'square', 0.05, 500);
      } else if (name === 'pull') {
        tone(a, 700, t, 0.35, 'sawtooth', 0.09, 160);
      } else if (name === 'power') {
        [660, 880, 1320].forEach(function (f, i) { tone(a, f, t + i * 0.06, 0.12, 'square', 0.06); });
      } else if (name === 'badge') {
        [1047, 1319, 1568, 2093].forEach(function (f, i) { tone(a, f, t + i * 0.09, 0.4, 'sine', 0.14); });
      } else if (name === 'spin') {
        noise(a, t, 0.28, 0.18, 'bandpass', 400, 1800, 0.05);
      } else if (name === 'over') {
        [392, 370, 349, 262].forEach(function (f, i) { tone(a, f, t + i * 0.22, i === 3 ? 0.6 : 0.22, 'triangle', 0.14); });
      }
    } catch (e) { /* audio not available */ }
  }
  function updateSoundButton() {
    if (!soundBtn) return;
    soundBtn.setAttribute('aria-pressed', muted ? 'false' : 'true');
    soundBtn.textContent = muted ? '\uD83D\uDD07 Sound off' : '\uD83D\uDD0A Sound on';
  }
  if (soundBtn) {
    soundBtn.addEventListener('click', function () {
      muted = !muted;
      try { localStorage.setItem('flagdash-muted', muted ? '1' : '0'); } catch (e) { /* storage blocked */ }
      updateSoundButton();
      if (!muted) sound('power');
    });
  }

  // ---------- Badges (kept on this device) ----------
  var BADGES = [
    { id: 'first-td', icon: '\uD83C\uDFC8', name: 'First Touchdown', desc: 'Score a touchdown.' },
    { id: 'hat-trick', icon: '\uD83C\uDFA9', name: 'Hat Trick', desc: 'Score 3 touchdowns in one game.' },
    { id: 'untouchable', icon: '\uD83D\uDEE1\uFE0F', name: 'Untouchable', desc: 'Score without losing a flag on that drive.' },
    { id: 'donut-master', icon: '\uD83C\uDF69', name: 'Donut Master', desc: 'Grab 10 donuts in one game.' },
    { id: 'spin-doctor', icon: '\uD83C\uDF00', name: 'Spin Doctor', desc: 'Spin past 3 defenders in one game.' },
    { id: 'powered-up', icon: '\u26A1', name: 'Powered Up', desc: 'Grab 3 power-ups in one game.' },
    { id: 'iron-legs', icon: '\uD83C\uDFC3', name: 'Iron Legs', desc: 'Make it to drive 5.' },
    { id: 'big-game', icon: '\u2B50', name: 'Big Game', desc: 'Score 50 points in one game.' },
    { id: 'never-quit', icon: '\uD83D\uDD01', name: 'Never Quit', desc: 'Play 10 games.' }
  ];
  var owned = {};
  try { owned = JSON.parse(localStorage.getItem('flagdash-badges') || '{}') || {}; } catch (e) { owned = {}; }
  function award(id) {
    if (owned[id] || !st || st.mode === 'idle') return;
    var badge = null;
    for (var i = 0; i < BADGES.length; i++) if (BADGES[i].id === id) badge = BADGES[i];
    if (!badge) return;
    owned[id] = Date.now();
    try { localStorage.setItem('flagdash-badges', JSON.stringify(owned)); } catch (e) { /* storage blocked */ }
    st.newBadges.push(badge.name);
    st.toasts.push({ icon: badge.icon, name: badge.name, t: 3 });
    sound('badge');
    renderBadges(id);
  }
  function renderBadges(justEarned) {
    if (!badgeList) return;
    badgeList.textContent = '';
    var count = 0;
    BADGES.forEach(function (b) {
      var has = !!owned[b.id];
      if (has) count++;
      var li = document.createElement('li');
      li.className = 'dash__badge' + (has ? ' is-earned' : '') + (b.id === justEarned ? ' is-new' : '');
      var icon = document.createElement('span'); icon.className = 'dash__badge-icon'; icon.textContent = b.icon;
      icon.setAttribute('aria-hidden', 'true');
      var text = document.createElement('span'); text.className = 'dash__badge-text';
      var name = document.createElement('strong'); name.textContent = b.name;
      var desc = document.createElement('small'); desc.textContent = has ? b.desc : 'Locked: ' + b.desc;
      text.appendChild(name); text.appendChild(desc);
      li.appendChild(icon); li.appendChild(text);
      badgeList.appendChild(li);
    });
    if (badgeCount) badgeCount.textContent = count + ' of ' + BADGES.length;
  }
  renderBadges();
  updateSoundButton();

  // ---------- Progress: levels, unlocks, daily challenge (saved on this device) ----------
  var playSeconds = 0, breakShown = false;
  function num(key) { return parseInt(remember(key), 10) || 0; }
  var bestYards = num('flagdash-bestyards');

  var LEVELS = [
    { xp: 0, name: 'Rookie' }, { xp: 150, name: 'Starter' }, { xp: 500, name: 'Captain' },
    { xp: 1200, name: 'All-Pro' }, { xp: 2500, name: 'Legend' }
  ];
  function levelFor(xp) { var l = LEVELS[0]; LEVELS.forEach(function (x) { if (xp >= x.xp) l = x; }); return l; }
  function nextLevel(xp) { for (var i = 0; i < LEVELS.length; i++) if (xp < LEVELS[i].xp) return LEVELS[i]; return null; }

  // Unlocks are earned with donuts collected across all games (nothing is spent or bought).
  var UNLOCKS = {
    jersey: [
      { id: 'red', name: 'Red', cost: 0, color: '#EB2D3C' },
      { id: 'pink', name: 'Pink', cost: 20, color: '#FF5FA2' },
      { id: 'teal', name: 'Teal', cost: 40, color: '#0FA3A3' },
      { id: 'silver', name: 'Silver', cost: 80, color: '#B8C2CC', light: true },
      { id: 'gold', name: 'Gold', cost: 150, color: '#E3B21C', light: true },
      { id: 'lightning', name: 'Lightning', cost: 300, color: '#FFFFFF', stripe: '#FFC629', light: true }
    ],
    trail: [
      { id: 'none', name: 'No trail', cost: 0 },
      { id: 'sparkle', name: 'Sparkles', cost: 60 },
      { id: 'fire', name: 'Fire', cost: 200 }
    ],
    dance: [
      { id: 'none', name: 'Classic', cost: 0 },
      { id: 'spin', name: 'Spin', cost: 30 },
      { id: 'jump', name: 'Jump', cost: 100 },
      { id: 'wiggle', name: 'Wiggle', cost: 250 }
    ]
  };
  var GROUP_NAMES = { jersey: 'Jersey', trail: 'Trail', dance: 'Touchdown dance' };
  var lookCache = null;
  function myLook() {
    if (lookCache) return lookCache;
    var saved = {};
    try { saved = JSON.parse(remember('flagdash-look') || '{}') || {}; } catch (e) { saved = {}; }
    var bank = num('flagdash-bank'), look = {};
    Object.keys(UNLOCKS).forEach(function (g) {
      var choice = UNLOCKS[g].filter(function (u) { return u.id === saved[g] && bank >= u.cost; })[0];
      look[g] = choice ? choice.id : UNLOCKS[g][0].id;
    });
    lookCache = look;
    return look;
  }
  function jerseyInfo() {
    var id = myLook().jersey;
    return UNLOCKS.jersey.filter(function (u) { return u.id === id; })[0] || UNLOCKS.jersey[0];
  }
  function unlocksBetween(before, after) {
    var names = [];
    Object.keys(UNLOCKS).forEach(function (g) {
      UNLOCKS[g].forEach(function (u) {
        if (u.cost > before && u.cost <= after) names.push(u.name + (g === 'jersey' ? ' jersey' : g === 'trail' ? ' trail' : ' dance'));
      });
    });
    return names;
  }
  function nextUnlock(bank) {
    var best = null;
    Object.keys(UNLOCKS).forEach(function (g) {
      UNLOCKS[g].forEach(function (u) {
        if (u.cost > bank && (!best || u.cost < best.cost)) best = { cost: u.cost, label: u.name + (g === 'jersey' ? ' jersey' : g === 'trail' ? ' trail' : ' dance') };
      });
    });
    return best;
  }

  // One challenge per day (Pacific time), the same for everyone. +25 donuts when done.
  var DAILY = [
    { k: 'donuts', n: 6, text: 'Grab 6 donuts in one game' },
    { k: 'tds', n: 2, text: 'Score 2 touchdowns in one game' },
    { k: 'dodges', n: 2, text: 'Spin past 2 defenders in one game' },
    { k: 'near', n: 3, text: 'Get 3 close calls in one game' },
    { k: 'powers', n: 2, text: 'Grab 2 power-ups in one game' },
    { k: 'pts', n: 25, text: 'Score 25 points in one game' },
    { k: 'drive', n: 3, text: 'Make it to drive 3' }
  ];
  var DAILY_REWARD = 25;
  function todayKey() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function todayChallenge() {
    var days = Math.floor(Date.parse(todayKey() + 'T00:00:00Z') / 86400000) || 0;
    return DAILY[((days % DAILY.length) + DAILY.length) % DAILY.length];
  }
  function dailyDone() { return remember('flagdash-daily') === todayKey(); }
  function checkDaily() {
    if (!st || st.mode === 'idle' || dailyDone()) return;
    var c = todayChallenge();
    if ((st[c.k] || 0) >= c.n) {
      remember('flagdash-daily', todayKey());
      remember('flagdash-bank', String(num('flagdash-bank') + DAILY_REWARD));
      lookCache = null;
      st.toasts.push({ icon: '\uD83C\uDFAF', label: 'DAILY CHALLENGE DONE', name: '+' + DAILY_REWARD + ' bonus donuts', t: 3 });
      st.newBadges.push('Daily challenge (+' + DAILY_REWARD + ' donuts)');
      sound('badge');
      renderPlayer();
    }
  }

  function nearlyThere() {
    if (!owned['donut-master'] && st.donuts >= 7 && st.donuts < 10) return (10 - st.donuts) + ' more donuts for Donut Master!';
    if (!owned['hat-trick'] && st.tds === 2) return '1 more touchdown for Hat Trick!';
    if (!owned['big-game'] && st.pts >= 40 && st.pts < 50) return (50 - st.pts) + ' more points for Big Game!';
    if (!owned['spin-doctor'] && st.dodges === 2) return '1 more spin for Spin Doctor!';
    var nu = nextUnlock(num('flagdash-bank'));
    if (nu && nu.cost - num('flagdash-bank') <= 15) return (nu.cost - num('flagdash-bank')) + ' more donuts to unlock ' + nu.label + '!';
    return '';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function renderPlayer() {
    if (!playerBox) return;
    var xp = num('flagdash-xp'), bank = num('flagdash-bank');
    var lvl = levelFor(xp), next = nextLevel(xp);
    playerBox.textContent = '';
    var top = el('div', 'dash__player-top');
    top.appendChild(el('p', 'dash__level', lvl.name));
    top.appendChild(el('p', 'dash__bank', '\uD83C\uDF69 ' + bank + ' donuts'));
    playerBox.appendChild(top);
    var bar = el('div', 'dash__xpbar');
    var fill = el('span');
    var pct = next ? Math.round((xp - lvl.xp) / (next.xp - lvl.xp) * 100) : 100;
    fill.style.width = Math.max(3, pct) + '%';
    bar.appendChild(fill);
    playerBox.appendChild(bar);
    playerBox.appendChild(el('p', 'dash__xptext', next ? xp + ' / ' + next.xp + ' XP to ' + next.name : xp + ' XP \u00b7 Max level!'));
    var c = todayChallenge(), done = dailyDone();
    var daily = el('div', 'dash__daily' + (done ? ' is-done' : ''));
    daily.appendChild(el('p', 'dash__daily-label', done ? '\u2705 Today\u2019s challenge: done!' : '\uD83C\uDFAF Today\u2019s challenge'));
    daily.appendChild(el('p', 'dash__daily-text', c.text + (done ? '' : ' (+' + DAILY_REWARD + ' donuts)')));
    playerBox.appendChild(daily);
  }
  function renderLocker() {
    if (!lockerBox) return;
    var bank = num('flagdash-bank'), look = myLook();
    lockerBox.textContent = '';
    var nu = nextUnlock(bank);
    if (nu) {
      lockerBox.appendChild(el('p', 'dash__next', (nu.cost - bank) + ' more donuts to unlock ' + nu.label));
      var bar = el('div', 'dash__xpbar dash__xpbar--gold');
      var prev = 0;
      Object.keys(UNLOCKS).forEach(function (g) { UNLOCKS[g].forEach(function (u) { if (u.cost <= bank && u.cost > prev) prev = u.cost; }); });
      var fill = el('span'); fill.style.width = Math.max(3, Math.round((bank - prev) / (nu.cost - prev) * 100)) + '%';
      bar.appendChild(fill); lockerBox.appendChild(bar);
    } else {
      lockerBox.appendChild(el('p', 'dash__next', 'Everything unlocked. Legend!'));
    }
    Object.keys(UNLOCKS).forEach(function (g) {
      var group = el('div', 'dash__locker-group');
      group.appendChild(el('p', 'dash__locker-title', GROUP_NAMES[g]));
      var row = el('div', 'dash__locker-row');
      UNLOCKS[g].forEach(function (u) {
        var unlocked = bank >= u.cost;
        var b = el('button', 'dash__item' + (look[g] === u.id ? ' is-on' : '') + (unlocked ? '' : ' is-locked'));
        b.type = 'button';
        b.setAttribute('aria-pressed', look[g] === u.id ? 'true' : 'false');
        if (g === 'jersey') {
          var sw = el('span', 'dash__swatch');
          sw.style.background = u.stripe ? 'linear-gradient(' + u.color + ' 40%, ' + u.stripe + ' 40%, ' + u.stripe + ' 60%, ' + u.color + ' 60%)' : u.color;
          b.appendChild(sw);
        }
        b.appendChild(el('span', 'dash__item-name', u.name));
        if (!unlocked) b.appendChild(el('span', 'dash__item-cost', '\uD83D\uDD12 ' + u.cost + ' \uD83C\uDF69'));
        b.disabled = !unlocked;
        b.addEventListener('click', function () {
          var saved = {};
          try { saved = JSON.parse(remember('flagdash-look') || '{}') || {}; } catch (e) { saved = {}; }
          saved[g] = u.id;
          remember('flagdash-look', JSON.stringify(saved));
          lookCache = null;
          renderLocker();
        });
        row.appendChild(b);
      });
      group.appendChild(row);
      lockerBox.appendChild(group);
    });
  }

  // ---------- Leaderboard ----------
  function post(data) {
    var body = new URLSearchParams();
    for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) body.append(k, data[k]);
    return fetch(API, { method: 'POST', body: body, credentials: 'same-origin' })
      .then(function (r) { return r.json(); });
  }

  function startToken() {
    token = null;
    if (!boardName || !window.fetch) return;
    var game = st;
    post({ action: 'start' }).then(function (res) {
      if (res && res.ok && st === game) token = res.token;
    }).catch(function () { /* offline: the game still works, the score just can't be added */ });
  }

  function remember(key, value) {
    try { if (value === undefined) return localStorage.getItem(key) || ''; localStorage.setItem(key, value); } catch (e) { /* storage blocked */ }
    return '';
  }

  // Named fields in the score form (league: first, initial, division, team; donutdasher.com: nickname, device).
  function formFields() {
    var out = {};
    if (!form) return out;
    Array.prototype.forEach.call(form.elements, function (el) {
      if (el.name) out[el.name] = el;
    });
    return out;
  }

  // A random id for this browser, so two players who pick the same nickname stay separate.
  function deviceId() {
    var id = remember('flagdash-device');
    if (!/^[a-f0-9]{16}$/.test(id)) {
      id = '';
      for (var i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
      remember('flagdash-device', id);
    }
    return id;
  }

  // Nicknames are built only from the word lists on the form (data-nick-words), never typed.
  var nickWords = null;
  try { nickWords = JSON.parse(form ? form.getAttribute('data-nick-words') || 'null' : 'null'); } catch (e) { nickWords = null; }
  var nickShow = document.getElementById('dash-nick');
  var nickShuffle = document.getElementById('dash-shuffle');
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
  function newNickname() {
    return pick(nickWords.a) + ' ' + pick(nickWords.b) + ' ' + (Math.floor(Math.random() * 99) + 1);
  }
  function setNickname(nick) {
    var f = formFields();
    if (!f.nickname) return;
    f.nickname.value = nick;
    if (nickShow) nickShow.textContent = nick;
  }
  if (nickShuffle && nickWords) {
    nickShuffle.addEventListener('click', function () { setNickname(newNickname()); });
  }

  function showForm(on) {
    if (!form) return;
    form.hidden = !on;
    if (!on) return;
    formMsg.textContent = '';
    form.querySelector('[type=submit]').disabled = false;
    var f = formFields();
    Object.keys(f).forEach(function (name) {
      if (name === 'device' || name === 'team' || f[name].type === 'submit' || f[name].type === 'button') return;
      f[name].value = f[name].value || remember('flagdash-' + name);
    });
    if (f.device) f.device.value = deviceId();
    if (f.nickname) setNickname(f.nickname.value || (nickWords ? newNickname() : ''));
    if (f.team) fillTeams(f.team.value || remember('flagdash-team'));
  }

  // Team list depends on the division (lists come from data/site.php).
  var teamsByDivision = {};
  try { teamsByDivision = JSON.parse(form ? form.getAttribute('data-teams') || '{}' : '{}') || {}; } catch (e) { /* none */ }
  function fillTeams(selected) {
    if (!form || !form.elements.team || !form.elements.division) return;
    var select = form.elements.team;
    var teams = teamsByDivision[form.elements.division.value] || [];
    select.textContent = '';
    var first = document.createElement('option');
    first.value = '';
    first.textContent = teams.length ? 'Pick one' : 'Pick division first';
    select.appendChild(first);
    teams.forEach(function (t) {
      var o = document.createElement('option');
      o.textContent = t;
      if (t === selected) o.selected = true;
      select.appendChild(o);
    });
    select.disabled = teams.length === 0;
  }
  if (form && form.elements.division) form.elements.division.addEventListener('change', function () { fillTeams(''); });

  // This device's own player (saved after adding a score), so only they see their name.
  function myPlayer() {
    try {
      var me = JSON.parse(remember('flagdash-me') || 'null');
      return me && me.board === boardName ? me : null;
    } catch (e) { return null; }
  }

  // Rows show a public nickname (data-label) or "Anonymous player" when names are kept private.
  function rowLabel(li) { return li.getAttribute('data-label') || 'Anonymous player'; }

  function markMine() {
    if (!topList) return;
    var me = myPlayer();
    var found = false;
    Array.prototype.forEach.call(topList.children, function (li) {
      var mine = !!me && li.getAttribute('data-id') === me.id;
      li.classList.toggle('is-you', mine);
      var name = li.querySelector('.dash__name');
      if (name && name.firstChild) name.firstChild.textContent = mine ? 'You (' + me.name + ') ' : rowLabel(li) + ' ';
      if (mine) found = true;
    });
    if (!meBox) return;
    if (!me || found) { meBox.hidden = true; return; }
    fetch(API + (API.indexOf('?') < 0 ? '?' : '&') + 'action=me&id=' + encodeURIComponent(me.id), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.me) {
          meBox.textContent = 'You (' + me.name + '): #' + res.me.rank + ' with ' + res.me.score + ' points. Keep going to reach the top 10!';
          meBox.hidden = false;
        }
      })
      .catch(function () { /* offline */ });
  }

  function renderTop(rows) {
    if (!topList) return;
    topList.textContent = '';
    rows.forEach(function (row) {
      var li = document.createElement('li');
      li.setAttribute('data-id', row.id);
      if (row.name) li.setAttribute('data-label', row.name);
      var rank = document.createElement('span'); rank.className = 'dash__rank'; rank.textContent = row.rank;
      var name = document.createElement('span'); name.className = 'dash__name';
      name.appendChild(document.createTextNode(rowLabel(li) + ' '));
      var sub = row.team ? row.team + ' · ' + row.division : (row.division || '');
      if (sub) { var div = document.createElement('small'); div.textContent = sub; name.appendChild(div); }
      var score = document.createElement('span'); score.className = 'dash__score'; score.textContent = row.score;
      li.appendChild(rank); li.appendChild(name); li.appendChild(score);
      topList.appendChild(li);
    });
    topList.hidden = rows.length === 0;
    if (emptyMsg) emptyMsg.hidden = rows.length > 0;
    markMine();
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!lastGame || !lastGame.token) return;
      var submit = form.querySelector('[type=submit]');
      var data = { action: 'submit', token: lastGame.token, score: lastGame.score, tds: lastGame.tds };
      var f = formFields();
      Object.keys(f).forEach(function (name) {
        if (f[name].type === 'submit' || f[name].type === 'button') return;
        var value = f[name].value.trim();
        data[name] = value;
        if (name !== 'device') remember('flagdash-' + name, value);
      });
      submit.disabled = true;
      formMsg.textContent = 'Saving...';
      post(data)
        .then(function (res) {
          if (res && res.ok) {
            lastGame.token = null;
            remember('flagdash-me', JSON.stringify({ id: res.id, name: res.name, board: res.board }));
            renderTop(res.top || []);
            form.hidden = true;
            overlayText.textContent = res.rank <= 10
              ? 'You’re #' + res.rank + ' on the ' + res.board + ' leaderboard!'
              : 'Saved! You’re #' + res.rank + ' on the ' + res.board + ' leaderboard. Keep going to reach the top 10!';
            if (res.pending) overlayText.textContent += ' Your name will show for everyone once a coach checks it.';
            var gap = '';
            if (res.rank === 1) gap = 'Defend your spot!';
            else (res.top || []).forEach(function (row) {
              if (row.rank === res.rank - 1) gap = Math.max(1, row.score - (res.best || lastGame.score) + 1) + ' more points to pass #' + row.rank + '!';
            });
            var extra = (lastGame.lines || []).filter(function (l) { return !/^You’re #/.test(l); });
            overlayText.textContent = [overlayText.textContent].concat(gap ? [gap] : [], extra.slice(0, 2)).join('\n');
            if (res.rank === 1) overlayTitle.textContent = 'You’re #1!';
          } else {
            formMsg.textContent = (res && res.error) || 'Something went wrong. Please try again.';
            submit.disabled = /real first name|type your|pick your|nickname/i.test(formMsg.textContent) ? false : true;
          }
        })
        .catch(function () {
          formMsg.textContent = 'Couldn’t reach the leaderboard. Check your connection and try again.';
          submit.disabled = false;
        });
    });
  }

  // Fonts can load after the first frame; nothing to wait for otherwise.
  idleState();
  renderPlayer();
  renderLocker();
  markMine();
  if (best > 0) overlayText.textContent += ' Your best: ' + best + '.';
  if (!dailyDone()) overlayText.textContent += '\n\uD83C\uDFAF Today: ' + todayChallenge().text.toLowerCase() + '.';
  requestAnimationFrame(function (t) { last = t; frame(t); });
})();
