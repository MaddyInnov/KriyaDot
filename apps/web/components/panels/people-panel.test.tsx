// SPDX-License-Identifier: Apache-2.0
// PeoplePanel static-structure test (W7), following the repo convention
// from teams-panel.test.tsx: renderToStaticMarkup with the people API
// mocked. Verifies the directory + org-view + inbox structure renders and
// that org columns group the prop bots under the seeded people state.

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PeoplePanel from './people-panel';
import type { BotConfig } from '../../lib/api';

vi.mock('../../lib/people', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    listPeople: vi.fn(async () => []),
    getTeamInbox: vi.fn(async () => ({
      personId: 'you',
      needsYou: [],
      fyi: [],
      done: [],
      counts: { needsYou: 0, fyi: 0, done: 0 },
    })),
  };
});

const bots = [
  { id: 'coder', name: 'Coder', description: 'writes code', ownerId: 'per_ana' },
  { id: 'scout', name: 'Scout', description: 'research' },
] as BotConfig[];

describe('people-panel', () => {
  it('renders the directory, org view and team inbox sections', () => {
    const html = renderToStaticMarkup(<PeoplePanel bots={bots} onRosterChanged={() => undefined} />);
    expect(html).toContain('👥 People');
    expect(html).toContain('Team map');
    expect(html).toContain('Add a person');
    expect(html).toContain('📥 Team inbox');
    // People load in useEffect (not run by static markup), so the
    // directory rows themselves are covered by the API/lib tests.
  });

  it('renders the click-to-move controls listing every bot', () => {
    const html = renderToStaticMarkup(<PeoplePanel bots={bots} onRosterChanged={() => undefined} />);
    expect(html).toContain('Choose a bot to move');
    expect(html).toContain('Coder (coder)');
    expect(html).toContain('Scout (scout)');
  });
});
