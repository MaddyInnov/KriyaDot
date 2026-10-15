// SPDX-License-Identifier: Apache-2.0
// Brand accent picker: grid of the 8 KriyaDot Jewels duotones with live
// 135° gradient swatches. Selecting applies instantly across all themes.

'use client';

import { ACCENTS, useAccent, type AccentDef } from '../../lib/accent';

export function AccentPicker() {
  const [id, setAccent, def] = useAccent();

  return (
    <div>
      <div className="accent-grid" role="radiogroup" aria-label="Choose your brand accent">
        {ACCENTS.map((a: AccentDef) => {
          const selected = a.id === id;
          return (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`card accent-card${selected ? ' selected' : ''}`}
              onClick={() => setAccent(a.id)}
              title={a.blurb}
            >
              <span
                className="accent-swatch"
                aria-hidden="true"
                style={{ background: `linear-gradient(135deg, ${a.swatch[0]}, ${a.swatch[1]})` }}
              />
              <span className="accent-name">{a.name}</span>
            </button>
          );
        })}
      </div>
      <p className="small muted">{def.blurb}</p>
    </div>
  );
}
