# Copilot Lights — macOS app

A macOS menu bar app that displays the current state of the copilot-lights daemon. Shows a tinted Copilot robot mark that mirrors the color and brightness of your smart lights as they respond to Copilot CLI activity.

Built using the battle-tested macos-spm-app-packaging skill by Dimillian (https://github.com/Dimillian/Skills/tree/main/macos-spm-app-packaging).

## Features

- Live status indicator: Tinted Copilot mark in menu bar reflects the current light color and brightness
- Animated thinking state: Subtle pulsing when Copilot is processing
- Quick actions: Edit config, restart daemon, view logs
- Offline detection: Gray mark when daemon is not running

## Installation

```bash
cd macos
./Scripts/package_app.sh release
open "/Applications/Copilot Lights.app"
```

`package_app.sh release` builds, signs, and **installs the app straight to
`/Applications`**, then removes the in-repo build artifact — so there is always
exactly one app binary on the machine. To keep the bundle in the repo instead
(e.g. for CI), set `NO_INSTALL=1`; to install elsewhere, set `INSTALL_DIR=/path`.

Launch at Login: System Settings > General > Login Items, add `Copilot Lights.app`.

> Easier: from the repo root run the one-liner installer documented in the
> top-level README — it builds the app, installs it to `/Applications`, and
> registers it for Launch at Login automatically.

## Development

Requirements: macOS 13.0+, Xcode 15+, Swift 5.9+

```bash
swift test
./Scripts/compile_and_run.sh
./Scripts/package_app.sh release
ARCHES="arm64 x86_64" ./Scripts/package_app.sh release
```

## Project Structure

```
macos/
├── version.env                       # APP_NAME=CopilotLights, BUNDLE_NAME="Copilot Lights"
├── Scripts/
│   ├── package_app.sh
│   ├── compile_and_run.sh
│   └── launch.sh
├── Sources/CopilotLights/
│   ├── App.swift
│   ├── AppDelegate.swift
│   ├── StatusItemController.swift
│   ├── DaemonClient.swift
│   ├── DaemonStatus.swift
│   ├── SocketPath.swift
│   ├── Menu.swift
│   └── Resources/copilot-mark.svg
└── Tests/CopilotLightsTests/
```

## Troubleshooting

SDK errors: xcrun --show-sdk-path

Daemon offline: The app looks for socket at COPILOT_LIGHTS_SOCKET, XDG_RUNTIME_DIR/copilot-lights/sock, or ~/.copilot-lights/sock

Packaging: This uses macos-spm-app-packaging scripts. MENU_BAR_APP=1 in version.env sets LSUIElement=true in Info.plist.

## License

Same as parent copilot-lights project.
