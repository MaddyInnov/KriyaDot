// SPDX-License-Identifier: Apache-2.0
// Pet picker: grid of the 8 companion styles with live previews + rename.

'use client';

import React, { useEffect, useState } from 'react';
import { PETS, usePet, type PetDef } from '../../lib/pet';
import { Pet } from './Pet';

export function PetPicker() {
  const { choice, def, setPet, setName } = usePet();
  const [draft, setDraft] = useState(choice.name);

  // Keep the rename box in sync if the choice changes elsewhere.
  useEffect(() => {
    setDraft(choice.name);
  }, [choice.name, choice.id]);

  const saveName = () => setName(draft.trim());

  return (
    <div>
      <div className="pet-grid" role="radiogroup" aria-label="Choose your companion pet">
        {PETS.map((p: PetDef) => {
          const selected = p.id === choice.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`card pet-card${selected ? ' selected' : ''}`}
              onClick={() => setPet(p.id)}
              title={p.blurb}
            >
              <Pet pet={p.id} size={76} mood={selected ? 'happy' : 'idle'} label={`${p.name} preview`} variant="2d" />
              <span className="pet-name">{p.name}</span>
              <span className="pet-tag">{p.tagline}</span>
            </button>
          );
        })}
      </div>
      <p className="small muted">{def.blurb}</p>
      <div className="pet-rename">
        <label htmlFor="pet-name-input" className="small">
          <strong>Name your companion</strong>
        </label>
        <input
          id="pet-name-input"
          className="input"
          value={draft}
          maxLength={24}
          placeholder={def.name}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveName();
          }}
        />
        <button type="button" className="btn btn-sm" onClick={saveName}>
          Save name
        </button>
      </div>
    </div>
  );
}
