/* ============================================================
   Geometry Web — game engine (canvas)
   Координаты мира: 1 блок = 60px, ось Y вверх, земля на y=0.
   Режимы: куб, корабль, волна. Ускорения, орбы, батуты,
   группы объектов и move-триггеры.
   ============================================================ */
(function () {
  'use strict';

  const B = 60;                 // размер блока, px
  const VIEW_W = 1280, VIEW_H = 720;
  const GROUND_SCREEN_Y = 600;  // экранная Y линии земли при camY=0

  const PHYS = {
    SPEED: 10.386 * B,          // базовая скорость, px/s
    GRAV: 5588,                 // гравитация куба, px/s^2
    JUMP_V: 1194,               // скорость прыжка, px/s
    FALL_MAX: 1560,             // макс. скорость падения
    ROT_SPEED: 415,             // вращение куба в полёте, град/с
    CLIP: 16,                   // прощение при посадке на край блока, px
    SHIP_ACC: 2900,             // ускорение корабля (вверх при удержании)
    SHIP_GRAV: 2400,            // тяга вниз у корабля
    SHIP_VMAX: 760,             // предел вертикальной скорости корабля
    ARENA_CEIL: 13 * B          // потолок арены (корабль/волна)
  };

  const SPEED_COLORS = { '0.8': '#ff9a3c', '1': '#38c9ff', '1.5': '#58e858', '2': '#ff58e0' };

  // цвета орбов в одном месте: шар, глубина градиента, искры воронки, вспышка
  const ORB_COLORS = {
    yellow: { main: '#ffe36e', deep: '#f5bc1e', spark: '#ffe89a', burst: '#ffd94d' },
    pink:   { main: '#ff9ae6', deep: '#ec74cc', spark: '#ffb8ec', burst: '#ff8ae0' },
    blue:   { main: '#5ad2ff', deep: '#1a8fd8', spark: '#a6e8ff', burst: '#5ad2ff' },
    dash:   { main: '#7dff8a', deep: '#23b53c', spark: '#b6ffbe', burst: '#4dff6a' }
  };
  const ORB_KINDS = ['yellow', 'pink', 'blue', 'dash'];
  const orbKind = (o) => (ORB_KINDS.includes(o && o.kind) ? o.kind : 'yellow');
  const ZERO_OFF = { x: 0, y: 0 };

  /* ---------- цвета ---------- */
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  }
  function lerpColor(a, b, t) {
    const ca = hexToRgb(a), cb = hexToRgb(b);
    return rgbToHex(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
  }
  function shade(hex, f) { // f<0 темнее, f>0 светлее
    const c = hexToRgb(hex);
    return rgbToHex(c[0] + (f > 0 ? (255 - c[0]) * f : c[0] * f),
                    c[1] + (f > 0 ? (255 - c[1]) * f : c[1] * f),
                    c[2] + (f > 0 ? (255 - c[2]) * f : c[2] * f));
  }

  /* ---------- простые звуки (WebAudio) ---------- */
  const Sfx = {
    ctx: null,
    volume: 1, // множитель громкости эффектов (настройки)
    ensure() {
      if (!this.ctx) {
        try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* нет звука */ }
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone(freq, dur, type, vol, when, slide) {
      if (this.volume <= 0.01) return;
      const ctx = this.ensure(); if (!ctx) return;
      const t0 = ctx.currentTime + (when || 0);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'square'; o.frequency.setValueAtTime(freq, t0);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t0 + dur);
      g.gain.setValueAtTime((vol || 0.12) * this.volume, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    },
    coin()     { this.tone(1150, 0.09, 'square', 0.09); this.tone(1720, 0.22, 'square', 0.09, 0.08); },
    complete() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.28, 'square', 0.1, i * 0.11)); },
    checkpoint() { this.tone(880, 0.12, 'sine', 0.12); }
  };

  /* ---------- иконки (кубики) ---------- */
  const Icons = {
    list: [
      { id: 0, name: 'cube1', src: 'textures/cube1.jpg' },
      { id: 1, name: 'cube2', src: 'textures/cube2.jpg' },
      { id: 2, name: 'cube3', src: 'textures/cube3.png' },
      { id: 3, name: 'cube4', src: 'textures/cube4.png' },
      // cube5 — не квадратной формы, со своей обводкой: не рисуем чёрную окантовку
      { id: 4, name: 'cube5', src: 'textures/cube5.png', noOutline: true }
    ],
    // запасные цвета, если картинки нет
    fallback: {
      0: ['#8dff2e', '#4ecf00', '#04310a'],
      1: ['#2ea8ff', '#0060cf', '#001d40']
    },
    images: {},
    load(cb) {
      let pending = this.list.length;
      if (!pending) { cb && cb(); return; }
      this.list.forEach(ic => {
        const img = new Image();
        img.onload = () => { this.images[ic.id] = img; if (--pending === 0) cb && cb(); };
        img.onerror = () => { if (--pending === 0) cb && cb(); };
        img.src = ic.src;
      });
    },
    drawFace(ctx, id, size) {
      const s = size, h = s / 2;
      const img = this.images[id];
      const ic = this.list.find(i => i.id === id);
      const noOutline = !!(ic && ic.noOutline);
      ctx.save();
      // острые углы, обводка остаётся
      ctx.beginPath();
      ctx.rect(-h, -h, s, s);
      if (img) {
        if (noOutline) {
          // некватдратная иконка со своей обводкой — рисуем как есть, без клипа и рамки
          ctx.drawImage(img, -h, -h, s, s);
        } else {
          ctx.save(); ctx.clip();
          ctx.drawImage(img, -h, -h, s, s);
          ctx.restore();
          // окантовка тоньше (форма прежняя)
          ctx.lineWidth = Math.max(1.4, s * 0.045);
          ctx.strokeStyle = '#000';
          ctx.stroke();
        }
      } else {
        const pal = this.fallback[id] || this.fallback[0];
        const g = ctx.createLinearGradient(0, -h, 0, h);
        g.addColorStop(0, pal[0]); g.addColorStop(1, pal[1]);
        ctx.fillStyle = g; ctx.fill();
        ctx.lineWidth = Math.max(2, s * 0.08);
        ctx.strokeStyle = '#000'; ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,.35)';
        ctx.lineWidth = Math.max(1.5, s * 0.045);
        ctx.strokeRect(-h * 0.62, -h * 0.62, s * 0.62, s * 0.62);
        const ew = s * 0.16, eh = s * 0.26, ey = -s * 0.10;
        ctx.fillStyle = pal[2];
        ctx.fillRect(-s * 0.24 - ew / 2, ey - eh / 2, ew, eh);
        ctx.fillRect( s * 0.24 - ew / 2, ey - eh / 2, ew, eh);
        ctx.fillStyle = '#eaffff';
        ctx.fillRect(-s * 0.24 - ew / 2 + ew * 0.15, ey - eh / 2 + eh * 0.12, ew * 0.4, eh * 0.32);
        ctx.fillRect( s * 0.24 - ew / 2 + ew * 0.15, ey - eh / 2 + eh * 0.12, ew * 0.4, eh * 0.32);
        ctx.fillStyle = pal[2];
        ctx.fillRect(-s * 0.20, s * 0.22, s * 0.40, s * 0.09);
      }
      ctx.restore();
    },
    draw(ctx, id, cx, cy, size, rotDeg) {
      ctx.save();
      ctx.translate(cx, cy);
      if (rotDeg) ctx.rotate(rotDeg * Math.PI / 180);
      this.drawFace(ctx, id, size);
      ctx.restore();
    }
  };

  /* ============================================================
     Отрисовка объектов (общая для игры и редактора).
     ctx переведён в левый-нижний угол клетки, ось Y экранная.
     ============================================================ */
  function drawBlockStyle(ctx, style) {
    // рисуем в центрированных координатах [-30..30]
    const h = B / 2;
    ctx.fillStyle = '#0e0e14';
    ctx.fillRect(-h, -h, B, B);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,.92)';
    ctx.strokeRect(-h + 1.5, -h + 1.5, B - 3, B - 3);
    if (style === 1) {
      ctx.strokeStyle = 'rgba(255,255,255,.14)';
      ctx.lineWidth = 2;
      ctx.strokeRect(-h + 7, -h + 7, B - 14, B - 14);
    } else if (style === 2) {
      // крест X
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-h + 4, -h + 4); ctx.lineTo(h - 4, h - 4);
      ctx.moveTo(h - 4, -h + 4); ctx.lineTo(-h + 4, h - 4);
      ctx.stroke();
    } else if (style === 3) {
      // шахматка
      ctx.fillStyle = 'rgba(255,255,255,.13)';
      ctx.fillRect(-h + 3, -h + 3, h - 3, h - 3);
      ctx.fillRect(0, 0, h - 3, h - 3);
    } else if (style === 4) {
      // заклёпки по углам
      ctx.fillStyle = 'rgba(255,255,255,.45)';
      [[-h + 9, -h + 9], [h - 9, -h + 9], [-h + 9, h - 9], [h - 9, h - 9]].forEach(([x, y]) => {
        ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill();
      });
      ctx.strokeStyle = 'rgba(255,255,255,.22)';
      ctx.lineWidth = 2;
      ctx.strokeRect(-h + 16, -h + 16, B - 32, B - 32);
    }
  }

  function drawCoin(ctx, opts) {
    // центрированная монета r ~ 0.42B
    const r = B * 0.42;
    const ghost = opts && opts.ghost;
    ctx.save();
    ctx.globalAlpha = ghost ? 0.35 : 1;
    if (!ghost && !(opts && opts.static)) { ctx.shadowColor = '#ffd94d'; ctx.shadowBlur = 16; }
    // тело
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
    g.addColorStop(0, '#fff3ac');
    g.addColorStop(0.45, '#ffd23d');
    g.addColorStop(1, '#e89c00');
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = ghost ? 'rgba(255,217,77,.15)' : g;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 4;
    ctx.strokeStyle = ghost ? 'rgba(255,217,77,.6)' : '#a06c00';
    ctx.stroke();
    // внутреннее кольцо с фаской
    ctx.beginPath(); ctx.arc(0, 0, r * 0.66, 0, Math.PI * 2);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = ghost ? 'rgba(255,217,77,.5)' : 'rgba(160,108,0,.9)';
    ctx.stroke();
    if (!ghost) {
      ctx.beginPath(); ctx.arc(0, 0, r * 0.58, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,244,180,.8)';
      ctx.stroke();
      // блик
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.82, -2.4, -1.1);
      ctx.lineWidth = 4.5;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,.75)';
      ctx.stroke();
      // маленькая звёздочка
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      const sx = r * 0.38, sy = r * 0.30;
      ctx.beginPath();
      ctx.moveTo(sx, sy - 6); ctx.lineTo(sx + 1.8, sy - 1.8); ctx.lineTo(sx + 6, sy);
      ctx.lineTo(sx + 1.8, sy + 1.8); ctx.lineTo(sx, sy + 6); ctx.lineTo(sx - 1.8, sy + 1.8);
      ctx.lineTo(sx - 6, sy); ctx.lineTo(sx - 1.8, sy - 1.8);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function renderObject(ctx, obj, opts) {
    opts = opts || {};
    const t = obj.t;
    const size = obj.size || 1;
    const rot = obj.rot || 0;

    if (t === 'portal') {
      const mode = obj.mode;
      const col = mode === 'ship' ? '#ff3cf7' : (mode === 'wave' ? '#22d6ff' : '#3cff6e');
      const fill = mode === 'ship' ? 'rgba(255,60,247,.22)' : (mode === 'wave' ? 'rgba(34,214,255,.22)' : 'rgba(60,255,110,.22)');
      ctx.save();
      ctx.translate(B / 2, -1.5 * B);
      ctx.shadowColor = col; ctx.shadowBlur = opts.static ? 0 : 22;
      ctx.beginPath();
      ctx.ellipse(0, 0, B * 0.52, B * 1.42, 0, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 9; ctx.strokeStyle = col;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.ellipse(0, 0, B * 0.30, B * 1.12, 0, 0, Math.PI * 2);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.75)';
      ctx.stroke();
      // пиктограмма режима
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
      if (mode === 'ship') {
        ctx.beginPath();
        ctx.ellipse(0, 0, B * 0.20, B * 0.10, 0, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      } else if (mode === 'wave') {
        ctx.beginPath();
        ctx.moveTo(-B * 0.16, -B * 0.10); ctx.lineTo(0, B * 0.08); ctx.lineTo(B * 0.16, -B * 0.10);
        ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.stroke();
      } else {
        ctx.fillRect(-B * 0.11, -B * 0.11, B * 0.22, B * 0.22);
        ctx.strokeRect(-B * 0.11, -B * 0.11, B * 0.22, B * 0.22);
      }
      ctx.restore();
      return;
    }

    if (t === 'speed') {
      const col = SPEED_COLORS[String(obj.mult)] || '#38c9ff';
      ctx.save();
      ctx.translate(B / 2, -B / 2);
      ctx.shadowColor = col; ctx.shadowBlur = opts.static ? 0 : 14;
      ctx.strokeStyle = col;
      ctx.lineWidth = 7;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const n = obj.mult >= 2 ? 3 : (obj.mult >= 1.5 ? 2 : (obj.mult >= 1 ? 1 : 1));
      const spread = 14;
      for (let i = 0; i < n; i++) {
        const ox = (i - (n - 1) / 2) * spread + (obj.mult < 1 ? 0 : 0);
        ctx.beginPath();
        if (obj.mult < 1) { // медленно: стрелка назад
          ctx.moveTo(ox + 10, -16); ctx.lineTo(ox - 8, 0); ctx.lineTo(ox + 10, 16);
        } else {
          ctx.moveTo(ox - 10, -16); ctx.lineTo(ox + 8, 0); ctx.lineTo(ox - 10, 16);
        }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      // основание
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = col;
      ctx.fillRect(-B * 0.4, B * 0.38, B * 0.8, 5);
      ctx.restore();
      return;
    }

    // объекты в центрированной системе с поворотом/масштабом
    ctx.save();
    ctx.translate(B / 2, -B / 2);
    if (rot) ctx.rotate(rot * Math.PI / 180);
    if (size !== 1) ctx.scale(size, size);

    if (t === 'block') {
      drawBlockStyle(ctx, obj.style || 1);
    } else if (t === 'slope') {
      // горка: блок, срезанный по диагонали (подъём слева направо; rot 90 — спуск)
      const h = B / 2;
      ctx.beginPath();
      ctx.moveTo(-h, h);
      ctx.lineTo(h, h);
      ctx.lineTo(h, -h);
      ctx.closePath();
      ctx.fillStyle = '#0e0e14';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,.92)';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.14)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-h + 16, h - 7);
      ctx.lineTo(h - 7, h - 7);
      ctx.lineTo(h - 7, -h + 16);
      ctx.closePath();
      ctx.stroke();
    } else if (t === 'spike') {
      ctx.beginPath();
      ctx.moveTo(-B / 2 + 3, B / 2);
      ctx.lineTo(0, -B / 2 + 2);
      ctx.lineTo(B / 2 - 3, B / 2);
      ctx.closePath();
      ctx.fillStyle = '#0e0e14';
      ctx.fill();
      ctx.lineWidth = 3 / size;
      ctx.strokeStyle = 'rgba(255,255,255,.92)';
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else if (t === 'coin') {
      const tm = opts.time || 0;
      const sx = opts.static ? 1 : Math.abs(Math.cos(tm * 2.6 + (obj.x || 0)));
      ctx.scale(Math.max(0.15, sx), 1);
      drawCoin(ctx, opts);
    } else if (t === 'orb') {
      // орб как в GD: полностью жёлтый шар (слабый — розовый),
      // ПРОБЕЛ, и вокруг — тонкое белое кольцо, которое пульсирует;
      // при активации кольцо «расплывается» (эффект whitering в игре)
      const kind = orbKind(obj);
      const main = ORB_COLORS[kind].main;
      const deep = ORB_COLORS[kind].deep;
      const tm = opts.time || 0;
      const act = (!opts.static && obj._fxT != null) ? tm - obj._fxT : -1;
      const overload = act >= 0 && act < 0.3;
      ctx.save();
      ctx.globalAlpha = obj.used && !overload ? 0.35 : 1;
      // резкая СЛУЧАЙНАЯ пульсация: весь орб (шар + белое кольцо) скачет ~12 раз/сек
      let pulse = 0;
      if (!opts.static) {
        const seed = Math.floor(tm * 12 + (obj.x || 0) * 2.7);
        const rnd = Math.abs(Math.sin(seed * 12.9898 + (obj.x || 0) * 3.1) * 43758.5453) % 1;
        pulse = (rnd - 0.4) * B * 0.13;
      }
      const R = B * 0.24 + pulse;
      if (!opts.static) { ctx.shadowColor = main; ctx.shadowBlur = overload ? 26 : 14; }
      const cg = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R);
      cg.addColorStop(0, overload ? '#ffffff' : main);
      cg.addColorStop(1, overload ? '#ffffff' : deep);
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fillStyle = cg;
      ctx.fill();
      ctx.shadowBlur = 0;
      // белое кольцо — пульсирует вместе с шаром (на тот же сдвиг)
      ctx.beginPath(); ctx.arc(0, 0, B * 0.37 + pulse, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.stroke();
      // dash-орб: две шевронные стрелки вперёд — знак, что отсюда несёт рывком
      if (kind === 'dash') {
        ctx.lineWidth = 3.2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#0d3b16';
        for (let i = 0; i < 2; i++) {
          const dxc = -B * 0.09 + i * B * 0.13;
          ctx.beginPath();
          ctx.moveTo(dxc, -B * 0.1);
          ctx.lineTo(dxc + B * 0.08, 0);
          ctx.lineTo(dxc, B * 0.1);
          ctx.stroke();
        }
      }
      ctx.restore();
    } else if (t === 'pad') {
      // батут как в GD: жёлтый полуовал-купол на земле (розовый — слабый,
      // синий — переворот гравитации); тонкая белая обводка
      const pkind = obj.kind === 'pink' ? 'pink' : (obj.kind === 'blue' ? 'blue' : 'yellow');
      const main = pkind === 'pink' ? '#ff8ae0' : (pkind === 'blue' ? '#5ad2ff' : '#ffe14d');
      const deep = pkind === 'pink' ? '#d8409c' : (pkind === 'blue' ? '#1a7ec2' : '#e8960c');
      const tm = opts.time || 0;
      const act = (!opts.static && obj._fxT != null) ? tm - obj._fxT : -1;
      let squash = 1;
      if (act >= 0 && act < 0.08) squash = 1 - act / 0.08 * 0.5;
      else if (act >= 0.08 && act < 0.2) squash = 0.5 + (act - 0.08) / 0.12 * 1.0; // до 1.5
      else if (act >= 0.2 && act < 0.32) squash = 1.5 - (act - 0.2) / 0.12 * 0.5;
      const pulse = opts.static ? 1 : 1 + Math.sin(tm * 2.6 + (obj.x || 0)) * 0.05;
      ctx.save();
      ctx.globalAlpha = obj.used && !(act >= 0 && act < 0.32) ? 0.45 : 1;
      ctx.translate(0, B / 2);
      ctx.scale(pulse, squash);
      if (!opts.static) { ctx.shadowColor = main; ctx.shadowBlur = act >= 0 && act < 0.32 ? 22 : 12; }
      // купол: верхняя половина овала, плоской стороной на землю
      const rx = B * 0.44, ry = B * 0.20;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, Math.PI, 0);
      ctx.closePath();
      const pg = ctx.createLinearGradient(0, -ry, 0, 0);
      pg.addColorStop(0, '#ffffff');
      pg.addColorStop(0.3, main);
      pg.addColorStop(1, deep);
      ctx.fillStyle = pg;
      ctx.fill();
      ctx.shadowBlur = 0;
      // тонкая белая обводка
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.stroke();
      ctx.restore();
    } else if (t === 'trigger') {
      if (opts.editor) {
        ctx.beginPath(); ctx.arc(0, 0, B * 0.36, 0, Math.PI * 2);
        ctx.fillStyle = obj.color || '#ff00ff';
        ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
        ctx.setLineDash([6, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
        ctx.font = '900 22px "Arial Black", Arial';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeText('C', 0, 1);
        ctx.fillText('C', 0, 1);
      }
    } else if (t === 'move') {
      if (opts.editor) {
        ctx.beginPath(); ctx.arc(0, 0, B * 0.36, 0, Math.PI * 2);
        ctx.fillStyle = '#ffa53c';
        ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
        ctx.setLineDash([6, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
        ctx.font = '900 20px "Arial Black", Arial';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeText('M', 0, 1);
        ctx.fillText('M', 0, 1);
      }
    } else if (t === 'start') {
      // старт-позиция: видна только в редакторе, тест начинается с неё
      if (opts.editor) {
        ctx.strokeStyle = '#3cff6e';
        ctx.lineWidth = 3;
        ctx.setLineDash([7, 5]);
        ctx.strokeRect(-B / 2 + 3, -B / 2 + 3, B - 6, B - 6);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(60,255,110,.25)';
        ctx.fillRect(-B / 2 + 3, -B / 2 + 3, B - 6, B - 6);
        ctx.beginPath();
        ctx.moveTo(-B * 0.14, -B * 0.2);
        ctx.lineTo(B * 0.2, 0);
        ctx.lineTo(-B * 0.14, B * 0.2);
        ctx.closePath();
        ctx.fillStyle = '#3cff6e';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();

    // номер группы (только в редакторе)
    if (opts.editor && obj.group) {
      ctx.save();
      ctx.font = '900 13px "Arial Black", Arial';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#7dff00';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.strokeText('g' + obj.group, 2, -B + 14);
      ctx.fillText('g' + obj.group, 2, -B + 14);
      ctx.restore();
    }
  }

  /* ---------- нормализация уровня ---------- */
  const TYPES = ['block', 'spike', 'coin', 'portal', 'trigger', 'orb', 'pad', 'speed', 'move', 'start', 'slope'];
  const DIFFICULTIES = ['easy', 'normal', 'hard', 'harder', 'insane', 'demon'];
  function normalizeLevel(raw) {
    const lvl = {
      name: String(raw.name || 'Без названия'),
      bg: raw.bg || '#287dff',
      music: raw.music || null,
      musicName: raw.musicName || null,
      difficulty: DIFFICULTIES.includes(raw.difficulty) ? raw.difficulty : 'normal',
      objects: []
    };
    (raw.objects || []).forEach(o => {
      if (!o || typeof o.x !== 'number' || !TYPES.includes(o.t)) return;
      // координаты с шагом 0.05 — поддержка свободного размещения в редакторе
      const obj = { t: o.t, x: Math.round(o.x * 20) / 20, y: Math.round((o.y || 0) * 20) / 20 };
      if (o.rot) obj.rot = ((Math.round(o.rot / 90) * 90) % 360 + 360) % 360;
      if (o.size && o.size !== 1) obj.size = Math.max(0.4, Math.min(3, +o.size));
      if (o.group) obj.group = Math.max(0, Math.min(99, Math.round(+o.group))) || 0;
      if (o.t === 'block') obj.style = [1, 2, 3, 4].includes(o.style) ? o.style : 1;
      if (o.t === 'portal') obj.mode = ['ship', 'wave'].includes(o.mode) ? o.mode : 'cube';
      // dash — только у орбов: батут-рывок не предусмотрен
      if (o.t === 'orb') obj.kind = ORB_KINDS.includes(o.kind) ? o.kind : 'yellow';
      if (o.t === 'pad') obj.kind = ['pink', 'blue'].includes(o.kind) ? o.kind : 'yellow';
      if (o.t === 'speed') obj.mult = [0.8, 1, 1.5, 2].includes(+o.mult) ? +o.mult : 1;
      if (o.t === 'trigger') {
        obj.color = o.color || '#ff00ff';
        obj.dur = isFinite(+o.dur) ? Math.max(0, Math.min(10, +o.dur)) : 1;
      }
      if (o.t === 'move') {
        obj.target = Math.max(1, Math.min(99, Math.round(+o.target) || 1));
        obj.dx = Math.max(-200, Math.min(200, +o.dx || 0));
        obj.dy = Math.max(-200, Math.min(200, +o.dy || 0));
        obj.dur = Math.max(0, Math.min(10, +o.dur || 0));
      }
      lvl.objects.push(obj);
    });
    let maxX = 0;
    lvl.objects.forEach(o => { if (o.x > maxX) maxX = o.x; });
    lvl.endX = (Math.max(maxX, 25) + 9) * B;
    return lvl;
  }

  /* ============================================================
     ИГРА
     ============================================================ */
  function Game(canvas, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks || {};
    this.running = false;
    this.paused = false;
    this.iconId = 0;
    this.viewZoom = window.GW_VIEW_ZOOM || 1; // >1 — камера ближе (телефоны)
    this.startX = -6 * B;
    this._raf = null;
    this._accum = 0;
    this._last = 0;
    this.music = null;

    this._onDown = (e) => { e.preventDefault(); this.setHold(true); };
    this._onUp = () => this.setHold(false);
    this._onKey = (e) => {
      if (!this.running || this.paused) return;
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        if (!e.repeat) this.setHold(true);
        e.preventDefault();
      } else if (e.code === 'KeyZ' && this.practice) {
        this.placeCheckpoint(true);
      } else if (e.code === 'KeyX' && this.practice) {
        this.removeCheckpoint();
      }
    };
    this._onKeyUp = (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') this.setHold(false);
    };
    canvas.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKeyUp);
  }

  Game.prototype.destroy = function () {
    this.stop();
    this.canvas.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKeyUp);
  };

  Game.prototype.setLevel = function (rawLevel, savedCoins, startX, startY) {
    this.level = normalizeLevel(rawLevel);
    this.savedCoins = savedCoins || [];
    this.startX = (typeof startX === 'number') ? startX : -6 * B;
    this.startY = (typeof startY === 'number') ? startY : 0;
    this.attempts = 0;
    this.practice = false;
    this.checkpoints = [];
    if (this.music) { this.music.pause(); this.music = null; }
    if (this.level.music) {
      this.music = new Audio(this.level.music);
      this.music.volume = (window.GW_SETTINGS && window.GW_SETTINGS.musicVol != null) ? window.GW_SETTINGS.musicVol : 0.5;
    }
    let ci = 0;
    this.level.objects.forEach(o => { if (o.t === 'coin') o.coinIndex = ci++; });
    this.coinTotal = ci;
    // индекс по колонкам: быстрые коллизии и отрисовка даже на 10 000+ объектов
    this.staticCols = new Map();
    this.groupedObjs = [];
    this.level.objects.forEach(o => {
      if (o.t === 'start') return;               // старт-позиция — только для редактора
      if (o.group) { this.groupedObjs.push(o); return; }
      const col = Math.floor(o.x);               // координаты могут быть дробными
      let arr = this.staticCols.get(col);
      if (!arr) this.staticCols.set(col, arr = []);
      arr.push(o);
    });
    this.resetAttempt(true);
  };

  Game.prototype.setIcon = function (id) { this.iconId = id; };

  Game.prototype.getOff = function (o) {
    return (o.group && this.groupOff[o.group]) || ZERO_OFF;
  };

  /* полный сброс попытки (full=true — сброс всей сессии уровня) */
  Game.prototype.resetAttempt = function (full) {
    const cp = (!full && this.practice && this.checkpoints.length)
      ? this.checkpoints[this.checkpoints.length - 1] : null;

    this.attempts++;
    this.p = {
      x: cp ? cp.x : this.startX,
      y: cp ? cp.y : this.startY,
      vy: cp ? cp.vy : 0,
      mode: cp ? cp.mode : 'cube',
      grav: cp ? (cp.grav || 1) : 1,   // 1 — обычная гравитация, -1 — перевёрнутая
      rot: 0,
      grounded: true,
      dash: false,      // рывок от dash-орба не должен утекать в следующую попытку
      dashY: 0,
      dead: false,
      won: false
    };
    this.wonT = 0;
    this._completeFired = false;
    this._wallHit = null;
    this._winFrom = null;
    this._winBurst = false;
    this._winCamTarget = null;
    this.hold = false;
    this._pressBuf = 0;
    this.jumpsAttempt = 0;
    if (full) { this.timeTotal = 0; this.checkpoints = []; }
    if (full || !this.practice) this.runCoins = this.runCoins && !full && this.practice ? this.runCoins : [];
    if (!this.practice) this.runCoins = [];
    this.time = 0;
    this.deadTimer = 0;
    this.particles = [];
    this.waveTrail = [];
    this.cpAutoTimer = 0;
    this.fx = [];
    this.deathFx = null;
    this.spawnT = 0;          // эффект появления
    this.padTrail = [];
    this.padTrailT = 0;

    // сброс одноразовых объектов и восстановление состояния мира до startX
    const startX = this.p.x;
    this.groupOff = {};
    this.moveAnims = [];
    this.speedMult = cp ? cp.speedMult : 1;
    let lastSpeedX = -Infinity;
    this.level.objects.forEach(o => {
      if (o.t === 'portal') o.used = o.x * B + B < startX;
      if (o.t === 'trigger' || o.t === 'move') o.used = o.x * B <= startX;
      if (o.t === 'speed') {
        o.used = o.x * B + B < startX;
        if (o.used && !cp && o.x * B > lastSpeedX) { lastSpeedX = o.x * B; this.speedMult = o.mult; }
      }
      if (o.t === 'orb' || o.t === 'pad') { o.used = false; o._fxT = null; }
      if (o.t === 'coin') o.taken = this.runCoins.includes(o.coinIndex);
    });
    // применяем прошедшие move-триггеры мгновенно
    this.level.objects.forEach(o => {
      if (o.t === 'move' && o.used) {
        const off = this.groupOff[o.target] || (this.groupOff[o.target] = { x: 0, y: 0 });
        off.x += o.dx * B;
        off.y += o.dy * B;
      }
    });

    // режим игрока при старте не с начала — по последнему пройденному порталу
    if (!cp) {
      let lastPX = -Infinity;
      this.level.objects.forEach(o => {
        if (o.t === 'portal' && o.used && o.x * B > lastPX) {
          lastPX = o.x * B;
          this.p.mode = o.mode;
        }
      });
      this.p.grounded = this.p.mode === 'cube' && this.p.y === 0;
    }

    // цвет фона: последний триггер до точки старта
    let bg = this.level.bg;
    this.level.objects.forEach(o => {
      if (o.t === 'trigger' && o.used) bg = o.color;
    });
    this.bgCur = bg; this.bgFrom = bg; this.bgTo = bg; this.bgT = 1; this.bgDur = 0;

    this.camX = this.p.x - 5 * B;
    this.camY = Math.max(0, this.p.y - 4 * B);

    if (this.music && this.running) {
      if (!this.practice) {
        // перемотка на начало ВСЕГДА (даже из меню паузы) — иначе
        // «начать заново» рестартовало всё, кроме музыки
        this.music.currentTime = 0;
        if (!this.paused) this.music.play().catch(() => {});
      } else if (!this.paused && this.music.paused) {
        this.music.play().catch(() => {});
      }
    }
    if (this.hooks.onAttempt) this.hooks.onAttempt(this.attempts);
  };

  Game.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this._last = performance.now();
    this._accum = 0;
    Sfx.ensure();
    if (this.music) { this.music.currentTime = 0; this.music.play().catch(() => {}); }
    const loop = (now) => {
      if (!this.running) return;
      let dt = (now - this._last) / 1000;
      this._last = now;
      const rawDt = dt;
      if (rawDt > 0) this._fps = this._fps ? this._fps * 0.9 + (1 / rawDt) * 0.1 : 1 / rawDt;
      if (dt > 0.05) dt = 0.05;
      // дельта кадра — для отрисовки: физика идёт подшагами по 1/240,
      // а частицы выбрасываются один раз за кадр, и по подшагу их было бы вчетверо меньше
      this._frameDt = dt;
      if (!this.paused) {
        const STEP = 1 / 240;
        this._accum += dt;
        while (this._accum >= STEP) {
          this.step(STEP);
          this._accum -= STEP;
        }
      }
      this.render();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
    // резерв: если вкладка в фоне и rAF молчит, не даём игре зависнуть
    this._pump = setInterval(() => {
      if (this.running && performance.now() - this._last > 200) loop(performance.now());
    }, 100);
  };

  Game.prototype.stop = function () {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._pump) { clearInterval(this._pump); this._pump = null; }
    if (this.music) this.music.pause();
  };

  Game.prototype.setPaused = function (p) {
    this.paused = p;
    if (this.music) {
      if (p) this.music.pause();
      else if (this.running && !this.p.dead) this.music.play().catch(() => {});
    }
    if (!p) this._last = performance.now();
  };

  Game.prototype.setPractice = function (on) {
    this.practice = on;
    this.checkpoints = [];
    this.attempts = Math.max(0, this.attempts - 1);
    this.resetAttempt(true);
    if (this.hooks.onPractice) this.hooks.onPractice(on);
  };

  Game.prototype.setHold = function (h) {
    if (h && !this.hold && this.running && !this.paused) {
      this._jumpQueued = true;
      this._pressBuf = 1.5; // нажатие «запоминается» до 1.5 сек — успеешь долететь до орба
    }
    this.hold = h;
  };

  /* ---------- чекпоинты (практика) ---------- */
  Game.prototype.placeCheckpoint = function (manual) {
    if (!this.practice || this.p.dead || this.p.won) return;
    this.checkpoints.push({ x: this.p.x, y: this.p.y, vy: this.p.vy, mode: this.p.mode, grav: this.p.grav, speedMult: this.speedMult });
    if (manual) Sfx.checkpoint();
    this.cpAutoTimer = 0;
  };
  Game.prototype.removeCheckpoint = function () {
    if (this.checkpoints.length) this.checkpoints.pop();
  };

  Game.prototype._hazardAhead = function () {
    const px = this.p.x;
    for (const o of this.level.objects) {
      if (o.t !== 'spike') continue;
      const ox = o.x * B + this.getOff(o).x;
      if (ox > px - B && ox < px + 2.2 * B) return true;
    }
    return false;
  };

  /* ---------- физика ---------- */
  Game.prototype.step = function (dt) {
    const p = this.p;

    // переход цвета фона
    if (this.bgT < 1) {
      this.bgT = Math.min(1, this.bgT + (this.bgDur > 0 ? dt / this.bgDur : 1));
      this.bgCur = lerpColor(this.bgFrom, this.bgTo, this.bgT);
    }

    // move-анимации групп
    for (let i = this.moveAnims.length - 1; i >= 0; i--) {
      const a = this.moveAnims[i];
      a.t += dt;
      const k = a.dur > 0 ? Math.min(1, a.t / a.dur) : 1;
      const off = this.groupOff[a.gid] || (this.groupOff[a.gid] = { x: 0, y: 0 });
      off.x = a.sx + a.dx * k;
      off.y = a.sy + a.dy * k;
      if (k >= 1) this.moveAnims.splice(i, 1);
    }

    // частицы
    this.particles = this.particles.filter(pt => {
      // воронка у орба: частица не летит по прямой, а закручивается к центру
      if (pt.vortex) {
        pt.ang += pt.angVel * dt;
        pt.rad -= pt.radVel * dt;
        pt.x = pt.cx + Math.cos(pt.ang) * pt.rad;
        pt.y = pt.cy + Math.sin(pt.ang) * pt.rad;
        pt.size = pt.size0 * Math.max(0.25, pt.rad / pt.rad0); // ближе к центру — мельче
        pt.life -= dt;
        return pt.life > 0 && pt.rad > B * 0.08; // втянуло внутрь — гаснет
      }
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vy -= 2400 * dt * (pt.grav || 0);
      if (pt.vrot) pt.rot = (pt.rot || 0) + pt.vrot * dt;
      pt.life -= dt;
      if (pt.suckX != null && pt.x >= pt.suckX) return false; // влетела в стену
      return pt.life > 0;
    });

    // короткие эффекты (ударные волны, вспышки, кольца)
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.t += dt;
      if (f.t >= f.dur) this.fx.splice(i, 1);
    }

    // куски разбитого кубика летят и падают
    if (this.deathFx) {
      this.deathFx.t += dt;
      for (const pc of this.deathFx.pieces) {
        pc.x += pc.vx * dt;
        pc.y += pc.vy * dt;
        pc.vy -= 4200 * dt;
        pc.rot += pc.vrot * dt;
      }
      if (this.deathFx.t > 1.0) this.deathFx = null;
    }
    if (this.spawnT < 1) this.spawnT += dt;

    if (p.won) {
      // финиш: кубик подлетает к центру стены (0.45с) → уходит в неё →
      // 1.5с лучи; музыка играет дальше
      const FLY = 0.45;
      this.wonT += dt;
      if (this.wonT <= FLY && this._winFrom && this._wallHit) {
        const k = Math.min(1, this.wonT / FLY);
        const e = k * k * (3 - 2 * k);
        const tx = this._wallHit.x - B * 0.85;
        const ty = this._wallHit.y - B / 2;
        p.x = this._winFrom.x + (tx - this._winFrom.x) * e;
        // прыжок-дуга вверх + быстрая закрутка — «засасывает» в стену
        p.y = this._winFrom.y + (ty - this._winFrom.y) * e + Math.sin(k * Math.PI) * B * 1.5;
        p.rot += 760 * dt;
      } else if (!this._winBurst && this._wallHit) {
        this._winBurst = true;
        this.spawnBurst(this._wallHit.x - 4, this._wallHit.y, '#ffffff', 18);
        this.fx.push({ kind: 'whitering', x: this._wallHit.x - 4, y: this._wallHit.y, t: 0, dur: 0.6, r0: B * 0.3 });
      }
      // камера плавно отъезжает: уровень слева, стена у правого края
      if (this._winCamTarget != null) {
        this.camX += (this._winCamTarget - this.camX) * Math.min(1, 4 * dt);
      }
      if (!this._completeFired && this.wonT >= FLY + 1.5) {
        this._completeFired = true;
        if (this.hooks.onComplete) {
          this.hooks.onComplete({
            attempts: this.attempts,
            jumps: this.jumpsAttempt,
            time: Math.round(this.timeTotal),
            coins: this.runCoins.slice(),
            practice: this.practice
          });
        }
      }
      return;
    }

    if (p.dead) {
      this.deadTimer += dt;
      if (this.deadTimer > 1.0) this.resetAttempt(false);
      return;
    }

    // след после батута
    if (this.padTrailT > 0) {
      this.padTrailT -= dt;
      this.padTrail.push({ x: p.x + B * 0.2, y: p.y + B / 2 });
      if (this.padTrail.length > 26) this.padTrail.shift();
    } else if (this.padTrail.length) {
      this.padTrail.splice(0, 2);
    }

    this.time += dt;
    this.timeTotal += dt;
    if (this._pressBuf > 0) this._pressBuf -= dt;

    const prevY = p.y;
    const speed = PHYS.SPEED * this.speedMult;

    // движение вперёд
    p.x += speed * dt;

    // вертикаль по режимам (g = направление гравитации: 1 обычная, -1 перевёрнутая)
    const g = p.grav;
    if (p.dash) {
      // рывок от dash-орба: гравитации нет, игрока тянет по линии орба,
      // держится ровно столько, сколько зажата кнопка
      this._jumpQueued = false;
      p.vy = 0;
      p.y += (p.dashY - p.y) * Math.min(1, dt * 20); // мягко выходим на линию, без скачка
      if (!this.hold) p.dash = false;
    } else if (p.mode === 'cube') {
      if ((this.hold || this._jumpQueued) && p.grounded) {
        p.vy = PHYS.JUMP_V * g;
        p.grounded = false;
        this.jumpsAttempt++;
        this._pressBuf = 0;
      }
      this._jumpQueued = false;
      p.vy -= PHYS.GRAV * g * dt;
      if (p.vy * g < -PHYS.FALL_MAX) p.vy = -PHYS.FALL_MAX * g;
      p.y += p.vy * dt;
    } else if (p.mode === 'ship') {
      this._jumpQueued = false;
      p.vy += (this.hold ? PHYS.SHIP_ACC : -PHYS.SHIP_GRAV) * g * dt;
      if (p.vy > PHYS.SHIP_VMAX) p.vy = PHYS.SHIP_VMAX;
      if (p.vy < -PHYS.SHIP_VMAX) p.vy = -PHYS.SHIP_VMAX;
      p.y += p.vy * dt;
    } else { // wave — 45 градусов
      this._jumpQueued = false;
      p.vy = (this.hold ? speed : -speed) * g;
      p.y += p.vy * dt;
    }

    p.grounded = false;

    // земля
    if (p.y <= 0) {
      p.y = 0;
      if (p.vy < 0) p.vy = 0;
      if (g > 0) p.grounded = true;   // при перевёрнутой гравитации пол лишь упор
    }
    // потолок арены: для перевёрнутого куба это «пол»
    if (p.y + B >= PHYS.ARENA_CEIL && (p.mode !== 'cube' || g < 0)) {
      p.y = PHYS.ARENA_CEIL - B;
      if (p.vy > 0) p.vy = 0;
      if (g < 0) p.grounded = true;
    }

    // столкновения (через индекс колонок)
    const cMin = Math.floor(p.x / B) - 3, cMax = Math.floor((p.x + B) / B) + 4;
    for (let c = cMin; c <= cMax; c++) {
      const arr = this.staticCols.get(c);
      if (!arr) continue;
      for (const o of arr) {
        if (this._collide(o, prevY)) return;
      }
    }
    for (const o of this.groupedObjs) {
      if (this._collide(o, prevY)) return;
    }

    this._afterStep(dt);
  };

  /* столкновение игрока с одним объектом; true — игрок погиб */
  Game.prototype._collide = function (o, prevY) {
    const p = this.p;
    const off = this.getOff(o);
    const baseX = o.x * B + off.x, baseY = o.y * B + off.y;
    if (baseX < p.x - 3 * B || baseX > p.x + 4 * B) return false;

    {
      if (o.t === 'block') {
        const bs = B * (o.size || 1);
        const bx = baseX + (B - bs) / 2, by = baseY + (B - bs) / 2;
        if (p.mode === 'wave') {
          // у волны маленький хитбокс — тоннели проходимы
          const wi = B * 0.32;
          if (p.x + B - wi <= bx || p.x + wi >= bx + bs || p.y + B - wi <= by || p.y + wi >= by + bs) return false;
          this.die(); return true;
        }
        if (p.x + B <= bx || p.x >= bx + bs || p.y + B <= by || p.y >= by + bs) return false;
        if (p.grav > 0) {
          // сверху (посадка)
          if (prevY >= by + bs - 0.01 && p.vy <= 0) {
            p.y = by + bs; p.vy = 0; p.grounded = true; return false;
          }
          if (p.vy <= 0 && p.y >= by + bs - PHYS.CLIP) {
            p.y = by + bs; p.vy = 0; p.grounded = true; return false;
          }
          // снизу
          if (prevY + B <= by + 0.01 && p.vy >= 0) {
            if (p.mode === 'ship') { p.y = by - B; p.vy = 0; return false; }
            this.die(); return true;
          }
        } else {
          // перевёрнутая гравитация: «пол» — низ блока
          if (prevY + B <= by + 0.01 && p.vy >= 0) {
            p.y = by - B; p.vy = 0; p.grounded = true; return false;
          }
          if (p.vy >= 0 && p.y + B <= by + PHYS.CLIP) {
            p.y = by - B; p.vy = 0; p.grounded = true; return false;
          }
          if (prevY >= by + bs - 0.01 && p.vy <= 0) {
            if (p.mode === 'ship') { p.y = by + bs; p.vy = 0; return false; }
            this.die(); return true;
          }
        }
        this.die(); return true;
      }

      if (o.t === 'slope') {
        // горка 45°: rot 0 — подъём слева направо, rot 90 — спуск.
        // Куб и корабль взбираются без прыжка; волна погибает.
        const bx = baseX, by = baseY;
        if (p.x + B <= bx || p.x >= bx + B) return false;
        const desc = o.rot === 90;
        const lead = desc ? (bx + B - p.x) : (p.x + B - bx);
        const surf = by + Math.max(0, Math.min(B, lead));
        if (p.mode === 'wave') {
          const wi = B * 0.32;
          if (p.y + wi < surf && p.y + B - wi > by) { this.die(); return true; }
          return false;
        }
        if (p.grav < 0) {
          // перевёрнутый режим о горку разбивается (глубокое пересечение)
          if (p.y < surf - 6 && p.y + B > by) { this.die(); return true; }
          return false;
        }
        if (p.y < surf) {
          if (p.y >= surf - B * 0.45 || p.vy < 0 || p.grounded) {
            p.y = surf;
            if (p.vy < 0) p.vy = 0;
            p.grounded = true;
          } else {
            this.die(); return true;  // врезался в высокий торец горки
          }
        }
        return false;
      }

      if (o.t === 'spike') {
        const hs = B * 0.30 * (o.size || 1);
        const cx = baseX + B / 2, cy = baseY + B / 2;
        const m = p.mode === 'wave' ? 0.36 : 0.28; // у волны хитбокс меньше
        const il = p.x + B * m, ir = p.x + B * (1 - m), ib = p.y + B * m, it = p.y + B * (1 - m);
        if (ir > cx - hs / 2 && il < cx + hs / 2 && it > cy - hs / 2 && ib < cy + hs / 2) {
          this.die(); return true;
        }
      }

      if (o.t === 'coin' && !o.taken) {
        const cx = baseX + B / 2, cy = baseY + B / 2;
        const dx = (p.x + B / 2) - cx, dy = (p.y + B / 2) - cy;
        const r = B * 0.75 * Math.max(1, o.size || 1);
        if (dx * dx + dy * dy < r * r) {
          o.taken = true;
          if (!this.savedCoins[o.coinIndex]) {
            if (!this.runCoins.includes(o.coinIndex)) this.runCoins.push(o.coinIndex);
          }
          Sfx.coin();
          this.spawnBurst(cx, cy, '#ffd94d', 10);
          if (this.hooks.onCoin) this.hooks.onCoin(this.runCoins.length);
        }
      }

      if (o.t === 'orb' && !o.used && p.mode !== 'wave') {
        // орб срабатывает ТОЛЬКО по свежему нажатию — зажатие не считается
        if (this._pressBuf > 0) {
          const cx = baseX + B / 2, cy = baseY + B / 2;
          const dx = (p.x + B / 2) - cx, dy = (p.y + B / 2) - cy;
          const r = B * 0.75 * (o.size || 1);
          if (dx * dx + dy * dy < r * r) {
            o.used = true;
            o._fxT = this.time;
            this._pressBuf = 0;
            if (o.kind === 'blue') {
              // синий орб: переворот гравитации
              p.grav *= -1;
              p.vy = -p.grav * 350;
              p.grounded = false;
            } else if (o.kind === 'dash') {
              // dash-орб: пока кнопку держат, игрок летит по прямой на высоте орба
              p.dash = true;
              p.dashY = cy - B / 2;
              p.vy = 0;
              p.grounded = false;
            } else {
              const k = o.kind === 'pink' ? 0.8 : 1.0;
              if (p.mode === 'cube') { p.vy = PHYS.JUMP_V * k * p.grav; p.grounded = false; }
              else { p.vy = 640 * k * p.grav; }
            }
            this.jumpsAttempt++;
            // белая обводка «расплывается» + искры
            const main = ORB_COLORS[orbKind(o)].burst;
            this.spawnBurst(cx, cy, main, 6);
            this.spawnBurst(cx, cy, '#ffffff', 6);
            this.fx.push({ kind: 'whitering', x: cx, y: cy, t: 0, dur: 0.45, r0: B * 0.30 });
          }
        }
      }

      if (o.t === 'pad' && !o.used && p.mode !== 'wave') {
        // площадка занимает нижнюю часть клетки
        const px1 = baseX + B * 0.08, px2 = baseX + B * 0.92;
        const py1 = baseY, py2 = baseY + B * 0.35;
        if (p.x + B > px1 && p.x < px2 && p.y <= py2 && p.y + B > py1) {
          o.used = true;
          o._fxT = this.time;
          if (o.kind === 'blue') {
            // синий батут: переворот гравитации с толчком
            p.grav *= -1;
            p.vy = -p.grav * 520;
            p.grounded = false;
          } else {
            const k = o.kind === 'pink' ? 0.95 : 1.32;
            if (p.mode === 'cube') { p.vy = PHYS.JUMP_V * k * p.grav; p.grounded = false; }
            else { p.vy = 640 * k * p.grav; }
          }
          // запуск: белое кольцо, вспышка, частицы вверх, след за игроком
          const cx = baseX + B / 2, cy = baseY + B * 0.2;
          const main = o.kind === 'pink' ? '#ff8ae0' : (o.kind === 'blue' ? '#5ad2ff' : '#ffe14d');
          this.fx.push({ kind: 'whitering', x: cx, y: cy, t: 0, dur: 0.45, r0: B * 0.3 });
          this.fx.push({ kind: 'shockwave', x: cx, y: cy, t: -0.08, dur: 0.5, color: main });
          this.fx.push({ kind: 'flashlocal', x: cx, y: cy, t: 0, dur: 0.22 });
          for (let i = 0; i < 10; i++) {
            const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
            const sp = 280 + Math.random() * 380;
            this.particles.push({
              x: cx, y: cy,
              vx: Math.cos(a) * sp, vy: -Math.sin(a) * sp,
              life: 0.4 + Math.random() * 0.3, max: 0.7,
              size: 5 + Math.random() * 6, color: i % 2 ? '#ffffff' : main,
              grav: 0.4, shape: 'shard',
              rot: Math.random() * 6.28, vrot: (Math.random() - 0.5) * 12
            });
          }
          this.padTrailT = 0.55;
        }
      }

      if (o.t === 'portal' && !o.used) {
        if (p.x + B > baseX + B * 0.2 && p.x < baseX + B * 0.8 && p.y + B > baseY && p.y < baseY + 3 * B) {
          o.used = true;
          if (p.mode !== o.mode) {
            p.mode = o.mode;
            p.vy *= 0.3;
            p.rot = 0;
            const col = o.mode === 'ship' ? '#ff3cf7' : (o.mode === 'wave' ? '#22d6ff' : '#3cff6e');
            this.spawnBurst(p.x + B / 2, p.y + B / 2, col, 14);
          }
        }
      }

      if (o.t === 'speed' && !o.used) {
        if (p.x + B > baseX + B * 0.1 && p.x < baseX + B * 0.9 && p.y + B > baseY && p.y < baseY + 2 * B) {
          o.used = true;
          if (this.speedMult !== o.mult) {
            this.speedMult = o.mult;
            this.spawnBurst(p.x + B / 2, p.y + B / 2, SPEED_COLORS[String(o.mult)] || '#38c9ff', 10);
          }
        }
      }

      if (o.t === 'trigger' && !o.used) {
        if (p.x + B / 2 >= baseX) {
          o.used = true;
          this.bgFrom = this.bgCur;
          this.bgTo = o.color;
          this.bgDur = o.dur;
          this.bgT = this.bgDur > 0 ? 0 : 1;
          if (this.bgT >= 1) this.bgCur = this.bgTo;
        }
      }

      if (o.t === 'move' && !o.used) {
        if (p.x + B / 2 >= baseX) {
          o.used = true;
          const cur = this.groupOff[o.target] || (this.groupOff[o.target] = { x: 0, y: 0 });
          this.moveAnims.push({
            gid: o.target,
            sx: cur.x, sy: cur.y,
            dx: o.dx * B, dy: o.dy * B,
            t: 0, dur: o.dur
          });
        }
      }
    }
    return false;
  };

  /* часть шага после коллизий */
  Game.prototype._afterStep = function (dt) {
    const p = this.p;

    // приземлился или упёрся в блок — рывок обрывается
    if (p.dash && p.grounded) p.dash = false;

    // зелёный след за рывком
    if (p.dash && !p.dead && Math.random() < Math.min(0.9, 90 * dt)) {
      this.particles.push({
        x: p.x + B * (0.1 + Math.random() * 0.3),
        y: p.y + B * (0.15 + Math.random() * 0.7),
        vx: -180 - Math.random() * 160,
        vy: (Math.random() - 0.5) * 60,
        life: 0.18 + Math.random() * 0.16, max: 0.34,
        size: 3 + Math.random() * 3.5,
        color: Math.random() < 0.5 ? ORB_COLORS.dash.main : ORB_COLORS.dash.spark
      });
    }

    // вращение куба
    if (p.mode === 'cube') {
      if (!p.grounded) {
        p.rot += PHYS.ROT_SPEED * p.grav * dt;
      } else {
        const target = Math.round(p.rot / 90) * 90;
        p.rot += (target - p.rot) * Math.min(1, 18 * dt);
        if (Math.abs(p.rot - target) < 0.6) p.rot = target;
      }
    }

    // частицы скольжения
    if (p.grounded && p.mode !== 'wave' && Math.random() < 0.5) {
      this.particles.push({
        x: p.x + 4, y: p.y + 3,
        vx: -140 - Math.random() * 90, vy: 40 + Math.random() * 90,
        life: 0.28 + Math.random() * 0.2, max: 0.45,
        size: 4 + Math.random() * 4, color: 'rgba(255,255,255,.85)', grav: 0.2
      });
    }

    // автоматический чекпоинт в практике (чаще, чтобы кубу тоже доставалось)
    if (this.practice) {
      this.cpAutoTimer += dt;
      if (this.cpAutoTimer > 1.6 && (p.grounded || p.mode !== 'cube') && !this._hazardAhead()) {
        this.placeCheckpoint(false);
      }
    }

    // камера
    const VWc = (window.GW_VIEW_W || VIEW_W) / this.viewZoom;
    this.camX = p.x - VWc * 0.235;
    // у финиша камера ЗАМИРАЕТ на расстоянии: стена подъезжает в кадр справа,
    // а игрок пробегает последний участок и «засасывается» в стену
    const camMax = (this.level.endX + 2 * B) - VWc * 0.72;
    if (this.camX > camMax) this.camX = camMax;
    const relY = p.y - this.camY;
    let target = this.camY;
    if (relY > 5.4 * B) target = p.y - 5.4 * B;
    else if (relY < 1.2 * B) target = Math.max(0, p.y - 1.2 * B);
    if (p.grounded && p.y === 0) target = 0;
    this.camY += (target - this.camY) * Math.min(1, 6 * dt);

    // прогресс и победа (влетаем прямо в стену)
    this._pct = Math.max(0, Math.min(100, (p.x / this.level.endX) * 100));
    if (p.x + B >= this.level.endX + 2 * B) this.win();
  };

  Game.prototype.die = function () {
    const p = this.p;
    if (p.dead) return;
    p.dead = true;
    this.deadTimer = 0;
    // кубик разбивается на 3x3 куска своей текстуры (без звука)
    const cx = p.x + B / 2, cy = p.y + B / 2;
    const pw = B / 3;
    const pieces = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const sox = (i - 1) * pw;          // смещение куска внутри кубика (экранные оси)
        const soy = (j - 1) * pw;
        pieces.push({
          x: cx + sox, y: cy - soy,
          vx: sox * 7 + (Math.random() - 0.5) * 160,
          vy: 200 + Math.random() * 260 - soy * 5,
          rot: 0,
          vrot: (Math.random() - 0.5) * 14,
          sox, soy
        });
      }
    }
    this.deathFx = { t: 0, pieces };
    // белая обводка «улетает» — как у орба
    this.fx.push({ kind: 'whitering', x: cx, y: cy, t: 0, dur: 0.5, r0: B * 0.4 });
    if (this.music && !this.practice) this.music.pause();
    if (this.hooks.onDeath) this.hooks.onDeath(this.attempts, (p.x / this.level.endX) * 100, this.jumpsAttempt);
  };

  Game.prototype.win = function () {
    const p = this.p;
    if (p.won) return;
    p.won = true;
    this.wonT = 0;
    Sfx.complete();
    // кубик полетит в ЦЕНТР стены по высоте; лучи — крупный веер влево
    const wallX = this.level.endX + 2 * B;
    this._winFrom = { x: p.x, y: p.y };
    const rays = [];
    for (let i = 0; i < 13; i++) {
      rays.push({
        ang: Math.PI * 0.5 + (i / 12) * Math.PI + (Math.random() - 0.5) * 0.12,
        len: 360 + Math.random() * 540,
        w: 12 + Math.random() * 20,
        ph: Math.random() * 6.28
      });
    }
    this._wallHit = { x: wallX - 8, y: 5.5 * B, rays };
    this._winBurst = false;
    // камера остаётся замершей на той же точке, что и при подъезде (см. update)
    this._winCamTarget = wallX - ((window.GW_VIEW_W || VIEW_W) / this.viewZoom) * 0.72;
    // музыка НЕ останавливается: играет, пока не выйдешь в меню или трек не кончится
  };

  Game.prototype.spawnBurst = function (x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 180 + Math.random() * 420;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.5 + Math.random() * 0.45, max: 0.9,
        size: 5 + Math.random() * 7, color, grav: 0.5
      });
    }
  };

  /* ---------- отрисовка ---------- */
  Game.prototype.sx = function (wx) { return wx - this.camX; };
  Game.prototype.sy = function (wy) { return (this._gsy || GROUND_SCREEN_Y) - (wy - this.camY); };

  Game.prototype.render = function () {
    const ctx = this.ctx, p = this.p;
    const bg = this.bgCur || '#287dff';
    if (this.hooks.onTick) this.hooks.onTick(this._pct || 0);

    const z = this.viewZoom || 1;
    const VW = (window.GW_VIEW_W || VIEW_W) / z, VH = VIEW_H / z;
    this._gsy = VH - (VIEW_H - GROUND_SCREEN_Y) / z; // линия земли с учётом зума
    ctx.save();
    ctx.scale(z, z);
    // тряска экрана, пока бьют лучи на финише
    if (p.won && this.wonT > 0.45 && this.wonT < 2.0) {
      const sa = 6 * Math.max(0, 1 - (this.wonT - 0.45) / 1.55);
      ctx.translate((Math.random() - 0.5) * sa * 2, (Math.random() - 0.5) * sa * 2);
    }

    const grad = ctx.createLinearGradient(0, 0, 0, VH);
    grad.addColorStop(0, shade(bg, 0.10));
    grad.addColorStop(1, shade(bg, -0.25));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VW, VH);

    // фоновый узор
    ctx.save();
    ctx.globalAlpha = 0.055;
    ctx.fillStyle = '#ffffff';
    const bgSize = 340, bgOff = -(this.camX * 0.12) % bgSize;
    for (let x = bgOff - bgSize; x < VW + bgSize; x += bgSize) {
      for (let y = -((this.camY * 0.12) % bgSize) - bgSize + 40; y < VH + bgSize; y += bgSize) {
        ctx.fillRect(x + 20, y + 20, bgSize - 40, bgSize - 40);
      }
    }
    ctx.restore();

    const groundY = this.sy(0);

    // земля
    const gcol = shade(bg, -0.45);
    const ggrad = ctx.createLinearGradient(0, groundY, 0, VH);
    ggrad.addColorStop(0, gcol);
    ggrad.addColorStop(1, shade(bg, -0.7));
    ctx.fillStyle = ggrad;
    ctx.fillRect(0, groundY, VW, VH - groundY + 400);
    ctx.save();
    ctx.globalAlpha = 0.10;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    const gSize = 120, gOff = -(this.camX % gSize);
    for (let x = gOff - gSize; x < VW + gSize; x += gSize) {
      ctx.strokeRect(x + 8, groundY + 8, gSize - 16, gSize - 16);
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.fillRect(0, groundY - 2, VW, 4);
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,.8)'; ctx.shadowBlur = 10;
    ctx.fillRect(0, groundY - 1, VW, 2);
    ctx.restore();

    // объекты (только видимые колонки индекса)
    const viewL = this.camX - 4 * B, viewR = this.camX + VW + 4 * B;
    const emitOk = !this.paused && !p.dead && !p.won;
    // частиц в секунду, а не за кадр — иначе на 120 Гц их вдвое больше, чем на 60
    const perSec = (n) => Math.min(0.9, n * (this._frameDt || 1 / 60));
    const drawObj = (o) => {
      if (o.t === 'trigger' || o.t === 'move' || o.t === 'start') return;
      const off = this.getOff(o);
      const ox = o.x * B + off.x;
      if (ox < viewL || ox > viewR) return;
      const ghost = o.t === 'coin' && (o.taken || !!this.savedCoins[o.coinIndex]);
      ctx.save();
      ctx.translate(this.sx(ox), this.sy(o.y * B + off.y));
      renderObject(ctx, o, { time: this.time, ghost });
      ctx.restore();
      // орбы затягивают частицы воронкой, батуты — просто пускают искры вверх
      if (emitOk && !o.used && o.t === 'orb' && Math.random() < perSec(58)) {
        const oy = o.y * B + off.y;
        const cx = ox + B / 2, cy = oy + B / 2;
        const rad0 = B * (0.72 + Math.random() * 0.34);
        const spin = Math.random() < 0.5 ? 1 : -1; // половина частиц крутится в другую сторону
        this.particles.push({
          vortex: true,
          cx, cy,
          ang: Math.random() * Math.PI * 2,
          rad: rad0, rad0,
          angVel: spin * (2.6 + Math.random() * 2.2),
          radVel: rad0 / (0.52 + Math.random() * 0.26), // долетает до центра за время жизни
          x: cx, y: cy,
          life: 0.52 + Math.random() * 0.26, max: 0.78,
          size: 0, size0: 2.6 + Math.random() * 2.4,
          color: Math.random() < 0.45 ? '#ffffff' : ORB_COLORS[o.kind === 'pink' ? 'pink' : (o.kind === 'blue' ? 'blue' : (o.kind === 'dash' ? 'dash' : 'yellow'))].spark
        });
      }
      if (emitOk && !o.used && o.t === 'pad' && Math.random() < perSec(8.4)) {
        const pink = o.kind === 'pink';
        const oy = o.y * B + off.y;
        this.particles.push({
          x: ox + B * (0.15 + Math.random() * 0.7),
          y: oy + B * 0.2,
          vx: (Math.random() - 0.5) * 18,
          vy: 45 + Math.random() * 45,
          life: 0.5 + Math.random() * 0.4, max: 0.9,
          size: 4.5 + Math.random() * 4,
          color: Math.random() < 0.5 ? '#ffffff' : (pink ? '#ffb8ec' : '#ffe89a'),
          grav: -0.01
        });
      }
    };
    const colL = Math.floor(viewL / B), colR = Math.ceil(viewR / B);
    for (let c = colL; c <= colR; c++) {
      const arr = this.staticCols.get(c);
      if (arr) for (const o of arr) drawObj(o);
    }
    for (const o of this.groupedObjs) drawObj(o);

    // финишная СТЕНА
    const wallX = this.level.endX + 2 * B;
    const endSX = this.sx(wallX);
    if (endSX < VW + 100) {
      ctx.save();
      // тело стены — от её грани до края экрана
      ctx.fillStyle = '#0b0b12';
      ctx.fillRect(endSX, 0, Math.max(60, VW - endSX + 60), groundY - 0);
      // горизонтальные швы
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.lineWidth = 2;
      for (let y = groundY - 60; y > 0; y -= 60) {
        ctx.beginPath(); ctx.moveTo(endSX, y); ctx.lineTo(Math.min(VW, endSX + 200), y); ctx.stroke();
      }
      // светящаяся грань
      ctx.shadowColor = 'rgba(255,255,255,.9)';
      ctx.shadowBlur = 14;
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.fillRect(endSX - 3, 0, 6, groundY);
      ctx.restore();

      // невидимые частицы, влетающие в середину стены и белеющие у неё
      if (emitOk && Math.random() < 0.4) {
        this.particles.push({
          x: wallX - 200 - Math.random() * 300,
          y: 5.5 * B + (Math.random() - 0.5) * 2 * B,
          vx: 360 + Math.random() * 180, vy: (Math.random() - 0.5) * 26,
          life: 2.5, max: 2.5,
          size: 4 + Math.random() * 4,
          color: '#ffffff', grav: 0,
          suckX: wallX - 8
        });
      }
    }

    // чекпоинты
    if (this.practice) {
      for (const cp of this.checkpoints) {
        const cx = this.sx(cp.x + B / 2), cy = this.sy(cp.y + B / 2);
        if (cx < -50 || cx > VW + 50) continue;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#3cff6e';
        ctx.strokeStyle = '#0a5c22'; ctx.lineWidth = 3;
        ctx.shadowColor = '#3cff6e'; ctx.shadowBlur = 12;
        ctx.fillRect(-11, -11, 22, 22);
        ctx.strokeRect(-11, -11, 22, 22);
        ctx.restore();
      }
    }

    // текст попытки
    if (p.x < this.startX + 10 * B && this.startX < 0) {
      ctx.save();
      ctx.font = '900 44px "Arial Black", Arial';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 6;
      const tx = this.sx(2.2 * B), ty = this.sy(3.6 * B);
      ctx.strokeText('Попытка ' + this.attempts, tx, ty);
      ctx.fillText('Попытка ' + this.attempts, tx, ty);
      ctx.restore();
    }

    // частицы (квадраты и осколки-трапеции)
    for (const pt of this.particles) {
      ctx.save();
      let pa = Math.max(0, pt.life / (pt.max || 0.5));
      // частицы у финишной стены: невидимы вдали, белеют при подлёте
      if (pt.suckX != null) pa = Math.max(0, 1 - (pt.suckX - pt.x) / 260);
      ctx.globalAlpha = pa;
      ctx.fillStyle = pt.color;
      const s = pt.size;
      const px = this.sx(pt.x), py = this.sy(pt.y);
      if (pt.vortex) {
        // штрих по касательной к окружности — глазу читается как закрутка,
        // отдельные квадратики выглядели бы просто россыпью точек
        ctx.translate(px, py);
        ctx.rotate(pt.ang + Math.PI / 2 * (pt.angVel > 0 ? 1 : -1));
        ctx.fillRect(-s * 1.9, -s * 0.42, s * 3.8, s * 0.84);
      } else if (pt.shape === 'shard') {
        ctx.translate(px, py);
        ctx.rotate(pt.rot || 0);
        ctx.beginPath();
        ctx.moveTo(-s * 0.6, s * 0.4);
        ctx.lineTo(-s * 0.25, -s * 0.5);
        ctx.lineTo(s * 0.25, -s * 0.5);
        ctx.lineTo(s * 0.6, s * 0.4);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(px - s / 2, py - s / 2, s, s);
      }
      ctx.restore();
    }

    // короткие эффекты
    for (const f of this.fx) {
      if (f.t < 0) continue; // отложенный старт
      const k = f.t / f.dur;
      const fxX = this.sx(f.x), fxY = this.sy(f.y);
      ctx.save();
      if (f.kind === 'shockwave') {
        ctx.globalAlpha = (1 - k) * 0.8;
        ctx.beginPath();
        ctx.ellipse(fxX, fxY, 10 + k * 120, (10 + k * 120) * 0.45, 0, 0, Math.PI * 2);
        ctx.lineWidth = 4 * (1 - k) + 1;
        ctx.strokeStyle = f.color || '#00ffff';
        ctx.stroke();
      } else if (f.kind === 'whitering') {
        // белая обводка «расплывается»: расширяется, толстеет и тает
        const r0 = f.r0 || 18;
        ctx.globalAlpha = (1 - k) * 0.9;
        ctx.beginPath();
        ctx.arc(fxX, fxY, r0 + k * 70, 0, Math.PI * 2);
        ctx.lineWidth = 2 + k * 10;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.globalAlpha = (1 - k) * 0.4;
        ctx.beginPath();
        ctx.arc(fxX, fxY, r0 + k * 42, 0, Math.PI * 2);
        ctx.lineWidth = 1.5 + k * 5;
        ctx.stroke();
      } else if (f.kind === 'flashlocal') {
        ctx.globalAlpha = (1 - k) * 0.75;
        const g = ctx.createRadialGradient(fxX, fxY, 2, fxX, fxY, 90);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(fxX, fxY, 90, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // след волны — выходит точно из хвоста стрелки (учитываем её наклон ±45°)
    if (p.mode === 'wave' && !p.dead && !this.paused) {
      const dir = p.grounded || p.y + B >= PHYS.ARENA_CEIL ? 0 : (p.vy > 0 ? -1 : 1);
      const ang = dir * Math.PI / 4;
      const tail = -B * 0.15; // локальный x хвоста-выреза стрелки (с учётом масштаба волны)
      this.waveTrail.push({
        x: p.x + B / 2 + tail * Math.cos(ang),
        y: p.y + B / 2 - tail * Math.sin(ang)
      });
      if (this.waveTrail.length > 40) this.waveTrail.shift();
    } else if (this.waveTrail.length) {
      this.waveTrail.splice(0, 2);
    }
    if (this.waveTrail.length > 1) {
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 1; i < this.waveTrail.length; i++) {
        const a = this.waveTrail[i - 1], b = this.waveTrail[i];
        const k = i / this.waveTrail.length;
        ctx.globalAlpha = k * 0.5;
        ctx.lineWidth = 3 + k * 9;
        ctx.strokeStyle = '#7de8ff';
        ctx.beginPath();
        ctx.moveTo(this.sx(a.x), this.sy(a.y));
        ctx.lineTo(this.sx(b.x), this.sy(b.y));
        ctx.stroke();
      }
      ctx.restore();
    }

    // лента-след после батута: цепочка бирюзовых треугольников
    if (this.padTrail.length > 1) {
      ctx.save();
      for (let i = 1; i < this.padTrail.length; i += 2) {
        const a = this.padTrail[i];
        const k = i / this.padTrail.length;
        ctx.globalAlpha = k * 0.55;
        const s = 4 + k * 9;
        const tx = this.sx(a.x), ty = this.sy(a.y);
        ctx.beginPath();
        ctx.moveTo(tx - s, ty - s * 0.7);
        ctx.lineTo(tx + s * 0.8, ty);
        ctx.lineTo(tx - s, ty + s * 0.7);
        ctx.closePath();
        ctx.fillStyle = '#ffe89a';
        ctx.fill();
      }
      ctx.restore();
    }

    // кубик летит в центр стены и «уходит» в неё, уменьшаясь
    if (p.won && !p.dead && this.wonT < 0.45) {
      const pcx = this.sx(p.x + B / 2), pcy = this.sy(p.y + B / 2);
      const s = 1 - (this.wonT / 0.45) * 0.55;
      Icons.draw(ctx, this.iconId, pcx, pcy, B * s, p.rot);
    }

    // лучи из стены после удара (1.5 сек, начинаются после подлёта)
    if (p.won && this._wallHit && this.wonT >= 0.45 && this.wonT < 2.1) {
      const wh = this._wallHit;
      const wx = this.sx(wh.x), wy = this.sy(wh.y);
      const fade = Math.max(0, 1 - (this.wonT - 0.45) / 1.5);
      ctx.save();
      ctx.lineCap = 'round';
      for (const r of wh.rays) {
        const flick = 0.55 + 0.45 * Math.sin(this.wonT * 22 + r.ph);
        const L = r.len * (0.75 + 0.25 * Math.sin(this.wonT * 9 + r.ph));
        ctx.globalAlpha = fade * flick * 0.9;
        ctx.beginPath();
        ctx.moveTo(wx, wy);
        ctx.lineTo(wx + Math.cos(r.ang) * L, wy + Math.sin(r.ang) * L);
        ctx.lineWidth = r.w * fade + 1;
        ctx.strokeStyle = '#eaf8ff';
        ctx.stroke();
      }
      // яркое ядро в точке удара (крупнее)
      ctx.globalAlpha = fade;
      const cg2 = ctx.createRadialGradient(wx, wy, 3, wx, wy, 74);
      cg2.addColorStop(0, '#ffffff');
      cg2.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = cg2;
      ctx.beginPath(); ctx.arc(wx, wy, 74, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // игрок (после удара о стену не рисуем — он «влетел» в неё)
    if (!p.dead && !p.won) {
      const pcx = this.sx(p.x + B / 2), pcy = this.sy(p.y + B / 2);
      // эффект появления: два расходящихся кольца + масштабирование кубика
      const sp = this.spawnT;
      if (sp < 0.45) {
        const sk = sp / 0.45;
        ctx.save();
        ctx.globalAlpha = (1 - sk) * 0.85;
        ctx.beginPath();
        ctx.arc(pcx, pcy, 8 + sk * 70, 0, Math.PI * 2);
        ctx.lineWidth = 3.5 * (1 - sk) + 1;
        ctx.strokeStyle = '#7de8ff';
        ctx.stroke();
        ctx.globalAlpha = (1 - sk) * 0.5;
        ctx.beginPath();
        ctx.arc(pcx, pcy, 4 + sk * 44, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.restore();
      }
      const scaleIn = sp < 0.3 ? 0.55 + 0.45 * (sp / 0.3) : 1;
      if (p.mode === 'cube') {
        if (p.grav < 0) {
          // перевёрнутая гравитация — кубик вверх ногами
          ctx.save();
          ctx.translate(pcx, pcy);
          ctx.scale(1, -1);
          Icons.draw(ctx, this.iconId, 0, 0, B * scaleIn, -p.rot);
          ctx.restore();
        } else {
          Icons.draw(ctx, this.iconId, pcx, pcy, B * scaleIn, p.rot);
        }
      } else if (p.mode === 'ship') {
        // корабль как в GD (по референсу): зелёный корпус с чёрными обводками,
        // голубой киль + верхняя рейка, сопло сзади, клин-нос спереди
        const ang = Math.max(-0.6, Math.min(0.6, -p.vy * p.grav / 1400));
        ctx.save();
        ctx.translate(pcx, pcy);
        if (p.grav < 0) ctx.scale(1, -1); // перевёрнутый полёт
        ctx.rotate(ang);
        ctx.lineWidth = 4.5;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#000';
        const GREEN = '#3ee52c', GREEN_D = '#1fae12', CYAN = '#4de8ff';
        const K = 0.78; // масштаб корпуса
        // кубик-пилот: крупный, выглядывает над корпусом за голубой рейкой
        Icons.draw(ctx, this.iconId, B * 0.02, -B * 0.4, B * 0.58, 0);
        // корпус (та самая текстура по референсу из GD)
        ctx.save();
        ctx.scale(K, K);
        // реактивная струя из сопла при удержании
        if (this.hold && !this.paused) {
          ctx.beginPath();
          ctx.moveTo(-B * 0.86, B * 0.0);
          ctx.lineTo(-B * 1.22 - Math.random() * 14, B * 0.14);
          ctx.lineTo(-B * 0.84, B * 0.28);
          ctx.closePath();
          ctx.fillStyle = 'rgba(255,190,60,.9)';
          ctx.fill();
        }
        // сопло сзади (трапеция)
        ctx.beginPath();
        ctx.moveTo(-B * 0.66, -B * 0.2);
        ctx.lineTo(-B * 0.88, -B * 0.12);
        ctx.lineTo(-B * 0.88, B * 0.42);
        ctx.lineTo(-B * 0.66, B * 0.5);
        ctx.closePath();
        ctx.fillStyle = GREEN_D;
        ctx.fill();
        ctx.stroke();
        // основной корпус — брюхо чуть поджато по высоте
        ctx.beginPath();
        ctx.moveTo(-B * 0.68, -B * 0.14);
        ctx.lineTo(B * 0.42, -B * 0.18);
        ctx.lineTo(B * 0.46, B * 0.54);
        ctx.lineTo(-B * 0.68, B * 0.5);
        ctx.closePath();
        const hg = ctx.createLinearGradient(0, -B * 0.18, 0, B * 0.54);
        hg.addColorStop(0, GREEN);
        hg.addColorStop(1, GREEN_D);
        ctx.fillStyle = hg;
        ctx.fill();
        ctx.stroke();
        // клин-нос спереди (поджат по высоте)
        ctx.beginPath();
        ctx.moveTo(B * 0.42, -B * 0.18);
        ctx.lineTo(B * 0.92, B * 0.15);
        ctx.lineTo(B * 0.46, B * 0.54);
        ctx.closePath();
        ctx.fillStyle = GREEN;
        ctx.fill();
        ctx.stroke();
        // голубая Г-деталь: киль сзади + рейка по верху (прикрывает низ кубика)
        ctx.beginPath();
        ctx.moveTo(-B * 0.6, -B * 0.62);
        ctx.lineTo(-B * 0.42, -B * 0.62);
        ctx.lineTo(-B * 0.42, -B * 0.34);
        ctx.lineTo(B * 0.36, -B * 0.34);
        ctx.lineTo(B * 0.36, -B * 0.12);
        ctx.lineTo(-B * 0.6, -B * 0.12);
        ctx.closePath();
        const cg2 = ctx.createLinearGradient(0, -B * 0.62, 0, -B * 0.12);
        cg2.addColorStop(0, '#9ff2ff');
        cg2.addColorStop(1, CYAN);
        ctx.fillStyle = cg2;
        ctx.fill();
        ctx.stroke();
        ctx.restore();   // группа корпуса (та самая недостающая точка восстановления)
        ctx.restore();   // весь корабль (translate/rotate)
      } else { // wave — стрелка (сама волна меньше, под стать хитбоксу)
        const dir = p.grounded || p.y + B >= PHYS.ARENA_CEIL ? 0 : (p.vy > 0 ? -1 : 1);
        const ang = dir * Math.PI / 4;
        ctx.save();
        ctx.translate(pcx, pcy);
        ctx.rotate(ang);
        ctx.scale(0.67, 0.67);
        ctx.beginPath();
        ctx.moveTo(B * 0.58, 0);
        ctx.lineTo(-B * 0.52, -B * 0.34);
        ctx.lineTo(-B * 0.22, 0);
        ctx.lineTo(-B * 0.52, B * 0.34);
        ctx.closePath();
        const wg = ctx.createLinearGradient(0, -B * 0.3, 0, B * 0.3);
        wg.addColorStop(0, '#aef4ff');
        wg.addColorStop(0.5, '#2ec9f0');
        wg.addColorStop(1, '#0a7ab8');
        ctx.fillStyle = wg;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    // ===== смерть: кубик разбивается на куски =====
    if (this.deathFx) {
      const fx = this.deathFx;
      const pw = B / 3;
      const alpha = Math.max(0, 1 - Math.max(0, fx.t - 0.35) / 0.55);
      for (const pc of fx.pieces) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(this.sx(pc.x), this.sy(pc.y));
        ctx.rotate(pc.rot);
        // кусок = вырезанный фрагмент текстуры кубика
        ctx.beginPath();
        ctx.rect(-pw / 2, -pw / 2, pw, pw);
        ctx.clip();
        ctx.translate(-pc.sox, -pc.soy);
        Icons.drawFace(ctx, this.iconId, B);
        ctx.restore();
      }
    }

    ctx.restore();

    // счётчик FPS — слева сверху (по настройке)
    if (window.GW_SETTINGS && window.GW_SETTINGS.showFps && this._fps) {
      ctx.save();
      ctx.font = '700 20px system-ui, Arial, sans-serif';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.fillStyle = '#8dff6e';
      const txt = Math.round(this._fps) + ' FPS';
      ctx.strokeText(txt, 14, 12);
      ctx.fillText(txt, 14, 12);
      ctx.restore();
    }
  };

  /* ---------- экспорт ---------- */
  window.GW = {
    B, VIEW_W, VIEW_H, GROUND_SCREEN_Y, PHYS, SPEED_COLORS,
    Game, Icons, Sfx,
    renderObject, normalizeLevel,
    shade, lerpColor, hexToRgb
  };
})();
