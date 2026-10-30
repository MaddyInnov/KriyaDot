// SPDX-License-Identifier: Apache-2.0
// DA-3 — Privacy stance, in product copy (decision row closed as
// equivalent-by-architecture): KriyaDot is local-first and never trains
// on user data. This page states that where users can read it, and
// points at the two mechanisms that back it up: the one-shot data
// export (DA-1) and the confirm-gated full reset (DA-2).

export default function PrivacyPage() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px 64px' }}>
      <h1>Privacy: decided by architecture, not just by policy</h1>
      <p>
        KriyaDot is <strong>local-first</strong>. Your chats, files, recordings, memory and
        settings live in your own instance — on this machine, or in your own cloud. This
        instance is yours: the hosted KriyaDot website is only a front door that stores your
        account identity and your instance addresses so it can launch you back here. It never
        stores, relays, or inspects your content.
      </p>

      <h2>We do not train on your data</h2>
      <p>
        Your conversations, files and recordings are <strong>never used to train models</strong> —
        not by KriyaDot, and not pooled for anyone else. There is no central store of user
        content to train from, and we do not build one. When a model provider is involved,
        your instance sends requests directly to that provider under your own keys and their
        terms; nothing routes through a KriyaDot training pipeline, because none exists.
      </p>

      <h2>What stays where</h2>
      <ul>
        <li>
          <strong>Your instance (this app):</strong> transcripts, workspace files, recordings,
          memory, settings, and your credential vault. Secrets in the vault never leave the
          device — they are excluded even from backups and exports.
        </li>
        <li>
          <strong>The front-door website:</strong> account identity basics and instance
          addresses only — an address book, nothing more.
        </li>
        <li>
          <strong>Analytics:</strong> opt-in, off by default. When off, nothing is collected.
        </li>
      </ul>

      <h2>Your controls</h2>
      <ul>
        <li>
          <strong>Download my data:</strong> one archive with your transcripts, files,
          recordings, memory and a settings manifest, delivered through an expiring link
          (<em>Settings → Download my data</em>, API: <code>POST /api/data-export</code>).
        </li>
        <li>
          <strong>Full reset:</strong> a single confirm-gated action that wipes chats, files
          and active tasks, leaving only an audit tombstone that a reset happened
          (API: <code>POST /api/full-reset</code>).
        </li>
      </ul>

      <p className="muted small">
        This page is the product commitment for the local-first build: if the architecture ever
        changes so that user content leaves your instance, this copy changes first — before the
        code ships.
      </p>
    </div>
  );
}
