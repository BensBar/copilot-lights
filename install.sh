#!/usr/bin/env bash
# Copilot Lights — one-line installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/BensBar/copilot-lights/main/install.sh | bash
#
# What it does:
#   1. Verifies prerequisites (Node 20+, npm, git; Swift 5.9+ on macOS).
#   2. Clones (or updates) the repo into ~/.copilot-lights/src.
#   3. Builds the daemon/CLI (TypeScript) and links `copilot-lights` into PATH.
#   4. On macOS: builds and installs the "Copilot Lights" menubar app to
#      /Applications and registers it for Launch at Login.
#   5. Wires the Copilot CLI hooks (`copilot-lights install`).
#   6. Enables daemon autostart (`copilot-lights enable-autostart`).
#   7. Runs `copilot-lights doctor` and prints the result.
#
# All steps are idempotent — re-run safely to upgrade.
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/BensBar/copilot-lights.git}
SRC_DIR=${SRC_DIR:-"$HOME/.copilot-lights/src"}
BRANCH=${BRANCH:-main}
SKIP_MENUBAR=${SKIP_MENUBAR:-0}
SKIP_AUTOSTART=${SKIP_AUTOSTART:-0}

c_info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[32m ✓\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m !!\033[0m %s\n' "$*" >&2; }
c_fail() { printf '\033[31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || c_fail "Missing prerequisite: $1${2:+ ($2)}"
}

# ---------- prereqs ----------
c_info "Checking prerequisites"
require git
require node "https://nodejs.org/ — Node 20+"
require npm

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  c_fail "Node 20+ required (have $(node -v))"
fi

OS=$(uname -s)
if [[ "$OS" == "Darwin" && "$SKIP_MENUBAR" != "1" ]]; then
  require swift "Xcode Command Line Tools (xcode-select --install)"
fi
c_ok "prereqs ok (node $(node -v), os $OS)"

# ---------- clone / update ----------
c_info "Fetching source → $SRC_DIR"
mkdir -p "$(dirname "$SRC_DIR")"
if [[ -d "$SRC_DIR/.git" ]]; then
  git -C "$SRC_DIR" fetch --quiet origin "$BRANCH"
  git -C "$SRC_DIR" checkout --quiet "$BRANCH"
  git -C "$SRC_DIR" reset --hard --quiet "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
fi
c_ok "source at $(git -C "$SRC_DIR" rev-parse --short HEAD)"

# ---------- daemon/CLI ----------
c_info "Building daemon + CLI"
cd "$SRC_DIR"
npm ci --silent --no-audit --no-fund
npm run --silent build
# Link `copilot-lights` into the user's PATH (PATH-aware, no sudo on most setups).
npm link --silent
c_ok "copilot-lights → $(command -v copilot-lights)"

# ---------- macOS menubar app ----------
if [[ "$OS" == "Darwin" && "$SKIP_MENUBAR" != "1" ]]; then
  c_info "Building macOS menubar app"
  ( cd "$SRC_DIR/macos" && bash Scripts/package_app.sh release >/dev/null )
  APP_SRC="$SRC_DIR/macos/Copilot Lights.app"
  APP_DEST="/Applications/Copilot Lights.app"
  if [[ -d "$APP_DEST" ]]; then
    c_info "Replacing existing $APP_DEST"
    rm -rf "$APP_DEST"
  fi
  cp -R "$APP_SRC" "$APP_DEST"
  # Strip any quarantine xattr (the install script just built the bundle
  # locally, but a fresh `cp -R` can still inherit one) so first-launch
  # Gatekeeper doesn't show a "cannot be opened" dialog on the ad-hoc
  # signed bundle.
  xattr -cr "$APP_DEST" 2>/dev/null || true
  # Register Launch at Login via launchctl (LSUIElement app, so no Dock icon).
  PLIST="$HOME/Library/LaunchAgents/com.copilot-lights.app.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.copilot-lights.app</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/open</string>
        <string>-a</string>
        <string>$APP_DEST</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><false/>
</dict>
</plist>
PLIST
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  open -a "$APP_DEST"
  c_ok "menubar app installed at $APP_DEST and started"
fi

# ---------- hooks + autostart ----------
c_info "Wiring Copilot CLI hooks"
copilot-lights install >/dev/null
c_ok "hooks wired in ~/.copilot/hooks/copilot-lights.json"

if [[ "$SKIP_AUTOSTART" != "1" ]]; then
  c_info "Enabling daemon autostart"
  copilot-lights enable-autostart >/dev/null
  c_ok "daemon autostart registered"
fi

# Kick the daemon now so the first prompt has a live state.
copilot-lights daemon >/dev/null 2>&1 &
disown || true
sleep 1

c_info "Doctor"
copilot-lights doctor || c_warn "doctor reported issues — review above"

cat <<'EOF'

──────────────────────────────────────────────
 Copilot Lights is installed.

 Next:
   1. Edit your light adapter config:
        ~/.copilot-lights/config.json
      (Hue, Home Assistant, or Govee — see README for examples.)
   2. Open the menubar icon to verify the daemon shows green.
   3. Run a Copilot CLI command and watch the colors.

 Manage anytime with:
   copilot-lights status    # what the daemon thinks
   copilot-lights doctor    # full health check
   copilot-lights uninstall # remove hooks (does not remove the app)
──────────────────────────────────────────────
EOF
