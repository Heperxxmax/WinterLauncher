# WINTER GTA Launcher

Electron-based desktop launcher, styled after the WINTER GTA design (dark UI, frameless window, news feed, server picker, install/play button).

## Run

```
npm install
npm start
```

## Configure

Edit `config.json` in the project root — no code changes needed:

- `siteUrl`, `forumUrl`, `discordUrl`, `telegramUrl` — links opened by the sidebar/titlebar buttons.
- `news[]` — items shown in the news card (`date`, `title`, `subtitle`, `image` — path or URL to a background image). Multiple items auto-rotate every 8s with dot indicators.
- `servers[]` — MTA:SA servers shown in the sidebar. `host`/`port` is the game connect port; the launcher queries `port + queryPortOffset` (default 123) using the MTA ASE protocol to show live player counts. If a server doesn't respond, it shows "— гравців".
- `game.downloadUrl` — direct link to either a `.zip` (extracted into the install folder) or a setup `.exe` (run silently with `/S`). Required for the download button to work. May also be a **list** of mirrors, tried in order until one serves the file:

  ```json
  "downloadUrl": [
    "https://mirror-1.example/game.zip",
    "https://mirror-2.example/game.zip"
  ]
  ```

  The host must serve the file to a plain HTTP client. A host behind Cloudflare's "Under Attack" / Bot Fight Mode answers every request with a 403 JS challenge page ("Just a moment..."), which no launcher can download through — add a WAF **Skip** rule for the file's path, or serve it from a bucket/CDN with no challenge.
- `game.exeName` — file checked inside the install folder to decide whether the game is "installed" (switches the button from СКАЧАТИ to ГРАТИ).
- `game.installDirName` — default folder name under the user's AppData if no custom install path is chosen in Settings.

The install location can be changed by the user from the in-app Settings window (gear icon); it's persisted per-user, not in `config.json`.

## Package a Windows installer

```
npm run dist
```

Produces an NSIS installer via `electron-builder` (see the `build` key in `package.json`). Add a `src/assets/icon.ico` and reference it under `build.win.icon` for a custom app icon.

## Notes

- The news image in the shipped `config.json` points at `assets/news-1.jpg`, which isn't included — replace it with your own artwork, or leave it blank to fall back to a plain background.
- Player-count queries use UDP and will show "—" if the target server is offline, unreachable, or behind a firewall blocking the query port.
