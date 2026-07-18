/* ============================================================
   Geometry Web — встроенные уровни (версия для игроков)
   Уровень 1 ("new Adventure") лежит в js/level1-data.js.
   Новые уровни: window.LEVELS.push(<данные из .gwlevel.json>),
   музыку класть в music/ и указывать путь в поле music.
   ============================================================ */
(function () {
  'use strict';

  window.LEVELS = [
    window.LEVEL1_DATA // "new Adventure" — из js/level1-data.js
  ];
})();
