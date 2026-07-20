/* Проверочный прогон: грузит игру, ловит ошибки консоли, снимает кадр.
   Запуск: npx electron electron/verify.js            (лобби)
           npx electron electron/verify.js editor     (экран редактора) */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const serve = require('./serve');

const { SCHEME } = serve;
const SHOT_DIR = process.env.GJ_SHOT_DIR || path.join(__dirname, '..', 'dist-verify');
const MODE = process.argv[2] || 'lobby';

serve.registerPrivileges();

const problems = [];

app.whenReady().then(async () => {
  serve.install();

  const win = new BrowserWindow({
    width: 1280, height: 760, show: false,
    // backgroundThrottling: скрытое окно Chromium душит до пары кадров в секунду,
    // и анимации (частицы, воронки) просто не успевают появиться к снимку
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false
    }
  });

  const consoleLog = [];
  win.webContents.on('console-message', (event) => {
    const line = `[${event.level}] ${event.message}`;
    consoleLog.push(line);
    if (event.level === 'error' || event.level === 'warning') problems.push('console: ' + event.message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    problems.push(`did-fail-load ${code} ${desc} ${url}`);
  });
  win.webContents.session.webRequest.onCompleted((details) => {
    if (details.statusCode >= 400) problems.push(`HTTP ${details.statusCode} ${details.url}`);
  });

  // экспорт: перехватываем скачивание, чтобы проверить содержимое файла
  let exported = null;
  if (MODE === 'export') {
    win.webContents.session.on('will-download', (_e, item) => {
      const dest = path.join(SHOT_DIR, item.getFilename());
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      item.setSavePath(dest);
      item.once('done', (_ev, st) => { exported = { dest, state: st }; });
    });
  }

  await win.loadURL(`${SCHEME}://game/dev.html`);
  await new Promise((r) => setTimeout(r, 2500));

  if (MODE === 'editor' || MODE === 'export') {
    await win.webContents.executeJavaScript(`document.querySelector('#btn-editor').click()`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (MODE === 'export') {
    await win.webContents.executeJavaScript(`document.querySelector('#ed-export').click()`);
    await new Promise((r) => setTimeout(r, 2500));
  }

  // витрина орбов: все четыре вида рядом, чтобы разглядеть воронку и стрелки dash
  if (MODE === 'orbs') {
    // без блоков: земля в движке своя, а блоки на y=0 — это стена,
    // в которую игрок влетает и умирает, гася все частицы
    const level = {
      name: 'orbs', bg: '#101a2e', difficulty: 'easy',
      objects: [
        { t: 'orb', x: 9, y: 4, kind: 'yellow' },
        { t: 'orb', x: 13, y: 4, kind: 'pink' },
        { t: 'orb', x: 17, y: 4, kind: 'blue' },
        { t: 'orb', x: 21, y: 4, kind: 'dash' }
      ]
    };
    await win.webContents.executeJavaScript(`(() => {
      window.GW_APP.playLevel(${JSON.stringify(level)});
      return 'ok';
    })()`);
    await new Promise((r) => setTimeout(r, 1300)); // камера доезжает до орбов, воронки успевают набраться

    const st = await win.webContents.executeJavaScript(`(() => {
      const g = window.GW_APP.game;
      return JSON.stringify({ жив: !g.p.dead, воронок: g.particles.filter(p => p.vortex).length });
    })()`);
    console.log('=== ORBS ===');
    console.log(st);
    if (JSON.parse(st).воронок === 0) problems.push('воронка у орбов не появилась');
    if (!JSON.parse(st).жив) problems.push('игрок умер в витрине орбов — кадр будет пустым');
  }

  // dash-орб: при зажатой кнопке игрок должен лететь ровно по линии орба,
  // а после отпускания — падать
  let dash = null;
  if (MODE === 'dash') {
    // высота 1 клетка: прыжок поднимает центр куба максимум на ~127 px,
    // выше орб просто недостижим — радиус срабатывания всего 45 px.
    // Орбы подряд — чтобы попадание не зависело от фазы прыжка.
    const level = {
      name: 'dash', bg: '#101a2e',
      objects: [5, 6, 7, 8, 9, 10, 11].map((x) => ({ t: 'orb', x, y: 1, kind: 'dash' }))
    };
    await win.webContents.executeJavaScript(
      `(() => { window.GW_APP.playLevel(${JSON.stringify(level)}); return 'ok'; })()`);
    // ждём затемнение: до старта уровня game.running === false,
    // и обработчик клавиш выходит сразу, не выставив hold
    await new Promise((r) => setTimeout(r, 900));

    // событие шлём внутри страницы: движок слушает keydown/keyup на window
    // (engine.js:609), а sendInputEvent до скрытого несфокусированного окна не доходит.
    // Писать в game.hold напрямую бесполезно — обработчик ввода его перетирает.
    const key = (type) => `window.dispatchEvent(new KeyboardEvent('${type}', { code: 'Space', key: ' ', bubbles: true }));`;
    const holdKey = (down) => win.webContents.executeJavaScript(
      `(() => { ${key(down ? 'keydown' : 'keyup')} return 'ok'; })()`);
    // «тап»: орб требует свежего нажатия (_pressBuf), а при зажатой кнопке куб
    // сразу прыгает и обнуляет буфер — удержанием орб не поймать.
    // keyup и keydown в одном синхронном вызове: кадр физики между ними не проскочит,
    // поэтому уже начавшийся рывок не оборвётся.
    const tap = () => win.webContents.executeJavaScript(
      `(() => { ${key('keyup')} ${key('keydown')} return 'ok'; })()`);
    await holdKey(true);

    const sample = `(() => {
      const g = window.GW_APP.game;
      return { dash: !!g.p.dash, y: Math.round(g.p.y), vy: Math.round(g.p.vy), мертв: !!g.p.dead, hold: !!g.hold };
    })()`;

    let inDash = null;
    for (let i = 0; i < 40 && !inDash; i++) {
      await new Promise((r) => setTimeout(r, 60));
      await tap();
      const s = await win.webContents.executeJavaScript(sample);
      if (s.dash) inDash = s;
    }

    // после входа игрок плавно выходит на линию орба, поэтому сравниваем
    // два замера уже ПОСЛЕ выхода — там высота обязана стоять намертво
    let settled = null, flat = null, afterRelease = null;
    if (inDash) {
      await new Promise((r) => setTimeout(r, 350));
      settled = await win.webContents.executeJavaScript(sample);
      await new Promise((r) => setTimeout(r, 300));
      flat = await win.webContents.executeJavaScript(sample);
      // отдельный кадр прямо в рывке: на итоговом снимке огня уже не будет
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(SHOT_DIR, 'dash-active.png'), (await win.capturePage()).toPNG());
      await holdKey(false); // отпускаем — рывок обязан прекратиться
      await new Promise((r) => setTimeout(r, 350));
      afterRelease = await win.webContents.executeJavaScript(sample);
    } else {
      await holdKey(false);
    }

    dash = { вошёл_в_рывок: inDash, вышел_на_линию: settled, ещё_через_0_3с: flat, после_отпускания: afterRelease };
    if (!inDash) problems.push('dash-орб не сработал: игрок не вошёл в рывок');
    else if (!settled || !settled.dash) problems.push('рывок оборвался сам, хотя кнопку держат');
    else if (flat && Math.abs(flat.y - settled.y) > 2) problems.push(`в рывке высота плывёт: y ${settled.y} -> ${flat.y}`);
    else if (flat && flat.vy !== 0) problems.push(`в рывке осталась вертикальная скорость: vy ${flat.vy}`);
    else if (afterRelease && afterRelease.dash) problems.push('рывок не прекратился после отпускания кнопки');
    // проверяем снижение, а не vy: с высоты 60 px падение занимает ~0,15 с,
    // и к замеру игрок уже стоит на земле с обнулённой скоростью
    else if (afterRelease && !(afterRelease.y < flat.y)) problems.push(`после отпускания игрок не пошёл вниз: y ${flat.y} -> ${afterRelease.y}`);
  }

  // реальный прогон уровня: игрок должен проехать вперёд сам по себе
  let run = null;
  if (MODE === 'play') {
    // важно вернуть скалярное значение: результат playLevel несериализуем и вешает промис,
    // а ошибку ловим внутри страницы, иначе Electron отдаёт её без текста
    const launch = await win.webContents.executeJavaScript(`(() => {
      try {
        if (!window.GW_APP) return 'нет GW_APP';
        if (!window.LEVELS || !window.LEVELS.length) return 'нет LEVELS';
        window.GW_APP.playLevel(window.LEVELS[0]);
        return 'ok';
      } catch (e) { return 'ОШИБКА: ' + (e && e.stack ? e.stack : e); }
    })()`);
    if (launch !== 'ok') problems.push('запуск уровня: ' + launch);
    console.log('=== LAUNCH ===');
    console.log(launch);
    await new Promise((r) => setTimeout(r, 1200));

    // поля движка заранее не известны — сначала смотрим, что вообще есть
    const shape = await win.webContents.executeJavaScript(`(() => {
      try {
        const g = window.GW_APP.game;
        if (!g) return { есть_game: false };
        return {
          есть_game: true,
          ключи: Object.keys(g).slice(0, 40),
          player: g.player ? Object.keys(g.player).slice(0, 30) : null
        };
      } catch (e) { return { ошибка: String(e) }; }
    })()`);

    const snap = `(() => {
      try {
        const g = window.GW_APP.game;
        if (!g) return null;
        const p = g.player || g.p || {};
        return { x: p.x, y: p.y, мертв: p.dead, время: g.time, процент: g.percent };
      } catch (e) { return { ошибка: String(e) }; }
    })()`;

    const t0 = await win.webContents.executeJavaScript(snap);
    await new Promise((r) => setTimeout(r, 2500));
    const t1 = await win.webContents.executeJavaScript(snap);

    run = { структура: shape, старт: t0, через_2_5с: t1 };
    if (!t0 || !t1) problems.push('игра не запустилась (нет GW_APP.game)');
    else if (typeof t0.x !== 'number' || typeof t1.x !== 'number') problems.push('не читается позиция игрока');
    else if (!(t1.x > t0.x)) problems.push(`игрок не движется: x ${t0.x} -> ${t1.x}`);
  }

  // музыка: без Range-запросов длительность приходит Infinity, и тогда
  // music.currentTime = 0 при новой попытке молча не срабатывает
  const music = await win.webContents.executeJavaScript(`new Promise((res) => {
    const a = new Audio('music/level1.mp3');
    const t = setTimeout(() => res('ТАЙМАУТ'), 8000);
    a.onloadedmetadata = () => {
      clearTimeout(t);
      if (!isFinite(a.duration)) return res('длительность Infinity — перемотка сломана');
      try { a.currentTime = 0; } catch (e) { return res('перемотка не работает: ' + e.message); }
      res('ok, длительность ' + Math.round(a.duration) + ' сек, перемотка работает');
    };
    a.onerror = () => { clearTimeout(t); res('ОШИБКА загрузки'); };
  })`);
  if (!String(music).startsWith('ok')) problems.push('музыка: ' + music);

  // что реально живо на странице
  const probe = await win.webContents.executeJavaScript(`(() => ({
    title: document.title,
    lobby: (document.querySelector('#lobby-title')||{}).textContent,
    screen: (document.querySelector('.screen.active')||{}).id,
    hasEditorBtn: !!document.querySelector('#btn-editor'),
    движок: !!window.GW,
    редактор: !!window.GW_EDITOR,
    кубиков: window.GW && window.GW.Icons ? Object.keys(window.GW.Icons.images).length : -1,
    музыка: ${JSON.stringify('')} + ${JSON.stringify(music)},
    levels: (window.LEVELS||[]).length,
    canvasPainted: (() => {
      const c = document.querySelector('#game-canvas');
      if (!c) return 'нет канваса';
      return c.width + 'x' + c.height;
    })(),
    storage: (() => { try { localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return 'ok'; }
                      catch(e) { return 'FAIL: ' + e.message; } })()
  }))()`);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const img = await win.capturePage();
  const shot = path.join(SHOT_DIR, `${MODE}.png`);
  fs.writeFileSync(shot, img.toPNG());

  console.log('=== PROBE ===');
  console.log(JSON.stringify(probe, null, 2));
  if (run) {
    console.log('=== PLAY ===');
    console.log(JSON.stringify(run, null, 2));
  }

  if (dash) {
    console.log('=== DASH ===');
    console.log(JSON.stringify(dash, null, 2));
  }

  if (MODE === 'export') {
    console.log('=== EXPORT ===');
    if (!exported) {
      problems.push('экспорт не выдал файл');
    } else {
      const raw = fs.readFileSync(exported.dest, 'utf8');
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { problems.push('экспорт: битый JSON — ' + e.message); }
      console.log(JSON.stringify({
        файл: exported.dest,
        статус: exported.state,
        байт: raw.length,
        формат: parsed && parsed.format,
        объектов: parsed && parsed.objects && parsed.objects.length
      }, null, 2));
    }
  }

  console.log('=== PROBLEMS (' + problems.length + ') ===');
  problems.forEach((p) => console.log(' - ' + p));
  console.log('=== SHOT ===');
  console.log(shot);

  app.exit(problems.length ? 1 : 0);
}).catch((err) => {
  console.error('ПРОВЕРКА УПАЛА:', err && err.stack ? err.stack : err);
  app.exit(2);
});

// страховка от зависания: проверка не должна висеть вечно
setTimeout(() => {
  console.error('ПРОВЕРКА ЗАВИСЛА (таймаут 60с)');
  app.exit(3);
}, 60000).unref?.();
