// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { ArtifactStore } from './index.js';

describe('ArtifactStore', () => {
  let db: ModuleDb;
  let store: ArtifactStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new ArtifactStore(db);
  });

  it('creates a v1 artifact', () => {
    const a = store.create({ title: 'Launch plan', content: '# Plan\n\nv1' });
    expect(a.version).toBe(1);
    expect(a.content).toBe('# Plan\n\nv1');
  });

  it('validates title and content', () => {
    expect(() => store.create({ title: '', content: 'x' })).toThrow(ValidationError);
    expect(() => store.create({ title: 't', content: '  ' })).toThrow(ValidationError);
    expect(() => store.get('nope')).toThrow(NotFoundError);
  });

  it('update() appends immutable versions', () => {
    const a = store.create({ title: 'Doc', content: 'v1' });
    const v2 = store.update(a.id, 'v2');
    expect(v2.version).toBe(2);
    expect(v2.content).toBe('v2');
    expect(store.getVersion(a.id, 1).content).toBe('v1');
    expect(store.versions(a.id).map((v) => v.version)).toEqual([1, 2]);
  });

  it('lists most-recently-updated first', () => {
    const a = store.create({ title: 'a', content: 'x' });
    const b = store.create({ title: 'b', content: 'x' });
    store.update(a.id, 'x2');
    expect(store.list().map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it('remove() deletes the artifact and all versions atomically', () => {
    const a = store.create({ title: 'a', content: 'v1' });
    store.update(a.id, 'v2');
    store.remove(a.id);
    expect(() => store.get(a.id)).toThrow(NotFoundError);
    expect(store.list()).toEqual([]);
    expect(() => store.remove(a.id)).toThrow(NotFoundError);
    // A fresh artifact is unaffected.
    const b = store.create({ title: 'b', content: 'x' });
    expect(store.get(b.id).content).toBe('x');
  });

  it('unknown version throws NotFoundError', () => {
    const a = store.create({ title: 'a', content: 'x' });
    expect(() => store.getVersion(a.id, 99)).toThrow(NotFoundError);
  });
});
