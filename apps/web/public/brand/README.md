# KriyaDot brand + companion assets

## Brand rule: Hologram is the sole brand icon

The Hologram is the only brand mark. Every icon, favicon, landing logo and
launcher icon in the product is derived from the Hologram master only.
Voxel and Droplet (below) are selectable companions (pets) ONLY — never
use them for any icon / favicon / landing / launcher surface.

Provenance: user-approved generated artwork, approved 2026-11-07.
Master file: `hologram-master.png` (1600x1600 PNG, byte copy of the approved
master) — a face of cyan/violet light-lines, golden-particle eyes/smile,
orbiting gold fireflies, on a deep navy background; face centre is
approximately (800, 735) in master coordinates, with a light-stream flowing
from the chin to the bottom edge.

## Approved crop geometry

Both crops are taken directly from the master with PIL and resized with
LANCZOS. Do not re-derive them by eye — use exactly these boxes:

- "icon" square: crop box (left=275, top=155, right=1325, bottom=1205)
  -> 1050x1050, face-centred, full-bleed.
- "avatar" square: crop box (left=400, top=268, right=1200, bottom=1068)
  -> 800x800, tighter face crop for circular avatar use.

## Files in this folder

- `hologram-master.png` — byte copy of the 1600x1600 master.
- `hologram-icon.png` — icon crop resized to 1024x1024.
- `hologram-icon-512.png` — icon crop resized to 512x512.
- `hologram-avatar.png` — avatar crop resized to 800x800.
- `hologram-avatar-512.png` — avatar crop resized to 512x512.
- `hologram-avatar-256.png` — avatar crop resized to 256x256.
- `voxel-master.png` — byte copy of the 1600x1600 Voxel master (companions only).
- `voxel-avatar.png` — Voxel crop resized to 800x800.
- `voxel-avatar-256.png` — Voxel crop resized to 256x256.
- `droplet-master.png` — byte copy of the 1600x1600 Droplet master (companions only).
- `droplet-avatar.png` — Droplet crop resized to 800x800.
- `droplet-avatar-256.png` — Droplet crop resized to 256x256.

## Companion masters: Voxel and Droplet (companions only — NOT brand marks)

Provenance: user-approved generated artwork, added 2026-11-07 alongside the
Hologram set. Both masters are 1600x1600 PNGs, stored here as byte copies.
They exist so users can pick Voxel or Droplet as their companion/pet; they
must never replace or supplement the Hologram on any brand surface.

- Voxel — `voxel-master.png`: chunky blue-to-violet voxel-cube character,
  offset centre approximately (0.46, 0.50) in normalised coordinates; its
  golden companion cube sits at the right edge (approximately x 0.87) and
  must stay in frame. Avatar crop: square centred on (0.50, 0.50), width
  approximately 1420px — crop box (left=90, top=90, right=1510, bottom=1510)
  -> 1420x1420, resized with LANCZOS to `voxel-avatar.png` (800x800) and
  `voxel-avatar-256.png` (256x256). The box deliberately keeps the golden
  cube in frame at the right edge.
- Droplet — `droplet-master.png`: fuzzy light-blue-to-violet plush droplet,
  centred approximately (0.50, 0.50), filling most of the frame. Avatar
  crop: square centred on (0.50, 0.50), width approximately 1330px — crop
  box (left=135, top=115, right=1465, bottom=1445) -> 1330x1330, resized
  with LANCZOS to `droplet-avatar.png` (800x800) and
  `droplet-avatar-256.png` (256x256).

## How each platform set was derived

All platform icons below are resizes (PIL, LANCZOS) of the icon crop unless
noted; no other artwork source was used.

- Web app (`apps/web/public/`): `icons/icon-192.png` (192),
  `icons/icon-512.png` (512), `icons/apple-touch-icon.png` (180) and
  `favicon.ico.png` (64, PNG content under the legacy filename) — all from
  the icon crop.
- Tauri desktop (`apps/desktop/src-tauri/icons/`): `32x32.png` (32),
  `128x128.png` (128), `128x128@2x.png` (256) and `icon.png` (1024) from the
  icon crop; `icon.ico` is a multi-resolution ICO (16/24/32/48/64/128/256)
  generated from the icon crop via PIL `save(format='ICO', sizes=[...])`.
- Landing site (`site/assets/`): `logo.png` (icon crop at 512) is the
  favicon; `logo-256.png` (icon crop at 256) is used for the header and
  footer brand marks in `site/index.html`. The previous `logo.svg` is kept
  in place for any other references.
- Android (`android-companion/` and `android-phone-agent/`): adaptive-icon
  foregrounds `res/mipmap-<density>/ic_launcher_foreground.png` from the
  icon crop at mdpi 108, hdpi 162, xhdpi 216, xxhdpi 324, xxxhdpi 432;
  legacy `ic_launcher.png` at 48/72/96/144/192 and `ic_launcher_round.png`
  at the same sizes with a circular alpha mask applied via PIL. Adaptive
  background colour is `#060913` (`@color/ic_launcher_background`, sampled
  from the master's navy corner).
- iOS (`ios-companion/KriyaDotCompanion/Assets.xcassets/AppIcon.appiconset/`):
  one PNG per size/scale declared in `Contents.json`, each from the icon
  crop at the declared point size times its scale (marketing icon 1024x1024).
