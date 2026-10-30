// SPDX-License-Identifier: Apache-2.0
// CA-22 runner for the KriyaDot GitHub Action. Zero dependencies.
// It calls the KriyaDot instance API; PR review posting (when
// KRIYADOT_REVIEW_PR is set) goes through the instance's approval-gated
// POST /api/github/pr review path — this script never talks to the
// GitHub API directly and never holds a GitHub token.
const base = (process.env.KRIYADOT_URL || '').replace(/\/$/, '');
const token = process.env.KRIYADOT_TOKEN || '';
const task = process.env.KRIYADOT_TASK || '';
const bot = process.env.KRIYADOT_BOT || 'coder';
const reviewPr = process.env.KRIYADOT_REVIEW_PR || '';
if (!base || !task) {
  console.error('KRIYADOT_URL and KRIYADOT_TASK are required');
  process.exit(1);
}
const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
const res = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ botId: bot, message: task }),
});
if (!res.ok) {
  console.error(`KriyaDot run failed (${res.status}): ${await res.text()}`);
  process.exit(1);
}
const data = await res.json();
const text = data.text || data.response || JSON.stringify(data);
console.log(text);
if (reviewPr) {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '/').split('/');
  const review = await fetch(`${base}/api/github/pr/review`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ owner, repo, number: Number(reviewPr), event: 'COMMENT', body: text }),
  });
  if (!review.ok) {
    console.error(`KriyaDot review post failed (${review.status}) — a governance approval may be pending on the instance.`);
    process.exit(1);
  }
  console.log(`Posted KriyaDot review on ${owner}/${repo}#${reviewPr}`);
}
