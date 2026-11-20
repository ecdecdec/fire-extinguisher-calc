// Сборка приложений из кода сайта: Android (APK) и Windows (установщик и переносной EXE).
//
//   node tools/native.js android       (npm run app:android)
//   node tools/native.js windows       (npm run app:windows)
//   node tools/native.js all           (npm run app)
// Параметры:
//   --public-url https://адрес-сайта/  — куда ведут ссылка на расчёт и QR-код в PDF из приложений;
//   --debug                            — отладочный APK (подписан ключом отладки).
//
// Что нужно на компьютере: Node 22; для Android — JDK 21 и Android SDK (платформа 36,
// build-tools 35+). Пути берутся из JAVA_HOME и ANDROID_HOME, а если их нет — из папки сборки
// FIRECALC_BUILD_DIR (по умолчанию %LOCALAPPDATA%\firecalc-build: jdk, android-sdk).
// Сборка идёт в копии проекта в этой папке (не в OneDrive: там тысячи временных файлов).
// Готовые файлы кладутся в папку release/ проекта.
//
// Ключ подписи APK создаётся при первой сборке в FIRECALC_BUILD_DIR\keys. Его нужно сохранить:
// обновление приложения ставится поверх старого только с тем же ключом, иначе старое
// приложение придётся удалить вместе с данными.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const BUILD = process.env.FIRECALC_BUILD_DIR ||
  (WIN ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'firecalc-build') : path.join(os.homedir(), '.cache', 'firecalc-build'));
const WORK = path.join(BUILD, 'work', 'native');
const KEYS = process.env.FIRECALC_KEYS_DIR || path.join(BUILD, 'keys');
const RELEASE = path.join(ROOT, 'release');

const args = process.argv.slice(2);
const what = args[0] || 'all';
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const debug = args.includes('--debug');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function log(s) { console.log('\n== ' + s); }

// Командная оболочка нужна в Windows только для npm, npx и .bat; путь с пробелами тогда в кавычках.
function run(cmd, list, cwd, env) {
  const shell = WIN && (/^(npm|npx)$/i.test(cmd) || /\.(bat|cmd)$/i.test(cmd));
  const quote = a => (shell && /\s/.test(a) ? '"' + a + '"' : a);
  console.log('> ' + cmd + ' ' + list.join(' '));
  const r = spawnSync(quote(cmd), list.map(quote), { cwd: cwd, env: Object.assign({}, process.env, env || {}), stdio: 'inherit', shell: shell });
  if (r.status !== 0) throw new Error(cmd + ' завершился с ошибкой (' + (r.error ? r.error.message : r.status) + ')');
}

// Копия папки native/ проекта без тяжёлых временных папок.
const SKIP = new Set(['node_modules', 'dist-desktop', 'www', '.gradle', 'build', 'local.properties', 'keystore.properties', 'public', 'capacitor-cordova-android-plugins']);
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from, { withFileTypes: true }).forEach(function (e) {
    if (SKIP.has(e.name) && !(e.name === 'build' && from.endsWith(path.join('desktop')))) return;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b); else fs.copyFileSync(a, b);
  });
}

function sync() {
  log('Копия проекта: ' + WORK);
  // устаревшие файлы приложения Android и сайта не должны пережить сборку
  fs.rmSync(path.join(WORK, 'android', 'app', 'src'), { recursive: true, force: true });
  fs.rmSync(path.join(WORK, 'desktop', 'www'), { recursive: true, force: true });
  copyTree(path.join(ROOT, 'native'), WORK);
  // номер версии приложений — из package.json проекта
  const np = JSON.parse(fs.readFileSync(path.join(WORK, 'package.json'), 'utf8'));
  np.version = pkg.version;
  fs.writeFileSync(path.join(WORK, 'package.json'), JSON.stringify(np, null, 2) + '\n');
}

function deps() {
  const lock = path.join(WORK, 'package-lock.json');
  const stamp = path.join(WORK, 'node_modules', '.firecalc-deps');
  const want = crypto.createHash('sha256').update(fs.readFileSync(path.join(WORK, 'package.json'))).update(fs.existsSync(lock) ? fs.readFileSync(lock) : '').digest('hex');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) return;
  log('Зависимости (Capacitor, Electron)');
  run('npm', [fs.existsSync(lock) ? 'ci' : 'install', '--no-audit', '--no-fund'], WORK);
  fs.writeFileSync(stamp, want);
  // файл блокировки версий — обратно в проект, чтобы следующая сборка взяла те же версии
  if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(ROOT, 'native', 'package-lock.json'));
}

function web() {
  log('Файлы приложения');
  const list = [path.join(ROOT, 'tools', 'build.js'), '--dist', path.join(WORK, 'www')];
  if (opt('--public-url')) list.push('--public-url', opt('--public-url'));
  run(process.execPath, list, ROOT);
  copyTree(path.join(WORK, 'www'), path.join(WORK, 'desktop', 'www'));
}

function versionCode(v) {
  const p = String(v).split('.').map(n => parseInt(n, 10) || 0);
  return p[0] * 10000 + (p[1] || 0) * 100 + (p[2] || 0);
}

