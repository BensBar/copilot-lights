# Copilot Lights Menu Bar

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
cp -R CopilotLightsMenuBar.app /Applications/
open /Applications/CopilotLightsMenuBar.app
```

Launch at Login: System Settings > General > Login Items, add CopilotLightsMenuBar.app

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
├── version.env
├── Scripts/
│   ├── package_app.sh
│   ├── compile_and_run.sh
│   └── launch.sh
├── Sources/CopilotLightsMenuBar/
│   ├── App.swift
│   ├── AppDelegate.swift
│   ├── StatusItemController.swift
│   ├── DaemonClient.swift
│   ├── DaemonStatus.swift
│   ├── SocketPath.swift
│   ├── Menu.swift
│   └── Resources/copilot-mark.svg
└── Tests/CopilotLightsMenuBarTests/
```

## Troubleshooting

SDK errors: xcrun --show-sdk-path

Daemon offline: The app looks for socket at COPILOT_LIGHTS_SOCKET, XDG_RUNTIME_DIR/copilot-lights/sock, or ~/.copilot-lights/sock

Packaging: This uses macos-spm-app-packaging scripts. MENU_BAR_APP=1 in version.env sets LSUIElement=true in Info.plist.

## License

Same as parent copilot-lights project.
