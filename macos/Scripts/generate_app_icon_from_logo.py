#!/usr/bin/env python3
"""Regenerate macos/Icon.iconset/*.png (and Icon.icns) from the brand logo.

The source of truth is ``assets/logo.png`` — the full "Copilot Lights" poster.
The app icon is the poster's *hero* (the pendant lamp casting a rainbow beam
onto the Copilot robot), cropped to a square on the dark background so it reads
as a clean full-bleed macOS icon at every size.

Usage:
    python3 macos/Scripts/generate_app_icon_from_logo.py [path/to/logo.png]

Requires Pillow. After running, package_app.sh picks up Icon.iconset /
Icon.icns automatically.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image

# Hero crop, expressed as fractions of the (square) poster so it survives a
# re-export at a different resolution. Tuned to the 1254x1254 master:
#   top  = 128/1254 ≈ 0.1021   (just above the lamp cord)
#   bot  = 700/1254 ≈ 0.5582   (the dark gap below the beam, above the title)
#   cx   = 0.5                  (the beam is horizontally centered)
HERO_TOP_FRAC = 0.1021
HERO_BOTTOM_FRAC = 0.5582

# (filename, pixel size) — the standard macOS .iconset set this repo ships.
ICONSET = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_64x64.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
    ("icon_1024x1024.png", 1024),
]


def hero_crop(logo: Image.Image) -> Image.Image:
    w, h = logo.size
    cx = w / 2.0
    top = int(round(HERO_TOP_FRAC * h))
    bottom = int(round(HERO_BOTTOM_FRAC * h))
    side = bottom - top
    left = int(round(cx - side / 2.0))
    right = left + side
    # Clamp to image bounds.
    left = max(0, left)
    right = min(w, right)
    top = max(0, top)
    bottom = min(h, bottom)
    return logo.crop((left, top, right, bottom))


def main() -> int:
    macos_root = Path(__file__).resolve().parent.parent
    repo_root = macos_root.parent
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else repo_root / "assets" / "logo.png"
    if not src.exists():
        print(f"error: logo not found at {src}", file=sys.stderr)
        return 1

    logo = Image.open(src).convert("RGBA")
    hero = hero_crop(logo)
    # Master 1024 square we downscale every size from (LANCZOS keeps small
    # sizes crisp instead of compounding resample blur).
    master = hero.resize((1024, 1024), Image.LANCZOS)

    iconset_dir = macos_root / "Icon.iconset"
    iconset_dir.mkdir(exist_ok=True)
    for filename, size in ICONSET:
        master.resize((size, size), Image.LANCZOS).save(iconset_dir / filename)
        print(f"  wrote {filename} ({size}px)")

    # Convert to .icns (best-effort; iconutil is macOS-only).
    icns = macos_root / "Icon.icns"
    try:
        subprocess.run(
            ["iconutil", "--convert", "icns", "--output", str(icns), str(iconset_dir)],
            check=True,
        )
        print(f"  wrote {icns.name}")
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        print(f"warning: iconutil failed ({exc}); package_app.sh will convert", file=sys.stderr)

    print("Done. Icon regenerated from", src)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
