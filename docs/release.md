# Порядок выпуска и обновления

Документ описывает подготовку новой версии приложения «Огнетушители», автоматическую сборку в GitHub Actions, ручную сборку на рабочем компьютере, работу с ключом подписи APK и установку обновлений без доступа к интернету.

## 1. Подготовка выпуска

1. Убедитесь, что рабочая ветка чистая и все изменения слиты в `main`:
   ```
   git status
   ```
2. Обновите номер версии в `package.json` по правилам SemVer (`MAJOR.MINOR.PATCH`):
   - `PATCH` (например, `1.0.2`): исправления ошибок без изменения формата данных;
   - `MINOR` (например, `1.1.0`): новые возможности с обратной совместимостью;
   - `MAJOR` (например, `2.0.0`): крупные перестройки интерфейса или схемы данных.
   При сборке `tools/native.js` сам переносит версию в `native/package.json` и вычисляет целочисленный `versionCode` для Android по формуле `MAJOR * 10000 + MINOR * 100 + PATCH` (например, `1.0.1` даёт `10001`, `2.0.0` даёт `20000`).
3. Перенесите записи из раздела `## [Не выпущено]` в `CHANGELOG.md` под новый заголовок `## [X.Y.Z] - ДД.ММ.ГГГГ` и обновите ссылки сравнения внизу файла. Рабочий сценарий `release.yml` проверяет наличие заголовка `## [X.Y.Z]` в `CHANGELOG.md`.
4. Если добавлялись новые файлы приложения, проверьте, что все они внесены в массив `ASSETS` в `sw.js`.
5. Проставьте новый номер сборки в `sw.js`, `index.html` и `js/config.js`:
   ```
   npm run build
   ```
6. Запустите обязательные проверки:
   ```
   npm test
   npm run check:ui
   node tools/check-pwa.js
   node tools/bench-vision.js --synth
   node tools/ci/bench-gate.js --max-drop 2
   ```
   Если на компьютере развёрнут набор из 59 общедоступных планов (`bench/vision/img/`), дополнительно прогоните полный стенд и галерею:
   ```
   node tools/bench-vision.js
   node tools/vision-gallery.js
   ```
7. Зафиксируйте выпуск коммитом и поставьте метку версии:
   ```
   git add package.json CHANGELOG.md sw.js index.html js/config.js
   git commit -m "Выпуск X.Y.Z"
   git tag vX.Y.Z
   git push origin main --tags
   ```

## 2. Автоматический выпуск в GitHub Actions

При отправке метки вида `v*` запускается сценарий `.github/workflows/release.yml`:

1. Задание `verify` (Ubuntu): сверяет имя метки `vX.Y.Z` с полем `version` в `package.json`, проверяет наличие раздела `## [X.Y.Z]` в `CHANGELOG.md` и прогоняет модульные тесты (`node --test`).
2. Задание `android` (Ubuntu): ставит Node 22, JDK 21 (Temurin), Android SDK (платформа `android-36`, `build-tools;36.0.0`), декодирует ключ подписи из секретов репозитория во временную папку `FIRECALC_KEYS_DIR`, собирает подписанный APK командой `node tools/native.js android`, проверяет подпись через `apksigner verify` и удаляет ключ с сервера сборки.
3. Задание `windows` (Windows): ставит Node 22 и собирает установщик (`Ognetushiteli-Setup-X.Y.Z.exe`) и переносную версию (`Ognetushiteli-X.Y.Z-portable.exe`) командой `node tools/native.js windows`.
4. Задание `publish` (Ubuntu): скачивает собранные файлы, считает для каждого контрольную сумму SHA-256 в файл `SHA256SUMS.txt`, вырезает описание версии из `CHANGELOG.md` и создаёт выпуск (GitHub Release) с прикреплёнными файлами:
   - `Ognetushiteli-X.Y.Z.apk`
   - `Ognetushiteli-Setup-X.Y.Z.exe`
   - `Ognetushiteli-X.Y.Z-portable.exe`
   - `SHA256SUMS.txt`

### Секреты репозитория GitHub

Для сборки подписанного APK в настройках репозитория (`Settings -> Secrets and variables -> Actions -> Repository secrets`) должны быть заданы четыре секрета:

