# The KriyaDot Jewels — brand palette

Designed 2026-10-09. Deep jewel tones, refined metallics, elegant duotones.
Every accent is a **135° gradient duotone** — the signature KriyaDot gradient
identity. Inspired by the *approach* of curated brand palettes (135°
gradient treatments, glass surfaces), with an original, classy color story —
no Octop colors.

## Signature identity

**Amethyst Crown** — royal violet `#6d3fc4` → luminous lavender `#b678e0` at
135°. Baked into all five themes as the default accent, so a fresh install
carries the brand with no stored choice.

## Curated picker accents (8)

| id        | Name            | Duotone (135°)        | Character                                  |
|-----------|-----------------|-----------------------|--------------------------------------------|
| `amethyst` | Amethyst Crown  | `#6d3fc4` → `#b678e0` | Signature. Royal violet → lavender         |
| `emerald`  | Emerald Court   | `#0b6e5d` → `#3ecf9a` | Deep emerald → jade                        |
| `sapphire` | Sapphire Dusk   | `#1d4fa8` → `#5aa9e6` | Deep sapphire → glacier blue               |
| `garnet`   | Garnet Ember    | `#9c2233` → `#e0722d` | Garnet → ember orange                      |
| `topaz`    | Gilded Topaz    | `#96620f` → `#e8b44b` | Antique bronze → champagne metallic        |
| `copper`   | Copper Rose     | `#8f4426` → `#e0956a` | Oxidised copper → rose metal               |
| `opal`     | Opal Mist       | `#52617a` → `#aebccf` | Slate → pearl metallic (monochrome calm)   |
| `peacock`  | Peacock Plume   | `#0b5c63` → `#35c9b4` | Deep teal → aquamarine                     |

Each accent ships **light** and **dark** luminance role sets (`from`, `to`,
`accent`, `hover`, `soft`, `ink`) so chips, toggles, focus rings and buttons
stay readable on every theme. Light + porcelain themes take the light set;
dark, midnight and ocean take the dark set.

## Where it lives

- `apps/web/lib/accent.ts` — palette definition, `getStoredAccent()`,
  `applyAccentChoice()`, `useAccent()` hook. localStorage key: `kriyadot:accent`
  (default `amethyst`; unknown values fall back, no migration needed).
- `apps/web/app/accents.css` — `html[data-accent='<id>']` variable overrides
  for the 7 non-default accents, `--brand-grad` helper, accent-picker styles.
- `apps/web/app/globals.css` — the five theme blocks carry the Amethyst Crown
  roles; 135° gradient treatments on the brand wordmark, `.btn-primary`,
  toggle knobs, active nav indicators, and assistant chat bubbles.
- `apps/web/app/pet.css` — static brand glow on thinking/working pet states
  (no motion; survives `prefers-reduced-motion`).
- `apps/web/components/accent/AccentPicker.tsx` — the Preferences page picker.

## Design rules

- Brand gradient treatments stay **subtle**: full duotone only on primary CTAs
  and the wordmark; everywhere else is a low-mix tint over existing surfaces.
- Claymorphism + glassmorphism stay as-is; accents recolor variables, never
  restyle components.
- No new motion was added; all existing `prefers-reduced-motion` and
  `data-ux="simple"` gates remain untouched.
