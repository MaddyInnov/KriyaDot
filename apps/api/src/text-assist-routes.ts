// SPDX-License-Identifier: Apache-2.0
// Composer text assist (chat polish): polish draft text with a cheap
// model, and fetch the composer insertion text for a skill.
//
// HOST WIRING (parent):
//   app.use('/api', createTextAssistRouter({
//     complete: (text) => cheapModelComplete(text),       // injected
//     skills: skillCatalog,                                // id → record/map or fn
//     audit }));
// Routes: POST /text-assist/polish { text } → { ok, text }
//         POST /text-assist/skill  { skillId } → { ok, skillId, text }

import express from 'express';

export interface TextAssistSkill { id: string; name?: string; insertionText?: string; prompt?: string; description?: string }

export interface TextAssistDeps {
  /** Cheap-model completion: receives the raw draft, returns polished text. Injected so tests stub it. */
  complete: (text: string) => Promise<string> | string;
  /** Skill lookup: a record, a Map, or a function. */
  skills?: Record<string, TextAssistSkill> | Map<string, TextAssistSkill> | ((skillId: string) => TextAssistSkill | undefined | Promise<TextAssistSkill | undefined>);
  audit?: (action: string, fields: Record<string, unknown>) => void;
}

export const MAX_POLISH_CHARS = 8000;

/** Default composer insertion text for a skill without an explicit one. */
export function defaultSkillInsertion(skill: TextAssistSkill): string {
  return skill.insertionText ?? skill.prompt ?? `/${skill.id} `;
}

async function lookupSkill(deps: TextAssistDeps, skillId: string): Promise<TextAssistSkill | undefined> {
  const s = deps.skills;
  if (!s) return undefined;
  if (typeof s === 'function') return s(skillId);
  if (s instanceof Map) return s.get(skillId);
  return s[skillId];
}

export function createTextAssistRouter(deps: TextAssistDeps): express.Router {
  const router = express.Router();
  router.post('/text-assist/polish', async (req, res) => {
    const text = (req.body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || !text.trim()) { res.status(400).json({ ok: false, error: 'body.text is required' }); return; }
    if (text.length > MAX_POLISH_CHARS) { res.status(400).json({ ok: false, error: `text exceeds ${MAX_POLISH_CHARS} characters` }); return; }
    try {
      const polished = (await deps.complete(text)).trim();
      deps.audit?.('chat.text_polish', { detail: { chars: text.length } });
      res.json({ ok: true, text: polished || text, changed: polished !== text });
    } catch (e) {
      res.status(502).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  router.post('/text-assist/skill', async (req, res) => {
    const skillId = (req.body as { skillId?: unknown } | null)?.skillId;
    if (typeof skillId !== 'string' || !skillId.trim()) { res.status(400).json({ ok: false, error: 'body.skillId is required' }); return; }
    const skill = await lookupSkill(deps, skillId.trim());
    if (!skill) { res.status(404).json({ ok: false, error: `unknown skill "${skillId}"` }); return; }
    res.json({ ok: true, skillId: skill.id, name: skill.name ?? skill.id, text: defaultSkillInsertion(skill) });
  });
  return router;
}
