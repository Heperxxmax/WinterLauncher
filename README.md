# UKRAINE ONLINE Launcher

Electron-based desktop launcher, styled after the UKRAINE ONLINE design (dark UI, frameless window, news feed, server picker, install/play button).

## Run

```
npm ci
npm start
```

## Configure

Edit `config.json` in the project root — no code changes needed:

- `siteUrl`, `forumUrl`, `discordUrl`, `telegramUrl` — links opened by the sidebar/titlebar buttons.
- `news[]` — items shown in the news card (`date`, `title`, `subtitle`, `image` — path or URL to a background image). Multiple items auto-rotate every 8s with dot indicators.
- `servers[]` — MTA:SA servers shown in the sidebar. `host`/`port` is the game connect port; the launcher queries `port + queryPortOffset` (default 123) using the MTA ASE protocol to show live player counts. If a server doesn't respond, it shows "— гравців".
- `game.downloadUrl` — direct link to either a `.zip` (extracted into the install folder) or a setup `.exe` (run silently with `/S`). Required for the download button to work.
- `game.exeName` — file checked inside the install folder to decide whether the game is "installed" (switches the button from СКАЧАТИ to ГРАТИ).
- `game.installDirName` — default folder name under the user's AppData if no custom install path is chosen in Settings.

The install location can be changed by the user from the in-app Settings window (gear icon); it's persisted per-user, not in `config.json`.

## Package a Windows installer

```
npm run dist:win
```

Produces an NSIS installer via `electron-builder` (see the `build` key in `package.json`). Add a `src/assets/icon.ico` and reference it under `build.win.icon` for a custom app icon.

## Notes

- The news image in the shipped `config.json` points at `assets/news-1.jpg`, which isn't included — replace it with your own artwork, or leave it blank to fall back to a plain background.
- Player-count queries use UDP and will show "—" if the target server is offline, unreachable, or behind a firewall blocking the query port.

## Windows build and startup verification

Use Node.js 22 or newer. On Windows, run `npm ci`, `npm run dist:win`,
then `npm run test:smoke`. The smoke check launches the actual packaged
executable with a temporary profile and verifies the main window, configuration,
preload IPC bridge, controls, and image assets.

- `dist/UKRAINE-ONLINE-Setup-1.1.1.exe` is the Windows x64 installer.
- `dist/win-unpacked/UKRAINE ONLINE.exe` starts without installation; keep the
  entire `win-unpacked` directory together, including its DLLs and resources.
- GitHub Actions runs the same build and startup check on Windows after pushes
  to `master`. Download the `windows-x64` artifact from the successful run.
- Published installers and standalone ZIPs are available under GitHub Releases.

Build output and `node_modules` are excluded from Git. The supplied application
name and artwork remain UKRAINE ONLINE.