function javaHome() {
  const cands = [process.env.JAVA_HOME, path.join(BUILD, 'jdk')].filter(Boolean);
  const home = cands.find(h => fs.existsSync(path.join(h, 'bin', WIN ? 'javac.exe' : 'javac')));
  if (!home) throw new Error('Не найден JDK 17+ (нужен javac). Укажите JAVA_HOME или положите JDK в ' + path.join(BUILD, 'jdk'));
  return home;
}

function androidHome() {
  const cands = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(BUILD, 'android-sdk'),
    WIN ? path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk') : path.join(os.homedir(), 'Android', 'Sdk')].filter(Boolean);
  const home = cands.find(h => fs.existsSync(path.join(h, 'platforms')));
  if (!home) throw new Error('Не найден Android SDK. Укажите ANDROID_HOME или положите SDK в ' + path.join(BUILD, 'android-sdk'));
  return home;
}

// Ключ подписи: создаётся один раз и хранится вне проекта (в git ему не место).
function keystore(jdk) {
  const props = path.join(KEYS, 'keystore.properties');
  if (!fs.existsSync(props)) {
    log('Новый ключ подписи APK: ' + KEYS);
    fs.mkdirSync(KEYS, { recursive: true });
    const pass = crypto.randomBytes(16).toString('hex'); // без «-» в начале: keytool принял бы его за параметр
    const file = path.join(KEYS, 'firecalc-release.jks');
    run(path.join(jdk, 'bin', WIN ? 'keytool.exe' : 'keytool'), ['-genkeypair', '-keystore', file, '-alias', 'firecalc', '-keyalg', 'RSA', '-keysize', '3072',
      '-validity', '10000', '-storepass', pass, '-keypass', pass, '-dname', 'CN=Ognetushiteli, O=Smart Inspector, C=KZ'], KEYS);
    fs.writeFileSync(props, ['storeFile=' + file.replace(/\\/g, '/'), 'storePassword=' + pass, 'keyAlias=firecalc', 'keyPassword=' + pass, ''].join('\n'));
    fs.writeFileSync(path.join(KEYS, 'ПРОЧТИТЕ.txt'),
      'Ключ подписи приложения «Огнетушители» для Android.\r\n' +
      'Сохраните эту папку целиком (firecalc-release.jks и keystore.properties) в надёжном месте.\r\n' +
      'Обновления APK устанавливаются поверх старой версии только с этим же ключом.\r\n' +
      'Без него старое приложение придётся удалить вместе с сохранёнными в нём объектами.\r\n');
  }
  return props;
}

function android() {
  const jdk = javaHome(), sdk = androidHome();
  log('Android: JDK ' + jdk + ', SDK ' + sdk);
  const env = { JAVA_HOME: jdk, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, PATH: path.join(jdk, 'bin') + path.delimiter + process.env.PATH };
  const dir = path.join(WORK, 'android');
  fs.writeFileSync(path.join(dir, 'local.properties'), 'sdk.dir=' + sdk.replace(/\\/g, '/') + '\n');
  if (!debug) fs.copyFileSync(keystore(jdk), path.join(dir, 'keystore.properties'));
  else fs.rmSync(path.join(dir, 'keystore.properties'), { force: true });
  run('npx', ['cap', 'sync', 'android'], WORK, env);
  const task = debug ? 'assembleDebug' : 'assembleRelease';
  // полный путь: командная оболочка Windows может не искать программы в текущей папке
  run(path.join(dir, WIN ? 'gradlew.bat' : 'gradlew'), [task, '--no-daemon', '-PappVersionCode=' + versionCode(pkg.version), '-PappVersionName=' + pkg.version], dir, env);
  const apk = path.join(dir, 'app', 'build', 'outputs', 'apk', debug ? 'debug' : 'release', debug ? 'app-debug.apk' : 'app-release.apk');
  if (!fs.existsSync(apk)) throw new Error('APK не найден: ' + apk);
  fs.mkdirSync(RELEASE, { recursive: true });
  const out = path.join(RELEASE, 'Ognetushiteli-' + pkg.version + (debug ? '-debug' : '') + '.apk');
  fs.copyFileSync(apk, out);
  return [out];
}

function windows() {
  if (!WIN) throw new Error('Приложение для Windows собирается на Windows');
  log('Windows: установщик и переносная версия');
  fs.rmSync(path.join(WORK, 'dist-desktop'), { recursive: true, force: true });
  run('npx', ['electron-builder', '--win', '--x64', '--publish', 'never'], WORK, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  fs.mkdirSync(RELEASE, { recursive: true });
  const dist = path.join(WORK, 'dist-desktop');
  return fs.readdirSync(dist).filter(f => /\.exe$/i.test(f) && /^Ognetushiteli-/.test(f)).map(function (f) {
    const out = path.join(RELEASE, f);
    fs.copyFileSync(path.join(dist, f), out);
    return out;
  });
}

try {
  if (!['android', 'windows', 'all'].includes(what)) throw new Error('Укажите android, windows или all');
  sync();
  deps();
  web();
  let files = [];
  if (what === 'android' || what === 'all') files = files.concat(android());
  if (what === 'windows' || what === 'all') files = files.concat(windows());
  log('Готово');
  files.forEach(f => console.log(f + '  (' + (fs.statSync(f).size / 1048576).toFixed(1) + ' МБ)'));
} catch (e) {
  console.error('\nОшибка: ' + e.message);
  process.exit(1);
}