| Имя секрета | Содержимое |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Файл хранилища ключей `firecalc-release.jks`, закодированный в строку Base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Пароль хранилища (`storePassword` из `keystore.properties`) |
| `ANDROID_KEY_ALIAS` | Имя ключа в хранилище (`keyAlias`, по умолчанию `firecalc`) |
| `ANDROID_KEY_PASSWORD` | Пароль ключа (`keyPassword` из `keystore.properties`) |

Если любой из четырёх секретов не задан, задание `android` в `release.yml` завершится с ошибкой: выпуск не подписывается отладочным ключом.

Как получить строку для `ANDROID_KEYSTORE_BASE64` из файла ключа на Windows (PowerShell):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:LOCALAPPDATA\firecalc-build\keys\firecalc-release.jks")) | Set-Clipboard
```

На Linux или macOS:

```sh
base64 -w 0 ~/.cache/firecalc-build/keys/firecalc-release.jks
```

## 3. Ручная сборка на рабочем компьютере

Если GitHub Actions недоступен или сборка проводится без сети на сборочной машине:

1. Проверьте наличие инструментов:
   - Node 22;
   - JDK 21 (путь в переменной `JAVA_HOME` или в папке `%LOCALAPPDATA%\firecalc-build\jdk`);
   - Android SDK с платформой 36 и build-tools 35+ (путь в `ANDROID_HOME` или в `%LOCALAPPDATA%\firecalc-build\android-sdk`);
   - ключ подписи APK в `%LOCALAPPDATA%\firecalc-build\keys` (или в папке из переменной `FIRECALC_KEYS_DIR`).
2. Соберите все пакеты одной командой:
   ```
   node tools/native.js all
   ```
   Либо по отдельности:
   ```
   node tools/native.js android
   node tools/native.js windows
   ```
   Если задан внутренний сервер ведомства для ссылок и QR-кодов в PDF, передайте его адрес:
   ```
   node tools/native.js all --public-url https://firecalc.internal.example/
   ```
3. Готовые файлы появятся в папке `release/`. Сформируйте файл контрольных сумм `release/SHA256SUMS.txt` в PowerShell:
   ```powershell
   Push-Location release
   Get-ChildItem Ognetushiteli-* | ForEach-Object {
     $h = (Get-FileHash $_.Name -Algorithm SHA256).Hash.ToLower()
     "$h  $($_.Name)"
   } | Set-Content -Encoding ascii SHA256SUMS.txt
   Pop-Location
   ```

## 4. Ключ подписи APK: резервное копирование и восстановление

Android разрешает установить новую версию APK поверх старой с сохранением введённых объектов только в том случае, если оба APK подписаны одним и тем же ключом. При утере ключа инспектору придётся удалять старое приложение перед установкой нового.

### Где хранится ключ

По умолчанию `tools/native.js` ищет ключ в папке:
- Windows: `%LOCALAPPDATA%\firecalc-build\keys` (или путь из `FIRECALC_KEYS_DIR`);
- Linux и macOS: `~/.cache/firecalc-build/keys`.

В папке находятся:
- `firecalc-release.jks`: хранилище ключа (RSA 3072 бит, срок действия 10000 дней, алиас `firecalc`);
- `keystore.properties`: пути и пароли (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`);
- `ПРОЧТИТЕ.txt`: памятка.

Ключ никогда не добавляется в git и не передаётся внешним сервисам или моделям ИИ.

### Резервное копирование

1. Скопируйте всю папку `%LOCALAPPDATA%\firecalc-build\keys` (`firecalc-release.jks` и `keystore.properties`) на два независимых защищённых носителя (например, зашифрованный накопитель ответственного за выпуск и сейфовое хранилище службы ИТ/ИБ).
2. Проверьте целостность резервной копии командой `keytool`:
   ```
   keytool -list -v -keystore firecalc-release.jks -alias firecalc
   ```
3. Запишите отпечаток сертификата SHA-256 (`SHA256:` в выводе `keytool -list -v`) в паспорт выпуска в службе ИБ.

### Восстановление на новом компьютере

1. Создайте папку `%LOCALAPPDATA%\firecalc-build\keys` (или любую папку и укажите её в `FIRECALC_KEYS_DIR`).
2. Скопируйте в неё `firecalc-release.jks` и `keystore.properties` из резервной копии.
3. Откройте `keystore.properties` в текстовом редакторе и проверьте строку `storeFile=`: путь должен указывать на фактическое расположение `firecalc-release.jks` на этом компьютере (с прямыми косыми чертами `/`).
4. После сборки проверьте, что APK подписан именно этим ключом:
   ```
   apksigner verify --print-certs release\Ognetushiteli-X.Y.Z.apk
   ```
   Отпечаток `Signer #1 certificate SHA-256 digest` должен совпадать с записанным отпечатком ключа выпуска.

