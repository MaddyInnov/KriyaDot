// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { IdeaStore, USER_DISMISSAL } from './index.js';

describe('IdeaStore', () => {
  let db: ModuleDb;
  let store: IdeaStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new IdeaStore(db);
  });

  it('creates ideas as new', () => {
    const idea = store.create({ title: 'AI sourdough coach', description: 'An app' });
    expect(idea.status).toBe('new');
    expect(store.list('new')).toHaveLength(1);
  });

  it('validates title', () => {
    expect(() => store.create({ title: '' })).toThrow(ValidationError);
    expect(() => store.get('nope')).toThrow(NotFoundError);
  });

  it('run → complete lifecycle', () => {
    const idea = store.create({ title: 'x' });
    expect(store.run(idea.id).status).toBe('active');
    expect(store.complete(idea.id).status).toBe('done');
  });

  it('dismiss and re-run', () => {
    const idea = store.create({ title: 'x' });
    expect(store.dismiss(idea.id, USER_DISMISSAL).status).toBe('dismissed');
    expect(store.run(idea.id).status).toBe('active');
  });

  it('rejects illegal transitions', () => {
    const idea = store.create({ title: 'x' });
    expect(() => store.complete(idea.id)).toThrow(ValidationError); // new → done illegal
    store.run(idea.id);
    expect(() => store.run(idea.id)).toThrow(ValidationError); // active → active illegal
    store.complete(idea.id);
    expect(() => store.dismiss(idea.id, USER_DISMISSAL)).toThrow(ValidationError); // done → dismissed illegal
  });
});
