// SPDX-License-Identifier: Apache-2.0
// Server-rendered app-shell pages for the signed-in front door. Plain HTML
// strings + small vanilla JS against the frontdoor JSON APIs; visual identity
// matches the landing (jewel palette, glass/clay, light/dark via
// prefers-color-scheme). Shared CSS lives in public/app.css, served at
// /frontdoor-assets/app.css.

function shell(title: string, body: string, script: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — KriyaDot</title>
<link rel="stylesheet" href="/frontdoor-assets/app.css">
</head>
<body>
<header class="fd-nav">
  <a class="fd-brand" href="/app"><span class="fd-jewel">◆</span> KriyaDot</a>
  <nav>
    <a href="/app">Dashboard</a>
    <a href="/app/chat">Chat</a>
    <a href="/app/lightning">Lightning</a>
    <a href="/app/plan">Plan</a>
    <a href="/app/whats-new">What's new</a>
    <a href="/">Site</a>
  </nav>
</header>
<main class="fd-main">
${body}
</main>
<script>
${script}
</script>
</body>
</html>`;
}

const API_HELPERS = `
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error('request failed: ' + res.status);
  return res.json();
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function goToWorkspace(id) {
  const data = await api('/api/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: id }) });
  window.location.href = data.redirectUrl;
}
`;

const LINK_CODE_JS = `
async function generateLinkCode() {
  const out = document.getElementById('link-code-out');
  try {
    const data = await api('/api/link-codes', { method: 'POST' });
    out.innerHTML = 'Your link code: <strong class="fd-code">' + esc(data.code) + '</strong> ' +
      '<span class="fd-muted">(expires ' + esc(new Date(data.expiresAt).toLocaleTimeString()) + ', single use)</span>';
  } catch (e) {
    out.textContent = 'Could not generate a code — please reload and try again.';
  }
}
`;

const CONNECT_EXPLAINER = `
<section class="fd-card">
  <h2>Connect your cloud workspace</h2>
  <p>You don't have a workspace linked yet. Your bots run on <strong>your own</strong>
  Lightning cloud instance — this site only introduces you to it.</p>
  <ol class="fd-steps">
    <li><strong>Create a Lightning account</strong> — the same Google login works there.
      <a href="https://lightning.ai/" target="_blank" rel="noopener">Open Lightning</a></li>
    <li><strong>In the KriyaDot app, connect Lightning and deploy</strong> — the app provisions
      your personal instance on your account.</li>
    <li><strong>Link it here</strong> — generate a one-time link code below and paste it in the
      app (Settings → Front door link). Your workspace then appears on this page on every device.</li>
  </ol>
  <button class="fd-btn" onclick="generateLinkCode()">Generate a link code</button>
  <p id="link-code-out" class="fd-muted"></p>
</section>`;

export function dashboardPage(): string {
  const body = `
<h1>Your front door</h1>
<section class="fd-card" id="profile-card"><p class="fd-muted">Loading your profile…</p></section>
<section id="workspaces"><p class="fd-muted">Loading workspaces…</p></section>
<div id="connect-slot"></div>
<section class="fd-card">
  <h2>Link another workspace</h2>
  <p class="fd-muted">Generate a one-time code, then paste it in the KriyaDot app to link that instance to your account.</p>
  <button class="fd-btn" onclick="generateLinkCode()">Generate a link code</button>
  <p id="link-code-out" class="fd-muted"></p>
</section>`;
  const script = `
${API_HELPERS}
${LINK_CODE_JS}
const CONNECT_HTML = ${JSON.stringify(CONNECT_EXPLAINER)};
(async () => {
  try {
    const me = await api('/api/me');
    document.getElementById('profile-card').innerHTML =
      '<div class="fd-profile">' +
      (me.picture ? '<img class="fd-avatar" src="' + esc(me.picture) + '" alt="">' : '<span class="fd-avatar fd-avatar-fallback">◆</span>') +
      '<div><strong>' + esc(me.name) + '</strong><br><span class="fd-muted">' + esc(me.email) + '</span></div></div>';
  } catch (e) { document.getElementById('profile-card').textContent = 'Could not load your profile.'; }
  try {
    const data = await api('/api/workspaces');
    const slot = document.getElementById('workspaces');
    if (!data.workspaces.length) {
      slot.innerHTML = '';
      document.getElementById('connect-slot').innerHTML = CONNECT_HTML;
      return;
    }
    slot.innerHTML = data.workspaces.map((w) =>
      '<section class="fd-card fd-launcher">' +
      '<div><strong>' + esc(w.name) + '</strong> ' +
      '<span class="fd-status fd-status-' + esc(w.status) + '">' + esc(w.status) + '</span><br>' +
      '<span class="fd-muted">' + esc(w.instanceUrl) + (w.tier ? ' · tier reported by instance: ' + esc(w.tier) : '') + '</span></div>' +
      '<div class="fd-actions">' +
      '<button class="fd-btn fd-btn-big" onclick="goToWorkspace(\\'' + esc(w.id) + '\\')">Go to my workspace</button>' +
      '<button class="fd-btn" onclick="goToWorkspace(\\'' + esc(w.id) + '\\')">Open chat</button>' +
      '<button class="fd-btn fd-btn-ghost" onclick="removeWorkspace(\\'' + esc(w.id) + '\\')">Remove</button>' +
      '</div></section>'
    ).join('');
  } catch (e) { document.getElementById('workspaces').textContent = 'Could not load workspaces.'; }
})();
async function removeWorkspace(id) {
  await api('/api/workspaces/' + encodeURIComponent(id) + '/remove', { method: 'POST' });
  window.location.reload();
}
`;
  return shell('Dashboard', body, script);
}

export function chatPage(): string {
  const body = `
<h1>Chat</h1>
<section class="fd-card" id="chat-slot"><p class="fd-muted">Finding your workspace…</p></section>
<div id="connect-slot"></div>`;
  const script = `
${API_HELPERS}
${LINK_CODE_JS}
const CONNECT_HTML = ${JSON.stringify(CONNECT_EXPLAINER)};
(async () => {
  try {
    const data = await api('/api/workspaces');
    if (!data.workspaces.length) {
      document.getElementById('chat-slot').innerHTML =
        '<h2>No workspace yet</h2><p class="fd-muted">Chat runs on your own instance, not on this site. Connect one and this page hands you straight into it.</p>';
      document.getElementById('connect-slot').innerHTML = CONNECT_HTML;
      return;
    }
    const w = data.workspaces[0];
    document.getElementById('chat-slot').innerHTML =
      '<p>Taking you to <strong>' + esc(w.name) + '</strong>…</p>';
    await goToWorkspace(w.id);
  } catch (e) {
    document.getElementById('chat-slot').textContent = 'Could not start the handoff — please reload and try again.';
  }
})();
`;
  return shell('Chat', body, script);
}

export function lightningPage(): string {
  const body = `
<h1>Lightning — your cloud</h1>
<section class="fd-card">
  <p>Your KriyaDot cloud instance runs on <strong>your own Lightning account</strong>. Plans and
  billing are between you and Lightning — KriyaDot never resells or marks them up, and this page
  never invents usage numbers: it shows only what your instances report.</p>
  <p><a class="fd-btn" href="https://lightning.ai/pricing" target="_blank" rel="noopener">See Lightning pricing</a>
  <a class="fd-btn fd-btn-ghost" href="https://lightning.ai/" target="_blank" rel="noopener">Open Lightning billing</a></p>
</section>
<section class="fd-card" id="tiers"><p class="fd-muted">Loading tiers…</p></section>
<section class="fd-card" id="ln-workspaces"><p class="fd-muted">Loading your workspaces…</p></section>`;
  const script = `
${API_HELPERS}
(async () => {
  try {
    const data = await api('/api/lightning');
    document.getElementById('tiers').innerHTML = '<h2>Lightning tiers</h2>' +
      data.tiers.map((t) => '<p><strong>' + esc(t.name) + '</strong> — <a href="' + esc(data.pricingUrl) + '" target="_blank" rel="noopener">details on lightning.ai</a></p>').join('');
    document.getElementById('ln-workspaces').innerHTML = '<h2>Your workspaces</h2>' +
      (data.workspaces.length
        ? data.workspaces.map((w) => '<p><strong>' + esc(w.name) + '</strong> — tier reported by instance: ' + esc(w.tierReportedByInstance ?? 'not reported') + '</p>').join('')
        : '<p class="fd-muted">No workspaces linked yet.</p>');
  } catch (e) { document.getElementById('tiers').textContent = 'Could not load Lightning info.'; }
})();
`;
  return shell('Lightning', body, script);
}

export function planPage(): string {
  const body = `
<h1>Your plan</h1>
<section class="fd-card" id="plan-card"><p class="fd-muted">Loading…</p></section>`;
  const script = `
${API_HELPERS}
(async () => {
  try {
    const data = await api('/api/plan');
    document.getElementById('plan-card').innerHTML =
      '<p><strong>' + esc(data.platform) + '</strong></p><p>' + esc(data.note) + '</p>' +
      '<p class="fd-muted">License gating enabled: ' + (data.gatingEnabled ? 'yes' : 'no') + '</p>';
  } catch (e) { document.getElementById('plan-card').textContent = 'Could not load plan info.'; }
})();
`;
  return shell('Plan', body, script);
}

export function whatsNewPage(): string {
  const body = `
<h1>What's new</h1>
<section id="releases"><p class="fd-muted">Loading releases from GitHub…</p></section>`;
  const script = `
${API_HELPERS}
(async () => {
  try {
    const data = await api('/api/changelog');
    const slot = document.getElementById('releases');
    if (!data.releases.length) {
      slot.innerHTML = '<section class="fd-card"><p class="fd-muted">No release notes available right now — see <a href="https://github.com/MaddyInnov/KriyaDot/releases" target="_blank" rel="noopener">GitHub releases</a>.</p></section>';
      return;
    }
    slot.innerHTML = data.releases.map((r) =>
      '<section class="fd-card"><h2><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' +
      esc(r.name || r.tag) + '</a> <span class="fd-muted">' + esc(r.tag) + '</span></h2>' +
      '<p class="fd-muted">' + esc(new Date(r.publishedAt).toLocaleDateString()) + '</p>' +
      '<p>' + esc(r.notesExcerpt) + '</p></section>'
    ).join('');
  } catch (e) { document.getElementById('releases').textContent = 'Could not load the changelog.'; }
})();
`;
  return shell("What's new", body, script);
}

export function signInNotConfiguredPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign-in not configured — KriyaDot</title>
<link rel="stylesheet" href="/frontdoor-assets/app.css">
</head>
<body>
<main class="fd-main">
<section class="fd-card">
  <h1>Sign-in is not configured yet</h1>
  <p>Google sign-in has not been set up on this frontdoor deployment, so accounts and
  workspaces are unavailable here. The landing site still works, and the KriyaDot desktop
  app is fully usable without this site — your existing instances are unaffected.</p>
  <p><a class="fd-btn" href="/">Back to the site</a></p>
</section>
</main>
</body>
</html>`;
}

export function simpleMessagePage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — KriyaDot</title>
<link rel="stylesheet" href="/frontdoor-assets/app.css">
</head>
<body>
<main class="fd-main">
<section class="fd-card">
  <h1>${title}</h1>
  <p>${message}</p>
  <p><a class="fd-btn" href="/">Back to the site</a></p>
</section>
</main>
</body>
</html>`;
}
