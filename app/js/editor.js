/* ============================================================
   Geometry Web — редактор уровней (только dev.html)
   Режимы: строить / двигать (мультивыделение) / удалять.
   Undo/Redo, Copy/Paste, вкладки палитры, слайдер навигации,
   тест прямо в редакторе, группы и move-триггеры.
   ============================================================ */
(function () {
  'use strict';
  const GW = window.GW;
  const B = GW.B;
  const $ = (sel) => document.querySelector(sel);

  const canvas = $('#editor-canvas');
  if (window.GW_SETUP_HIDPI) {
    window.GW_SETUP_HIDPI(canvas);
    window.addEventListener('resize', () => window.GW_SETUP_HIDPI(canvas));
  }
  const ctx = canvas.getContext('2d');
  let W = 1280; const H = 720; // логическая высота фиксирована; ширина = ширине сцены (см. syncW)
  // ширина сцены может быть не 1280 (на не-16:9 экранах), а канвас рендерит именно
  // в логическом пространстве шириной со сцену — держим W в синхроне, иначе мышь «уедет»
  function syncW() { W = canvas.clientWidth || W; }
  const GROUND_Y = 520; // экранная линия земли в редакторе (при camY=0)

  const AUTOSAVE_KEY = 'gw_editor_autosave';
  const MUSIC_KEY = 'gw_editor_music'; // музыка хранится отдельно — не раздувает автосейв и экспорт
  const SIZE_STEPS = [0.5, 0.75, 1, 1.5, 2];

  /* ---------- состояние ---------- */
  const state = {
    level: { name: 'Мой уровень', bg: '#287dff', music: null, musicName: null, objects: [] },
    camX: -3, camY: 0,
    zoom: 0.75,
    mode: 'build',
    palTab: 0,
    tool: 'block1',
    freeMove: false,   // перемещение без привязки к сетке
    drag: null,
    hoverCell: null,
    testing: null
  };
  let selection = new Set();
  let clipboard = [];
  let history = [], redoStack = [];
  let active = false;
  let sliderActive = false;

  /* ---------- палитра ---------- */
  const CATS = [
    { name: 'Блоки', items: [
      { id: 'block1', label: 'Блок',      make: (x, y) => ({ t: 'block', x, y, style: 1 }) },
      { id: 'block2', label: 'Блок X',    make: (x, y) => ({ t: 'block', x, y, style: 2 }) },
      { id: 'block3', label: 'Блок клетка', make: (x, y) => ({ t: 'block', x, y, style: 3 }) },
      { id: 'block4', label: 'Блок панель', make: (x, y) => ({ t: 'block', x, y, style: 4 }) },
      { id: 'slope',  label: 'Горка',     make: (x, y) => ({ t: 'slope', x, y }) }
    ]},
    { name: 'Объекты', items: [
      { id: 'spike',   label: 'Шип',          make: (x, y) => ({ t: 'spike', x, y }) },
      { id: 'spike-s', label: 'Шип малый',    make: (x, y) => ({ t: 'spike', x, y, size: 0.5 }) },
      { id: 'coin',    label: 'Монета',       make: (x, y) => ({ t: 'coin', x, y }) },
      { id: 'orb-y',   label: 'Орб жёлтый',   make: (x, y) => ({ t: 'orb', x, y, kind: 'yellow' }) },
      { id: 'orb-p',   label: 'Орб розовый',  make: (x, y) => ({ t: 'orb', x, y, kind: 'pink' }) },
      { id: 'orb-b',   label: 'Орб гравитации', make: (x, y) => ({ t: 'orb', x, y, kind: 'blue' }) },
      { id: 'pad-y',   label: 'Батут жёлтый', make: (x, y) => ({ t: 'pad', x, y, kind: 'yellow' }) },
      { id: 'pad-p',   label: 'Батут розовый', make: (x, y) => ({ t: 'pad', x, y, kind: 'pink' }) },
      { id: 'pad-b',   label: 'Батут гравитации', make: (x, y) => ({ t: 'pad', x, y, kind: 'blue' }) }
    ]},
    { name: 'Порталы', items: [
      { id: 'portal-cube', label: 'Портал куб',     make: (x, y) => ({ t: 'portal', x, y, mode: 'cube' }) },
      { id: 'portal-ship', label: 'Портал корабль', make: (x, y) => ({ t: 'portal', x, y, mode: 'ship' }) },
      { id: 'portal-wave', label: 'Портал волна',   make: (x, y) => ({ t: 'portal', x, y, mode: 'wave' }) },
      { id: 'speed-08',    label: 'Скорость 0.8x',  make: (x, y) => ({ t: 'speed', x, y, mult: 0.8 }) },
      { id: 'speed-1',     label: 'Скорость 1x',    make: (x, y) => ({ t: 'speed', x, y, mult: 1 }) },
      { id: 'speed-15',    label: 'Скорость 1.5x',  make: (x, y) => ({ t: 'speed', x, y, mult: 1.5 }) },
      { id: 'speed-2',     label: 'Скорость 2x',    make: (x, y) => ({ t: 'speed', x, y, mult: 2 }) }
    ]},
    { name: 'Триггеры', items: [
      { id: 'trigger', label: 'Цвет фона',    make: (x, y) => ({ t: 'trigger', x, y, color: '#7a1fd0', dur: 1 }) },
      { id: 'move',    label: 'Move-триггер', make: (x, y) => ({ t: 'move', x, y, target: 1, dx: 0, dy: 2, dur: 1 }) },
      { id: 'start',   label: 'Старт-поза',   make: (x, y) => ({ t: 'start', x, y }) }
    ]}
  ];
  function findTool(id) {
    for (const c of CATS) for (const it of c.items) if (it.id === id) return it;
    return null;
  }

  const ROTATABLE = ['block', 'spike', 'slope'];
  const SIZABLE = ['block', 'spike', 'coin', 'orb'];
  const GROUPABLE = ['block', 'spike', 'coin', 'orb', 'pad', 'slope'];

  /* ---------- координаты ---------- */
  function px2fx(px) { return px / (B * state.zoom) + state.camX; }             // дробная координата
  function px2fy(py) { return (GROUND_Y - py) / (B * state.zoom) + state.camY; }
  function px2cellX(px) { return Math.floor(px2fx(px)); }
  function px2cellY(py) { return Math.floor(px2fy(py)); }
  function cellX2px(cx) { return (cx - state.camX) * B * state.zoom; }
  function cellY2px(cy) { return GROUND_Y - (cy - state.camY) * B * state.zoom; }
  const snap05 = (v) => Math.round(v * 20) / 20;

  function canvasPos(e) {
    const r = canvas.getBoundingClientRect();
    syncW();
    return {
      x: (e.clientX - r.left) * (W / r.width),
      y: (e.clientY - r.top) * (H / r.height)
    };
  }

  /* ---------- история ---------- */
  function snapshot() { return JSON.stringify(state.level.objects); }
  function pushHistory(snap) {
    history.push(snap != null ? snap : snapshot());
    if (history.length > 60) history.shift();
    redoStack.length = 0;
    updateStackBtns();
  }
  function doUndo() {
    if (!history.length) return;
    redoStack.push(snapshot());
    state.level.objects = JSON.parse(history.pop());
    selection.clear();
    markDirty(); updateStackBtns(); updateInspector();
  }
  function doRedo() {
    if (!redoStack.length) return;
    history.push(snapshot());
    state.level.objects = JSON.parse(redoStack.pop());
    selection.clear();
    markDirty(); updateStackBtns(); updateInspector();
  }
  function updateStackBtns() {
    $('#ed-undo').disabled = !history.length;
    $('#ed-redo').disabled = !redoStack.length;
    $('#ed-paste').disabled = !clipboard.length;
    $('#ed-copy').disabled = !selection.size;
  }

  /* ---------- операции ---------- */
  // fx, fy — дробные координаты точки (поддержка объектов вне сетки)
  function objAt(fx, fy) {
    for (let i = state.level.objects.length - 1; i >= 0; i--) {
      const o = state.level.objects[i];
      const h = o.t === 'portal' ? 3 : 1;
      if (fx >= o.x && fx < o.x + 1 && fy >= o.y && fy < o.y + h) return o;
    }
    return null;
  }

  function placeAt(px, py) {
    const def = findTool(state.tool);
    if (!def) return;
    let x, y;
    if (state.freeMove) {
      x = Math.max(0, snap05(px2fx(px) - 0.5));
      y = Math.max(0, snap05(px2fy(py) - 0.5));
      if (objAt(x + 0.5, y + 0.5)) return;
    } else {
      x = px2cellX(px); y = px2cellY(py);
      if (x < 0 || y < 0) return;
      if (objAt(x + 0.5, y + 0.5)) return;
    }
    state.level.objects.push(def.make(x, y));
    if (state.drag) state.drag.changed = true;
    markDirty();
  }

  function deleteAt(px, py) {
    const o = objAt(px2fx(px), px2fy(py));
    if (o) {
      state.level.objects.splice(state.level.objects.indexOf(o), 1);
      selection.delete(o);
      if (state.drag) state.drag.changed = true;
      markDirty(); updateInspector();
    }
  }

  function deleteSelection() {
    if (!selection.size) return;
    pushHistory();
    state.level.objects = state.level.objects.filter(o => !selection.has(o));
    selection.clear();
    markDirty(); updateInspector();
  }

  function doCopy() {
    if (!selection.size) return;
    const sel = [...selection];
    const minX = Math.min(...sel.map(o => o.x));
    clipboard = sel.map(o => {
      const c = JSON.parse(JSON.stringify(o));
      c.x -= minX;
      return c;
    });
    updateStackBtns();
    window.GW_APP.toast('Скопировано: ' + clipboard.length);
  }

  function doPaste() {
    if (!clipboard.length) return;
    pushHistory();
    const baseX = state.hoverCell ? Math.max(0, state.hoverCell[0]) : Math.max(0, Math.floor(state.camX) + 6);
    const objs = clipboard.map(c => {
      const o = JSON.parse(JSON.stringify(c));
      o.x += baseX;
      return o;
    });
    state.level.objects.push(...objs);
    selection = new Set(objs);
    setMode('edit');
    markDirty(); updateInspector();
  }

  function markDirty() {
    clearTimeout(markDirty._tm);
    markDirty._tm = setTimeout(autosave, 800);
  }

  /* ---------- автосохранение ---------- */
  function autosave() {
    try {
      // уровень сохраняется без музыки — иначе каждая правка гоняет мегабайты
      const copy = Object.assign({}, state.level, { music: null });
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(copy));
    } catch (e) { /* ну и ладно */ }
  }
  function saveMusic() {
    try {
      if (state.level.music) localStorage.setItem(MUSIC_KEY, state.level.music);
      else localStorage.removeItem(MUSIC_KEY);
    } catch (e) {
      window.GW_APP.toast('Музыка слишком большая для черновика — добавь её заново после перезагрузки');
    }
  }
  function loadAutosave() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) {
        const lvl = JSON.parse(raw);
        if (lvl && Array.isArray(lvl.objects)) {
          state.level = lvl;
          const m = localStorage.getItem(MUSIC_KEY);
          if (m) state.level.music = m;
          return true;
        }
      }
    } catch (e) { /* игнор */ }
    return false;
  }

  /* ---------- отрисовка ---------- */
  function render() {
    if (state.testing) return;
    syncW();
    const z = state.zoom, cs = B * z;
    const bg = state.level.bg || '#287dff';

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, GW.shade(bg, 0.1));
    grad.addColorStop(1, GW.shade(bg, -0.25));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    const groundPy = cellY2px(0);

    ctx.fillStyle = GW.shade(bg, -0.5);
    ctx.fillRect(0, groundPy, W, H - groundPy);
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.fillRect(0, groundPy - 2, W, 4);

    // сетка
    ctx.strokeStyle = 'rgba(255,255,255,.13)';
    ctx.lineWidth = 1;
    const startCX = Math.floor(state.camX), endCX = startCX + Math.ceil(W / cs) + 1;
    for (let cx = startCX; cx <= endCX; cx++) {
      const x = cellX2px(cx);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, groundPy); ctx.stroke();
    }
    for (let cy = Math.max(0, Math.floor(state.camY)); ; cy++) {
      const y = cellY2px(cy);
      if (y < 116) break;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // старт игрока
    const zeroX = cellX2px(0);
    if (zeroX > -60 && zeroX < W + 60) {
      ctx.save();
      ctx.strokeStyle = 'rgba(120,255,120,.8)';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 8]);
      ctx.beginPath(); ctx.moveTo(zeroX, 0); ctx.lineTo(zeroX, groundPy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(120,255,120,.9)';
      ctx.strokeRect(zeroX, groundPy - cs, cs, cs);
      ctx.font = '900 15px "Arial Black", Arial';
      ctx.fillStyle = 'rgba(120,255,120,.9)';
      ctx.fillText('СТАРТ', zeroX + 6, groundPy + 24); // под линией земли, не наезжает на статус
      ctx.restore();
    }

    // объекты
    for (const obj of state.level.objects) {
      const x = cellX2px(obj.x), y = cellY2px(obj.y);
      if (x < -3 * cs || x > W + 3 * cs) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(z, z);
      GW.renderObject(ctx, obj, { editor: true, static: true });
      ctx.restore();
      if (selection.has(obj)) {
        const h = obj.t === 'portal' ? 3 : 1;
        ctx.save();
        ctx.strokeStyle = '#7dff00';
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(x - 2, y - h * cs - 2, cs + 4, h * cs + 4);
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // призрак объекта под курсором (в свободном режиме — без сетки)
    if (state.hoverCell && state.mode === 'build' && !state.drag) {
      let gx = state.hoverCell[0], gy = state.hoverCell[1];
      if (state.freeMove && state.hoverPx) {
        gx = Math.max(0, snap05(px2fx(state.hoverPx[0]) - 0.5));
        gy = Math.max(0, snap05(px2fy(state.hoverPx[1]) - 0.5));
      }
      if (gy >= 0 && gx >= 0 && cellY2px(gy) > 116) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.translate(cellX2px(gx), cellY2px(gy));
        ctx.scale(z, z);
        const def = findTool(state.tool);
        if (def) GW.renderObject(ctx, def.make(gx, gy), { editor: true, static: true });
        ctx.restore();
      }
    }

    // рамка выделения
    if (state.drag && state.drag.band) {
      const d = state.drag;
      ctx.save();
      ctx.strokeStyle = '#7dff00';
      ctx.fillStyle = 'rgba(125,255,0,.12)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
      const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.restore();
    }

    // статус
    const hints = {
      build: 'ЛКМ — поставить · ПКМ — прокрутка · Ctrl+колесо — зум',
      edit: 'ЛКМ — выбрать/тащить · рамка по пустому — выделить · Shift+ЛКМ — добавить',
      delete: 'ЛКМ — удалить объект'
    };
    $('#ed-status').textContent =
      'Объектов: ' + state.level.objects.length +
      (selection.size ? ' · Выбрано: ' + selection.size : '') +
      (state.hoverCell ? ' · Клетка: ' + state.hoverCell[0] + ',' + state.hoverCell[1] : '') +
      ' · Зум: ' + Math.round(state.zoom * 100) + '% · ' + hints[state.mode];

    // слайдер
    if (!sliderActive) {
      let maxX = 60;
      state.level.objects.forEach(o => { if (o.x > maxX) maxX = o.x; });
      const slider = $('#ed-slider');
      slider.max = maxX + 30;
      slider.value = Math.round(state.camX);
    }

    requestAnimationFrame(() => { if (active && !state.testing) render(); });
  }

  /* ---------- ввод мыши ---------- */
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (state.testing) return;
    const pos = canvasPos(e);

    if (e.button === 2 || e.button === 1) {
      state.drag = { pan: true, startX: pos.x, startY: pos.y, camX: state.camX, camY: state.camY };
      return;
    }

    if (state.mode === 'build') {
      state.drag = { paint: true, snap: snapshot(), changed: false };
      placeAt(pos.x, pos.y);
    } else if (state.mode === 'delete') {
      state.drag = { erase: true, snap: snapshot(), changed: false };
      deleteAt(pos.x, pos.y);
    } else if (state.mode === 'edit') {
      const o = objAt(px2fx(pos.x), px2fy(pos.y));
      if (o) {
        if (e.shiftKey) {
          if (selection.has(o)) selection.delete(o); else selection.add(o);
        } else if (!selection.has(o)) {
          selection = new Set([o]);
        }
        state.drag = {
          move: true,
          lastCX: px2cellX(pos.x), lastCY: px2cellY(pos.y),
          lastFX: px2fx(pos.x), lastFY: px2fy(pos.y),
          snap: snapshot(), changed: false
        };
        updateInspector();
      } else {
        if (!e.shiftKey) { selection.clear(); updateInspector(); }
        state.drag = { band: true, x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y, add: e.shiftKey };
      }
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (state.testing) return;
    const pos = canvasPos(e);
    state.hoverCell = [px2cellX(pos.x), px2cellY(pos.y)];
    state.hoverPx = [pos.x, pos.y];

    const d = state.drag;
    if (!d) return;
    if (d.pan) {
      state.camX = d.camX - (pos.x - d.startX) / (B * state.zoom);
      state.camY = d.camY + (pos.y - d.startY) / (B * state.zoom);
      if (state.camY < 0) state.camY = 0;
      if (state.camX < -8) state.camX = -8;
    } else if (d.paint) {
      placeAt(pos.x, pos.y);
    } else if (d.erase) {
      deleteAt(pos.x, pos.y);
    } else if (d.move) {
      const sel = [...selection];
      if (state.freeMove) {
        // свободное перемещение: без привязки к клеткам
        const fx = px2fx(pos.x), fy = px2fy(pos.y);
        const dx = fx - d.lastFX, dy = fy - d.lastFY;
        const okX = sel.every(o => o.x + dx >= 0);
        const okY = sel.every(o => o.y + dy >= 0);
        sel.forEach(o => {
          if (okX) o.x = snap05(o.x + dx);
          if (okY) o.y = snap05(o.y + dy);
        });
        if (okX) d.lastFX = fx;
        if (okY) d.lastFY = fy;
        if ((okX && Math.abs(dx) > 0.001) || (okY && Math.abs(dy) > 0.001)) {
          d.changed = true; markDirty(); updateInspector();
        }
      } else {
        const cx = px2cellX(pos.x), cy = px2cellY(pos.y);
        const dx = cx - d.lastCX, dy = cy - d.lastCY;
        if (dx || dy) {
          const okX = sel.every(o => o.x + dx >= 0);
          const okY = sel.every(o => o.y + dy >= 0);
          sel.forEach(o => {
            if (okX) o.x += dx;
            if (okY) o.y += dy;
          });
          if (okX) d.lastCX = cx;
          if (okY) d.lastCY = cy;
          if (okX || okY) { d.changed = true; markDirty(); updateInspector(); }
        }
      }
    } else if (d.band) {
      d.x1 = pos.x; d.y1 = pos.y;
    }
  });

  window.addEventListener('pointerup', () => {
    const d = state.drag;
    if (!d) return;
    if (d.band) {
      // выделяем объекты в рамке
      const cs = B * state.zoom;
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
      const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      const picked = state.level.objects.filter(o => {
        const h = o.t === 'portal' ? 3 : 1;
        const ox0 = cellX2px(o.x), oy1 = cellY2px(o.y), oy0 = oy1 - h * cs, ox1 = ox0 + cs;
        return ox1 > x0 && ox0 < x1 && oy1 > y0 && oy0 < y1;
      });
      if (d.add) picked.forEach(o => selection.add(o));
      else selection = new Set(picked);
      updateInspector();
    }
    if ((d.paint || d.erase || d.move) && d.changed && d.snap != null) {
      pushHistory(d.snap);
    }
    state.drag = null;
    updateStackBtns();
  });

  canvas.addEventListener('wheel', (e) => {
    if (state.testing) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const nz = Math.max(0.35, Math.min(2, state.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      state.zoom = nz;
    } else {
      state.camX += (e.deltaY + e.deltaX) / (B * state.zoom) * 0.9;
      if (state.camX < -8) state.camX = -8;
    }
  }, { passive: false });

  /* ---------- клавиатура ---------- */
  window.addEventListener('keydown', (e) => {
    if (!active && !state.testing) return;
    if (state.testing) {
      if (e.code === 'Escape') { e.preventDefault(); stopTest(); }
      return;
    }
    if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    const ctrlKey = e.ctrlKey || e.metaKey;
    if (ctrlKey && e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
    if (ctrlKey && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
    if (ctrlKey && e.code === 'KeyC') { e.preventDefault(); doCopy(); return; }
    if (ctrlKey && e.code === 'KeyV') { e.preventDefault(); doPaste(); return; }
    if (e.code === 'KeyR' && selection.size) { e.preventDefault(); rotateSelection(90); return; }

    if (state.mode === 'edit' && selection.size) {
      let dx = 0, dy = 0;
      if (e.code === 'ArrowLeft') dx = -1;
      else if (e.code === 'ArrowRight') dx = 1;
      else if (e.code === 'ArrowUp') dy = 1;
      else if (e.code === 'ArrowDown') dy = -1;
      else if (e.code === 'Delete' || e.code === 'Backspace') {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (dx || dy) {
        e.preventDefault();
        const step = state.freeMove ? 0.2 : 1;
        dx *= step; dy *= step;
        const sel = [...selection];
        if (sel.every(o => o.x + dx >= 0 && o.y + dy >= 0)) {
          pushHistory();
          sel.forEach(o => { o.x = snap05(o.x + dx); o.y = snap05(o.y + dy); });
          markDirty(); updateInspector();
        }
      }
    }
  });

  /* ---------- режимы и палитра ---------- */
  function setMode(m) {
    state.mode = m;
    document.querySelectorAll('.ed-tab').forEach(t => t.classList.toggle('on', t.dataset.mode === m));
    $('#ed-pal-wrap').style.display = m === 'build' ? 'flex' : 'none';
    const hint = $('#ed-hint');
    hint.style.display = m === 'build' ? 'none' : 'flex';
    hint.textContent = m === 'edit'
      ? 'Режим «Двигать»: ЛКМ — выбрать и тащить, рамка по пустому месту — выделить несколько, Shift — добавить к выделению, Delete — удалить, R — повернуть.'
      : 'Режим «Удалять»: кликай по объектам, чтобы удалить их. Зажми и веди — удалять подряд.';
    if (m !== 'edit') { selection.clear(); }
    updateInspector();
  }
  document.querySelectorAll('.ed-tab').forEach(tab => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
  });

  function buildPalette() {
    const tabs = $('#ed-pal-tabs');
    tabs.innerHTML = '';
    CATS.forEach((cat, i) => {
      const b = document.createElement('button');
      b.className = 'pal-tab' + (state.palTab === i ? ' on' : '');
      b.textContent = cat.name;
      b.addEventListener('click', () => { state.palTab = i; buildPalette(); });
      tabs.appendChild(b);
    });
    const pal = $('#ed-palette');
    pal.innerHTML = '';
    CATS[state.palTab].items.forEach(def => {
      const item = document.createElement('div');
      item.className = 'pal-item' + (state.tool === def.id ? ' on' : '');
      const cv = document.createElement('canvas');
      cv.width = cv.height = 46;
      const c = cv.getContext('2d');
      c.save();
      const obj = def.make(0, 0);
      const scale = obj.t === 'portal' ? 0.23 : 0.68;
      c.translate((46 - B * scale) / 2, obj.t === 'portal' ? 44 : (46 + B * scale) / 2);
      c.scale(scale, scale);
      GW.renderObject(c, obj, { editor: true, static: true });
      c.restore();
      const span = document.createElement('span');
      span.textContent = def.label;
      item.appendChild(cv);
      item.appendChild(span);
      item.addEventListener('click', () => {
        state.tool = def.id;
        setMode('build');
        buildPalette();
      });
      pal.appendChild(item);
    });
  }

  /* ---------- инспектор ---------- */
  const TYPE_NAMES = {
    block: 'Блок', spike: 'Шип', coin: 'Монета', portal: 'Портал',
    trigger: 'Триггер цвета', move: 'Move-триггер', orb: 'Орб', pad: 'Батут',
    speed: 'Ускорение', start: 'Старт-поза', slope: 'Горка'
  };

  function updateInspector() {
    const insp = $('#ed-inspector');
    const sel = [...selection];
    if (!sel.length || state.mode !== 'edit') {
      insp.classList.remove('show');
      updateStackBtns();
      return;
    }
    insp.classList.add('show');
    const single = sel.length === 1 ? sel[0] : null;

    $('#insp-title').textContent = single ? (TYPE_NAMES[single.t] || single.t) : ('Выбрано: ' + sel.length);
    $('#insp-pos').textContent = single ? ('Клетка: ' + single.x + ', ' + single.y) : '';

    const canRot = sel.some(o => ROTATABLE.includes(o.t));
    const canSize = sel.some(o => SIZABLE.includes(o.t));
    const canGroup = sel.some(o => GROUPABLE.includes(o.t));
    $('#insp-rot-row').style.display = canRot ? 'flex' : 'none';
    $('#insp-size-row').style.display = canSize ? 'flex' : 'none';
    $('#insp-group-row').style.display = canGroup ? 'flex' : 'none';
    if (canRot) $('#insp-rot-val').textContent = (single && (single.rot || 0)) + '°';
    if (!single) $('#insp-rot-val').textContent = '';
    if (canSize) $('#insp-size-val').textContent = single ? String(single.size || 1) : '±';
    if (canGroup) $('#insp-group').value = single ? (single.group || 0) : '';

    const isTrig = single && single.t === 'trigger';
    $('#insp-color-row').style.display = isTrig ? 'flex' : 'none';
    $('#insp-dur-row').style.display = isTrig ? 'flex' : 'none';
    if (isTrig) {
      $('#insp-color').value = single.color;
      $('#insp-dur').value = single.dur;
    }

    const isMove = single && single.t === 'move';
    $('#insp-move-rows').style.display = isMove ? 'block' : 'none';
    if (isMove) {
      $('#insp-target').value = single.target;
      $('#insp-dx').value = single.dx;
      $('#insp-dy').value = single.dy;
      $('#insp-mdur').value = single.dur;
    }
    updateStackBtns();
  }

  function rotateSelection(delta) {
    const sel = [...selection];
    if (!sel.length) return;
    if (sel.length > 1) {
      // группа вращается ВОКРУГ ОБЩЕГО ЦЕНТРА, а не каждый вокруг себя
      pushHistory();
      const hOf = (o) => o.t === 'portal' ? 3 : 1;
      const minX = Math.min(...sel.map(o => o.x));
      const maxX = Math.max(...sel.map(o => o.x + 1));
      const minY = Math.min(...sel.map(o => o.y));
      const maxY = Math.max(...sel.map(o => o.y + hOf(o)));
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const cw = delta > 0;
      sel.forEach(o => {
        const h = hOf(o);
        const ox = o.x + 0.5, oy = o.y + h / 2;
        const rx = ox - cx, ry = oy - cy;
        const nx = cw ? (cx + ry) : (cx - ry);
        const ny = cw ? (cy - rx) : (cy + rx);
        o.x = Math.max(0, nx - 0.5);
        o.y = Math.max(0, ny - h / 2);
        if (state.freeMove) { o.x = snap05(o.x); o.y = snap05(o.y); }
        else { o.x = Math.round(o.x); o.y = Math.round(o.y); }
        if (ROTATABLE.includes(o.t)) o.rot = (((o.rot || 0) + delta) % 360 + 360) % 360;
      });
      markDirty(); updateInspector();
      return;
    }
    const rotObjs = sel.filter(o => ROTATABLE.includes(o.t));
    if (!rotObjs.length) return;
    pushHistory();
    rotObjs.forEach(o => { o.rot = (((o.rot || 0) + delta) % 360 + 360) % 360; });
    markDirty(); updateInspector();
  }

  function resizeSelection(dir) {
    const sel = [...selection].filter(o => SIZABLE.includes(o.t));
    if (!sel.length) return;
    pushHistory();
    sel.forEach(o => {
      const cur = o.size || 1;
      let idx = SIZE_STEPS.findIndex(s => Math.abs(s - cur) < 0.01);
      if (idx === -1) idx = 2;
      idx = Math.max(0, Math.min(SIZE_STEPS.length - 1, idx + dir));
      const ns = SIZE_STEPS[idx];
      if (ns === 1) delete o.size; else o.size = ns;
    });
    markDirty(); updateInspector();
  }

  $('#insp-rotl').addEventListener('click', () => rotateSelection(-90));
  $('#insp-rotr').addEventListener('click', () => rotateSelection(90));
  $('#insp-sizedn').addEventListener('click', () => resizeSelection(-1));
  $('#insp-sizeup').addEventListener('click', () => resizeSelection(1));
  $('#insp-del').addEventListener('click', deleteSelection);

  $('#insp-group').addEventListener('change', (e) => {
    const g = Math.max(0, Math.min(99, Math.round(+e.target.value) || 0));
    const sel = [...selection].filter(o => GROUPABLE.includes(o.t));
    if (!sel.length) return;
    pushHistory();
    sel.forEach(o => { if (g) o.group = g; else delete o.group; });
    markDirty(); updateInspector();
  });
  $('#insp-color').addEventListener('input', (e) => {
    const o = [...selection][0];
    if (o && o.t === 'trigger') { o.color = e.target.value; markDirty(); }
  });
  $('#insp-dur').addEventListener('change', (e) => {
    const o = [...selection][0];
    if (o && o.t === 'trigger') {
      const v = parseFloat(String(e.target.value).replace(',', '.'));
      o.dur = isFinite(v) ? Math.max(0, Math.min(10, v)) : 1;
      e.target.value = o.dur;
      markDirty();
    }
  });
  $('#insp-target').addEventListener('change', (e) => {
    const o = [...selection][0];
    if (o && o.t === 'move') { o.target = Math.max(1, Math.min(99, Math.round(+e.target.value) || 1)); markDirty(); }
  });
  $('#insp-dx').addEventListener('change', (e) => {
    const o = [...selection][0];
    if (o && o.t === 'move') { o.dx = Math.max(-200, Math.min(200, +e.target.value || 0)); markDirty(); }
  });
  $('#insp-dy').addEventListener('change', (e) => {
    const o = [...selection][0];
    if (o && o.t === 'move') { o.dy = Math.max(-200, Math.min(200, +e.target.value || 0)); markDirty(); }
  });
  $('#insp-mdur').addEventListener('change', (e) => {
    const o = [...selection][0];
    if (o && o.t === 'move') { o.dur = Math.max(0, Math.min(10, +e.target.value || 0)); markDirty(); }
  });

  /* ---------- левая стопка ---------- */
  $('#ed-undo').addEventListener('click', doUndo);
  $('#ed-redo').addEventListener('click', doRedo);
  $('#ed-copy').addEventListener('click', doCopy);
  $('#ed-paste').addEventListener('click', doPaste);

  /* ---------- слайдер навигации ---------- */
  const slider = $('#ed-slider');
  slider.addEventListener('pointerdown', () => { sliderActive = true; });
  window.addEventListener('pointerup', () => { sliderActive = false; });
  slider.addEventListener('input', () => {
    state.camX = +slider.value;
  });

  /* ---------- тест прямо в редакторе ---------- */
  function startTest() {
    if (state.testing) return;
    autosave();
    if (!state.level.objects.length) {
      window.GW_APP.toast('Сначала поставь хотя бы один объект!');
      return;
    }
    // старт: ближайшая к центру камеры старт-поза, иначе — левый край экрана
    let sx = Math.max(-6, Math.floor(state.camX)), sy = 0;
    const starts = state.level.objects.filter(o => o.t === 'start');
    if (starts.length) {
      const camC = state.camX + W / (B * state.zoom) / 2;
      let best = starts[0], bd = Infinity;
      for (const s of starts) {
        const d = Math.abs(s.x - camC);
        if (d < bd) { bd = d; best = s; }
      }
      sx = best.x; sy = best.y;
    }
    const lvl = JSON.parse(JSON.stringify(state.level));
    active = false;
    const g = new GW.Game(canvas, {});
    state.testing = g;
    $('#screen-editor').classList.add('testing');
    g.setIcon(window.GW_APP.save.icon);
    g.setLevel(lvl, [], sx * B, sy * B);
    g.attempts = 0;
    g.resetAttempt(true);
    g.start();
  }
  function stopTest() {
    if (!state.testing) return;
    state.testing.destroy();
    state.testing = null;
    $('#screen-editor').classList.remove('testing');
    active = true;
    render();
  }
  $('#ed-testplay').addEventListener('click', startTest);
  $('#ed-teststop').addEventListener('click', stopTest);

  // свернул вкладку во время теста — пауза, вернулся — продолжаем
  document.addEventListener('visibilitychange', () => {
    if (!state.testing) return;
    state.testing.setPaused(document.hidden);
  });

  /* ---------- верхняя панель ---------- */
  $('#ed-name').addEventListener('input', (e) => {
    state.level.name = e.target.value || 'Без названия';
    markDirty();
  });
  $('#ed-bgcolor').addEventListener('input', (e) => {
    state.level.bg = e.target.value;
    markDirty();
  });

  $('#ed-music').addEventListener('click', () => $('#ed-music-file').click());
  $('#ed-music-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.level.music = reader.result;
      state.level.musicName = f.name.replace(/\.[^.]+$/, '');
      $('#ed-music-name').textContent = f.name;
      saveMusic();
      markDirty();
      window.GW_APP.toast('Музыка добавлена: ' + f.name + ' (в экспорт не вшивается — передай mp3 отдельно)');
    };
    reader.readAsDataURL(f);
    e.target.value = '';
  });

  $('#ed-play').addEventListener('click', () => {
    autosave();
    if (!state.level.objects.length) {
      window.GW_APP.toast('Сначала поставь хотя бы один объект!');
      return;
    }
    window.GW_APP.playLevel(JSON.parse(JSON.stringify(state.level)), { fromEditor: true });
  });

  $('#ed-save').addEventListener('click', () => {
    autosave();
    window.GW_APP.toast('Сохранено в браузере ✓');
  });

  $('#ed-export').addEventListener('click', () => {
    autosave();
    // музыка НЕ вшивается в файл (раньше из-за неё экспорт весил мегабайты) —
    // остаётся только имя, сам файл музыки передаётся отдельно
    const data = JSON.stringify(Object.assign({ format: 'gw-level@2' }, state.level, { music: null }));
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const safe = (state.level.name || 'level').replace(/[^\wа-яА-ЯёЁ -]/g, '').trim() || 'level';
    a.download = safe + '.gwlevel.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    window.GW_APP.toast('Экспортировано: ' + a.download + (state.level.musicName ? ' (музыку «' + state.level.musicName + '» передай отдельным файлом)' : ''), 3500);
  });

  $('#ed-import').addEventListener('click', () => $('#ed-import-file').click());
  $('#ed-import-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const lvl = JSON.parse(reader.result);
        if (!lvl || !Array.isArray(lvl.objects)) throw new Error('bad');
        pushHistory();
        state.level = {
          name: lvl.name || 'Импортированный',
          bg: lvl.bg || '#287dff',
          music: lvl.music || null,
          musicName: lvl.musicName || null,
          objects: lvl.objects
        };
        if (state.level.music) saveMusic(); // старые файлы со вшитой музыкой
        syncTopbar();
        selection.clear();
        markDirty(); updateInspector();
        window.GW_APP.toast('Уровень загружен: ' + state.level.name);
      } catch (err) {
        window.GW_APP.toast('Не удалось прочитать файл уровня');
      }
    };
    reader.readAsText(f);
    e.target.value = '';
  });

  // сетка вкл/выкл (свободное перемещение)
  const gridBtn = $('#ed-grid');
  if (gridBtn) gridBtn.addEventListener('click', () => {
    state.freeMove = !state.freeMove;
    gridBtn.textContent = state.freeMove ? 'Сетка: выкл' : 'Сетка: вкл';
    gridBtn.classList.toggle('active-tool', state.freeMove);
    window.GW_APP.toast(state.freeMove
      ? 'Свободное перемещение: объекты ставятся и тащатся куда угодно'
      : 'Привязка к сетке включена');
  });

  $('#ed-clear').addEventListener('click', () => {
    if (confirm('Удалить все объекты уровня?')) {
      pushHistory();
      state.level.objects = [];
      selection.clear();
      markDirty(); updateInspector();
    }
  });

  $('#ed-back').addEventListener('click', () => {
    stopTest();
    autosave();
    active = false;
    window.GW_APP.fadeTo('lobby');
  });

  function syncTopbar() {
    $('#ed-name').value = state.level.name;
    $('#ed-bgcolor').value = state.level.bg;
    $('#ed-music-name').textContent = state.level.musicName ? (state.level.musicName + ' ✓') : 'нет музыки';
  }

  /* ---------- вход ---------- */
  function openEditor() {
    active = true;
    syncTopbar();
    buildPalette();
    setMode('build');
    updateStackBtns();
    window.GW_APP.fadeTo('editor', () => render());
  }

  window.GW_EDITOR = {
    open: openEditor,
    onReturn() { active = true; render(); },
    get state() { return state; },
    undo: doUndo, redo: doRedo, copy: doCopy, paste: doPaste,
    startTest, stopTest
  };

  loadAutosave();

  const btn = $('#btn-editor');
  if (btn) btn.addEventListener('click', openEditor);
})();