## 5. Проверка контрольных сумм SHA-256

Перед размещением файлов во внутренней сети или передачей на устройства служба ИТ и инспекторы могут сверить контрольные суммы с файлом `SHA256SUMS.txt`.

Windows (PowerShell):

```powershell
Get-FileHash .\Ognetushiteli-Setup-1.0.1.exe -Algorithm SHA256
Get-FileHash .\Ognetushiteli-1.0.1-portable.exe -Algorithm SHA256
Get-FileHash .\Ognetushiteli-1.0.1.apk -Algorithm SHA256
```

Windows (`certutil`, работает во всех редакциях без PowerShell):

```cmd
certutil -hashfile Ognetushiteli-Setup-1.0.1.exe SHA256
```

Linux и macOS:

```sh
sha256sum -c SHA256SUMS.txt
```

Значение хэша должно посимвольно совпадать со строкой в `SHA256SUMS.txt`.

## 6. Установка и обновление у инспекторов без интернета

### Android (APK)

- **Установка**: файл `Ognetushiteli-X.Y.Z.apk` передаётся на телефон способом, разрешённым политикой ИБ ведомства (по кабелю USB с рабочего компьютера, через внутренний портал ведомства или систему управления мобильными устройствами MDM). При первом открытии файла Android запросит разрешение на установку из этого источника («Настройки -> Разрешить установку из этого источника»).
- **Обновление**: откройте новый файл `Ognetushiteli-X.Y.Z.apk` поверх установленного приложения и нажмите «Обновить». Удалять старую версию не нужно: все сохранённые объекты и планы этажей останутся на месте.

### Windows: установщик (`Ognetushiteli-Setup-X.Y.Z.exe`)

- **Установка**: запустите `Ognetushiteli-Setup-X.Y.Z.exe`. Права администратора не требуются (установка идёт в профиль пользователя `%LOCALAPPDATA%\Programs\Ognetushiteli`). Создаются ярлыки на рабочем столе и в меню «Пуск». Если файл не подписан сертификатом издателя Windows и появляется окно SmartScreen «Система Windows защитила ваш компьютер», сверите контрольную сумму файла с `SHA256SUMS.txt`, нажмите «Подробнее» и «Выполнить в любом случае».
- **Обновление**: запустите установщик новой версии поверх установленной. Программа обновит исполняемые файлы, а сохранённые объекты в `%APPDATA%\Огнетушители` останутся без изменений.

### Windows: переносная версия (`Ognetushiteli-X.Y.Z-portable.exe`)

- **Установка**: положите `Ognetushiteli-X.Y.Z-portable.exe` в отдельную папку на компьютере или на разрешённом съёмном носителе. При первом запуске рядом с файлом создаётся папка `Огнетушители-данные`, где хранятся все объекты и планы этажей.
- **Обновление**: положите новый файл `Ognetushiteli-X.Y.Z-portable.exe` в ту же папку рядом с `Огнетушители-данные` и запускайте новую версию. Старый `.exe` можно удалить.

### Внутренний сервер ведомства (PWA по HTTPS)

Если во внутренней сети ДЧС развёрнут веб-сервер с сертификатом HTTPS (например, Nginx или IIS в закрытом контуре):

1. Разместите на сервере файлы из корня репозитория (или копию, собранную командой `node tools/build.js --dist <папка> --public-url https://адрес-внутреннего-сервера/`).
2. Настройте веб-сервер так, чтобы файл `sw.js` отдавался с заголовком `Cache-Control: no-cache` (образец есть в `vercel.json`): тогда браузер сразу видит выход новой сборки.
3. Инспектор один раз открывает адрес внутреннего сервера в браузере (Chrome, Edge на компьютере и Android, Safari на iPhone и iPad) и выбирает «Установить на это устройство» (на iPhone: «Поделиться -> На экран Домой»).
4. Служебный сценарий (`sw.js`) сохраняет все файлы приложения на устройстве. Дальше приложение открывается и работает полностью автономно при отсутствии связи с сервером.
5. При выкладке новой версии на сервер (после `npm run build`) устройства при следующем подключении к внутренней сети скачают обновление в фоне и покажут уведомление «Вышла новая версия» с кнопкой «Обновить». Данные объектов на устройстве сохраняются.
