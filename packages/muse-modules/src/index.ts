// SPDX-License-Identifier: Apache-2.0
// @mvp/muse-modules — Muse-parity modules for the all-in-one AI agent SaaS
// platform MVP (Phase 4, Workstream E).
//
// 15 modules, each with its own store + logic + colocated vitest tests:
//   feed, reminders, goals (+milestones), commitments, watchers, artifacts,
//   media, calls, threads, research, browser, ideas, shopping, places,
//   social, meetings, slides.
// Shared: ModuleDb (one muse-modules.db, namespaced tables), error types,
// and registerMuseModuleTools() for the agent-invokable tools.

export { ModuleDb } from './db.js';
export { NotFoundError, ValidationError, statusForError, messageForError } from './errors.js';
export * from './feed/index.js';
export * from './reminders/index.js';
export * from './goals/index.js';
export * from './commitments/index.js';
export * from './watchers/index.js';
export * from './artifacts/index.js';
export * from './artifacts/exports.js';
export * from './artifacts/ooxml.js';
export * from './artifacts/markdown.js';
export * from './artifacts/docx.js';
export * from './artifacts/xlsx.js';
export * from './artifacts/pptx.js';
export * from './media/index.js';
export * from './calls/index.js';
export * from './threads/index.js';
export * from './research/index.js';
export * from './browser/index.js';
export * from './browser/real.js';
export * from './ideas/index.js';
export * from './shopping/index.js';
export * from './shopping/visual-match.js';
export * from './places/index.js';
export * from './social/index.js';
export * from './meetings/index.js';
export * from './slides/index.js';
export * from './knowledge-base/index.js';
export * from './entities/index.js';
export { registerMuseModuleTools, museModuleToolPolicies, tagUntrusted } from './tools.js';
export type { MuseModuleToolOptions } from './tools.js';
