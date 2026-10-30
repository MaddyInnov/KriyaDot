// SPDX-License-Identifier: Apache-2.0
//
// Example JS-orchestration workflow (D-2). A JS workflow is a plain
// JavaScript module that assigns its definition to `exports.workflow`.
// Steps run in order; each step's `code` is a function body executed in
// the workflow code sandbox, where `input` is the previous step's output
// (the run input for the first step) and `nodes.<stepId>.output` reaches
// any earlier step. Register it with JsWorkflowRunner.registerSource()
// (packages/workflows/src/js-runner.ts) — it compiles to a DAG and runs
// through the standard WorkflowRunner with the same governance and run
// records as a DAG workflow.
//
// Run input example: { "items": [{ "price": 10 }, { "price": 5 }] }
// Final output:      { "subtotal": 15, "total": 18 }

exports.workflow = {
  id: 'example-invoice-total',
  name: 'Invoice total (JS format example)',
  description: 'Sums item prices, then applies a flat 20% tax step.',
  steps: [
    {
      id: 'subtotal',
      name: 'Sum item prices',
      code: 'return { subtotal: input.items.reduce((sum, item) => sum + item.price, 0) };',
    },
    {
      id: 'with-tax',
      name: 'Apply tax',
      code: 'return { subtotal: input.subtotal, total: Math.round(input.subtotal * 1.2 * 100) / 100 };',
    },
  ],
};
