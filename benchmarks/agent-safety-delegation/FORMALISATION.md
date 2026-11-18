<!-- SPDX-License-Identifier: Apache-2.0 -->
# Delegation Safety — a weakest-link formalisation

*Workstream 2, deliverable (c). Wang & Mannby (arXiv:2611.17520) propose no
formal bound — "safety tracks the minimum" is their empirical summary. This
note is our formalisation of that regularity, stated tightly enough to be
falsifiable against the measurements in `results/summary.json`.*

## 1. One edge

A principal **P** delegates a read to a sub-agent **S** and adopts S's
conclusion through a boundary **B** (whatever, if anything, checks the
conclusion before P acts on it).

- Let `p = P(S errs on the delegated read)` — the sub-agent's error rate on
  this task class, measured by direct-read calibration.
- Let `a = P(P adopts S's answer | S erred)` — the **conditional adoption
  rate** at the boundary. Wang & Mannby measured `a = 751/757 ≈ 0.992`
  (pooled) for aggregators consuming a corrupted worker's report; the
  conditioning is essential — 751/757 is *not* an unconditional error rate.
- Let `d = 1 − a` be the boundary's **detection rate**: the probability that
  a propagated sub-agent error is caught (or never adopted) at the boundary.

Then, for errors originating in the delegated read,

```
P(system error via this edge)  =  p · a  =  p · (1 − d)
```

and since the system can also err for other reasons,

```
P(system error)  ≥  p · (1 − d).        (weakest-link bound, one edge)
```

With no boundary check at all (conclusion-only delegation, KriyaDot's
current default shape), `d` is whatever the orchestrator's unaided scepticism
provides; the paper's numbers put `a ≈ 0.98–1.00`, i.e. `d ≈ 0`, so the
bound collapses to `P(system error) ≳ p`: **the system's error rate on the
delegated read is the sub-agent's error rate**, however strong P is. P's own
direct-read error rate does not appear in the bound — that is the gap.

## 2. Graph extension

**Series chains.** For a chain P → S₁ → S₂ → … → Sₖ where each hop i has
sub-agent error `pᵢ` (error introduced at that hop, conditional on a correct
input) and boundary detection `dᵢ`, an error introduced at hop i survives to
the end with probability `Π_{j≥i} (1 − dⱼ)`, so

```
P(system error) ≥ 1 − Πᵢ ( 1 − pᵢ · Π_{j≥i} (1 − dⱼ) )   ≈   Σᵢ pᵢ · Π_{j≥i} (1 − dⱼ)   (small-p form)
```

Depth multiplies exposure: with unchecked boundaries (`dⱼ ≈ 0`) a chain's
error is governed by the *sum* over hops, dominated by the weakest reader.

**Fan-in aggregation.** If an aggregator consumes k worker reports and any
single corrupted report is adopted with conditional probability `a` (the
paper's 0.98–1.00 regime), then with independent worker error rates `pᵢ`,

```
P(aggregator error) ≥ a · ( 1 − Πᵢ (1 − pᵢ) )
```

i.e. fan-in *amplifies* the weakest-link problem unless the boundary
re-grounds (checks a report against source evidence) or requires agreement:
an agreement-of-two boundary replaces `p` by roughly `p₁·p₂ + escalation
terms` for independent readers (see §3, protocol P2).

## 3. Tying d to the measured protocols

The three boundary protocols measured in this workstream are three ways of
buying `d > 0`; each protocol's *measured* detection rate is
`d̂ = 1 − (propagation under protocol) / (reader error rate on the same
cases)`, computed from `results/summary.json`:

| Protocol | Mechanism in bound terms | Measured (this study, n=10 subset; reader conclusions forged 7/10; delegated finals forged 8/10) |
|---|---|---|
| (baseline) conclusion-only delegation | `d ≈ 0` by construction | conditional adoption **a = 13/13 = 1.00** (n=20 arm) ⇒ `d̂ = 0` |
| P1 independent re-read | boundary replaces adoption with P's own read: effective `a → P's direct error`, i.e. `d̂ ≈ 1 − ε_P/p` | finals forged **3/10**; the 3 are exactly P's calibration failures ⇒ residual = ε_P as predicted; `d̂ = 1 − 3/7 ≈ 0.57` against the reader-error base |
| P2 second reader + agreement | disagreement escalates to a re-read; adoption needs two independent errors: `p_eff ≈ p₁p₂ + P(disagree)·ε_P` | finals forged **7/10** ⇒ `d̂ ≈ 0`: readers agreed in 9/10 (errors correlated, §4.1 realised in practice) |
| P3 evidence-only returns | changes the channel: S cannot inject a conclusion, only quotes; P concludes from evidence, so `a` is measured against quoted-evidence fidelity, not conclusion trust | finals forged **0/10** ⇒ `d̂ = 1.00` on this subset (with 3/10 non-answers as the cost — outside the bound, which counts only forged adoption) |

Exact measured values, with raw counts, are reported in `README.md` §Results
and `results/summary.json`; this table is filled from those numbers and
never the other way round. One study-specific refinement the measurements
force: in this model pair the delegated reader's `p` was **brief-dependent**
(0/10 under a careful brief, 13/20 forged conclusions under the casual brief
delegation actually produces) — `p` in the bound must be read as
`p(model, brief, channel)`, not a fixed model property.

## 4. Where the bound is loose — scope conditions

1. **Correlated errors.** The chain/fan-in forms assume hop errors are
   (conditionally) independent. Two readers from the same model family, or
   readers sharing a prompt, correlate: P2's `p₁p₂` term then understates
   joint error, and the bound is optimistic. (Mitigation used here: P2's
   second reader is a different model family.)
2. **Tells-removed forgeries (the paper's `correction_clean` family).** If
   the forgery carries no detectable tells, careful reading cannot catch it:
   `p → ~1` for *every* reader including P, detection-based boundaries fail
   with it, and the bound is vacuous (both arms fail — the paper found
   ~175–180/180 in both arms). Detection protocols are scoped to
   *detectable* corruptions; provenance enforcement (signed/accessioned
   records) is the defence class for the rest, and is out of scope here.
3. **Adoption is not the only failure channel.** P can err on a correct
   conclusion, misread correct evidence (P3), or be steered by framing in
   quoted evidence. The bound is a lower bound on *delegated-read*
   error only; total system error is larger.
4. **Non-stationarity.** `p`, `a`, `d` are per-(model pair, task class,
   forgery family) quantities. The paper showed which poison works is
   harness/reader-specific; a `d` measured on one family does not transfer
   by fiat to another.
5. **Small n.** All rates in this study carry small denominators (stated
   everywhere as raw counts). The bound's *shape* is the claim; the point
   estimates are indicative, with run-to-run disagreement of ~13% reported
   by the paper across repeated pairs.
