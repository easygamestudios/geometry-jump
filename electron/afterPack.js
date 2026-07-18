/* Хук electron-builder: подписать приложение ad-hoc перед сборкой dmg.
   Без этого бандл остаётся с linker-подписью без ресурсной печати, и macOS
   на чужом компьютере говорит «приложение повреждено» вместо обычного
   «не удалось проверить разработчика» — а из «повреждено» нет кнопки
   «Открыть всё равно». */
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  console.log('  • подписываем ad-hoc  app=' + appPath);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log('  • подпись прошла проверку');
};
