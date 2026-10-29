// SPDX-License-Identifier: Apache-2.0
// answer_for_person — Chief tool for the representative assistant.
//
// When a teammate asks a factual question about a person (directly, or by
// @mentioning them with a question), a Chief bot calls this tool. The
// RepresentativeService enforces the owner's policy: disabled → refusal,
// asker/fact-type not allowed → refusal, out-of-scope → refusal + an
// offer to relay via relay_to_person (which stays approval-gated).
// Successful answers are provenance-fenced and fact-cited; the owner is
// notified per their policy and every attempt is audit-recorded.

import type { ToolDefinition } from '../types.js';
import type { PeopleStore } from '../people.js';
import type { RepresentativeService } from '../representative.js';

export interface AnswerForPersonToolDeps {
  people: Pick<PeopleStore, 'getPerson' | 'findByName' | 'listPeople'>;
  representative: Pick<RepresentativeService, 'answer'>;
}

export function createAnswerForPersonTool(deps: AnswerForPersonToolDeps): ToolDefinition {
  return {
    name: 'answer_for_person',
    description: [
      'Answer a teammate\'s factual question about a person USING THAT PERSON\'S REPRESENTATIVE,',
      'under the policy the person set (enabled fact types: availability, status, shared-notes,',
      'public-profile; allowed askers). Returns a provenance-fenced, fact-cited answer, or a',
      'refusal — on refusal, offer to use relay_to_person instead (approval-gated).',
      'Arguments: "person" (person id or exact name), "question", "asker" (person id of who is asking).',
      'Never use this to get opinions, decisions, or anything beyond the four fact types.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        person: { type: 'string', description: 'Person id (per_…) or exact display name' },
        question: { type: 'string', description: 'The factual question being asked about the person' },
        asker: { type: 'string', description: 'Person id of the teammate asking' },
      },
      required: ['person', 'question', 'asker'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const personRef = typeof args.person === 'string' ? args.person.trim() : '';
      const question = typeof args.question === 'string' ? args.question : '';
      const asker = typeof args.asker === 'string' ? args.asker.trim() : '';
      if (!personRef) return { error: 'answer_for_person needs "person"' };
      if (!question.trim()) return { error: 'answer_for_person needs a non-empty "question"' };
      if (!asker) return { error: 'answer_for_person needs "asker" (the asking person\'s id)' };
      const person = deps.people.getPerson(personRef) ?? deps.people.findByName(personRef);
      if (!person) {
        const known = deps.people.listPeople().map((p) => `${p.id} (${p.name})`).join(', ');
        return { error: `Unknown person "${personRef}". People directory: ${known || '(empty)'}` };
      }
      const result = await deps.representative.answer({ personId: person.id, askerId: asker, question });
      if (!result.answered) {
        return {
          answered: false,
          personId: person.id,
          personName: person.name,
          factType: result.factType,
          refusal: result.refusal,
          offerRelay: result.offerRelay,
          auditId: result.auditId,
        };
      }
      return {
        answered: true,
        personId: person.id,
        personName: person.name,
        factType: result.factType,
        text: result.text,
        facts: result.facts,
        auditId: result.auditId,
      };
    },
  };
}
