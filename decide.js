/* IPO decision engine (retail, listing-gain objective). Pure functions; used by index.html and test_decide.js.
 *
 * Adapts the "analyzing IPO valuation and pricing" method (comps, precedent IPOs, IPO discount, demand,
 * bear/base/bull stress test) to a retail applicant who sells on listing day:
 *   signal        GMP % and its direction                                   weight 30
 *   history       how similar IPOs (segment + GMP) actually listed          weight 20
 *   demand        QIB / NII / retail subscription (institutions first)      weight 20
 *   valuation     post-issue P/E vs recent same-sector IPOs (IPO discount)  weight 15
 *   fundamentals  growth, margin, ROE, leverage                              weight 10
 *   structure     fresh vs OFS, issue size                                   weight  5
 * Missing factors are dropped and the remaining weights renormalised; confidence reflects what is missing.
 * Verdicts: APPLY, LOTTERY (worth applying but odds are tiny), CONSIDER, SKIP, WAIT (no GMP), CLOSED.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./backtest.js"));
  else root.Decide = factory(root.Backtest);
})(typeof self !== "undefined" ? self : this, function (B) {
  "use strict";
  const W = { signal: 30, history: 20, demand: 20, valuation: 15, fundamentals: 10, structure: 5 };
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const lg = (x, top) => clamp(Math.log10(Math.max(0, x) + 1) / Math.log10(top + 1));
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
  const pc = (n) => (n > 0 ? "+" : "") + Math.round(n) + "%";

  function fyCols(fin) { // indices of full financial years, newest first (year-end taken from the oldest period: Mar, Dec, ...)
    const ps = (fin && fin.periods) || [];
    if (!ps.length) return [];
    const end = ps[ps.length - 1].replace(/\s*\d{4}$/, "");
    return ps.map((p, i) => [p, i]).filter(([p]) => p.replace(/\s*\d{4}$/, "") === end).map(([, i]) => i);
  }

  function netPerLot(p, pct, cfg) {
    const c = Object.assign({}, cfg), mult = p.segment === "SME" ? 2 : 1;
    if (p.lot) c.ticket = Object.assign({}, c.ticket, { [p.segment]: p.lot * mult * p.price });
    const r = B.ledger([{ id: "x", segment: p.segment, price: p.price, listing_price: p.price * (1 + pct / 100),
      listing_gain_pct: pct, sub_final: 1, close: "2026-01-05" }], Object.assign(c, { useSub: true, applyTax: false }))[0];
    return r ? { net: r.netAllot, invested: r.invested } : null;
  }

  function decide(p, ins, rows, cfg, today) {
    ins = ins || {};
    const out = { factors: {}, reasons: [], verdict: "WAIT", score: null, confidence: 0 };
    const g = p.gmp != null && p.price ? p.gmp / p.price * 100 : null;
    const add = (t, kind, w) => out.reasons.push({ t, kind, w: w || 1 });
    const F = (k, s, note) => { out.factors[k] = { s: clamp(s), note }; };

    // signal
    if (g != null) {
      let s = clamp(g / 30) - (p.trend < 0 ? 0.1 : 0);
      F("signal", s, `GMP ${pc(g)}${p.trend < 0 ? ", falling" : p.trend > 0 ? ", rising" : ""}`);
      if (g <= 0) add("No grey-market premium", "-", 3);
      else if (g >= 25) add(`GMP ${pc(g)} implies a strong listing`, "+", 3);
      else if (g < 8) add(`GMP only ${pc(g)}: thin cushion after costs`, "-", 2);
      if (p.trend < 0) add("GMP has been falling", "-", 2);
    }
    // history
    const hist = g != null && rows && rows.length ? B.similar(rows, p.segment, g, 8) : null;
    if (hist && hist.n >= 3) {
      const s = 0.5 * hist.posRate + 0.5 * clamp((hist.avg + 10) / 40);
      F("history", hist.thin ? 0.5 + (s - 0.5) * 0.5 : s, `${hist.n} similar listed: ${Math.round(hist.posRate * 100)}% up, avg ${pc(hist.avg)}`);
      if (hist.posRate >= 0.75 && !hist.thin) add(`${Math.round(hist.posRate * 100)}% of ${hist.n} similar IPOs listed higher (avg ${pc(hist.avg)})`, "+", 2);
      if (hist.posRate < 0.5) add(`Only ${Math.round(hist.posRate * 100)}% of ${hist.n} similar IPOs listed higher`, "-", 3);
    }
    // demand (institutions first; early-day numbers are partial)
    const sub = ins.sub || {}, live = p.subscription_x;
    const q = sub.qib, n = sub.nii, r = sub.retail, tot = sub.total != null ? sub.total : live;
    const early = p.st === "open" && p.close !== today;
    if (tot != null || q != null) {
      let s;
      if (q != null && p.segment !== "SME") s = 0.6 * lg(q, 50) + 0.4 * lg(n || 0, 50);
      else s = 0.5 * lg(tot || 0, 100) + 0.5 * lg(n || tot || 0, 100);
      if (early) s = 0.5 + (s - 0.5) * 0.5;
      // anchor-book quality: long-only domestic money (mutual funds, insurers) certifies the issue
      const ab = ins.anchor_book;
      if (ab && ab.n) {
        const longOnly = (ab.mf_pct || 0) + (ab.insurance_pct || 0);
        if (longOnly >= 60) { s += 0.08; add(`Anchor book led by long-only funds (${Math.round(longOnly)}% mutual funds and insurers)`, "+", 1); }
        else if (longOnly < 20) { s -= 0.05; add(`Anchor book light on mutual funds (${Math.round(longOnly)}%)`, "-", 1); }
      }
      const rv = ins.reviews;
      if (rv && rv.subscribe + rv.may_apply + rv.avoid > 0) {
        if (rv.avoid > rv.subscribe + rv.may_apply) { s -= 0.05; add(`Most broker notes say avoid (${rv.avoid} of ${rv.subscribe + rv.may_apply + rv.neutral + rv.avoid})`, "-", 2); }
        else if (rv.subscribe >= 3 && !rv.avoid) add(`Brokers broadly positive (${rv.subscribe} subscribe, none avoid)`, "+", 1);
      }
      F("demand", s, q != null ? `QIB ${q}x · NII ${n}x · retail ${r}x${early ? " (so far)" : ""}` : `Total ${tot}x${early ? " (so far)" : ""}`);
      if (q != null && q >= 20 && !early) add(`Institutions bid ${q}x their quota`, "+", 2);
      if (q != null && q < 1 && !early) add(`QIB portion under-subscribed (${q}x)`, "-", 3);
      if (!early && tot != null && tot < 1.5) add(`Weak overall demand (${tot}x)`, "-", 2);
    }
    // valuation vs precedent IPOs (casemark: price at a discount to comps)
    const pos = (ins.precedents || []).filter((x) => x.pe > 0 && x.pe < 300);
    const same = pos.filter((x) => x.segment === p.segment);
    const peerPe = (same.length >= 2 ? same : pos).map((x) => x.pe);
    const pe = ins.pe_post > 0 ? ins.pe_post : ins.pe_pre > 0 ? ins.pe_pre : null;
    if (ins.loss_making || pe != null) {
      let s, note;
      if (ins.loss_making || pe == null) { s = 0.15; note = "Loss-making on post-issue EPS"; add("Loss-making (negative EPS)", "-", 2); }
      else if (peerPe.length >= 2) {
        const m = median(peerPe), ratio = pe / m;
        s = ratio <= 0.85 ? 1 : ratio <= 1.15 ? 0.65 : ratio <= 1.5 ? 0.35 : 0.1;
        note = `P/E ${pe}x vs ${m.toFixed(0)}x median of ${peerPe.length} recent sector IPOs`;
        if (ratio <= 0.85) add(`Priced at a discount to recent sector IPOs (P/E ${pe}x vs ${m.toFixed(0)}x)`, "+", 2);
        if (ratio > 1.5) add(`Priced rich: P/E ${pe}x vs ${m.toFixed(0)}x for recent sector IPOs`, "-", 2);
      } else {
        s = pe < 20 ? 0.8 : pe < 40 ? 0.6 : pe < 70 ? 0.35 : 0.15; note = `P/E ${pe}x (no usable precedents)`;
        if (pe >= 70) add(`High P/E ${pe}x`, "-", 1);
      }
      F("valuation", s, note);
    }
    // fundamentals
    const fin = ins.financials, cols = fyCols(fin);
    if (fin && cols.length >= 2 && fin["Total Income"]) {
      const inc = fin["Total Income"], pat = fin["Profit After Tax"] || [], nw = fin["NET Worth"] || [], debt = fin["Total Borrowing"] || [];
      const [a, b] = cols, growth = inc[b] ? (inc[a] / inc[b] - 1) * 100 : null, margin = inc[a] ? pat[a] / inc[a] * 100 : null;
      const roe = ins.kpi_fy && ins.kpi_fy.ROE != null ? ins.kpi_fy.ROE : nw[a] ? pat[a] / nw[a] * 100 : null;
      const de = nw[a] && debt[a] != null ? debt[a] / nw[a] : null;
      const parts = [growth == null ? null : growth >= 20 ? 1 : growth >= 0 ? 0.6 : 0.2, margin == null ? null : margin >= 10 ? 1 : margin >= 0 ? 0.5 : 0,
        roe == null ? null : roe >= 15 ? 1 : roe >= 8 ? 0.6 : 0.3, de == null ? null : de < 0.5 ? 1 : de < 1.5 ? 0.6 : 0.2].filter((x) => x != null);
      F("fundamentals", parts.reduce((s, x) => s + x, 0) / parts.length,
        `Revenue ${growth == null ? "—" : pc(growth)} YoY · PAT margin ${margin == null ? "—" : margin.toFixed(0) + "%"} · ROE ${roe == null ? "—" : roe.toFixed(0) + "%"} · D/E ${de == null ? "—" : de.toFixed(1)}`);
      if (growth != null && growth < 0) add(`Revenue fell ${Math.abs(Math.round(growth))}% last year`, "-", 2);
      if (growth != null && growth >= 30 && margin > 5) add(`Revenue up ${Math.round(growth)}% with ${margin.toFixed(0)}% PAT margin`, "+", 1);
      if (pat[0] < 0 && cols[0] !== 0) add("Loss in the latest interim period", "-", 2);
    }
    // structure
    const size = ins.issue_size_cr || p.issue_size_cr;
    if (size) {
      const fresh = ins.fresh_cr != null ? ins.fresh_cr / size : p.ofs_cr != null && p.issue_size_cr ? 1 - p.ofs_cr / p.issue_size_cr : null;
      let s = fresh == null ? 0.5 : fresh >= 0.5 ? 1 : fresh >= 0.25 ? 0.6 : 0.3;
      if (p.segment === "SME" && size < 25) s -= 0.2;
      F("structure", s, `${fresh == null ? "—" : Math.round(fresh * 100) + "% fresh issue"} · ₹${Math.round(size)} Cr`);
      if (fresh != null && fresh < 0.1) add("Pure offer-for-sale: no new money to the company", "-", 1);
    }

    // score + confidence
    let wsum = 0, ssum = 0;
    for (const [k, w] of Object.entries(W)) if (out.factors[k]) { wsum += w; ssum += w * out.factors[k].s; }
    out.score = wsum ? Math.round(ssum / wsum * 100) : null;
    out.confidence = wsum / 100 * (hist && hist.thin ? 0.85 : 1) * (early ? 0.9 : 1);

    // allotment odds: retail subscription > total > history (upcoming)
    let odds = null, basis = "assumed";
    if (r != null) { odds = Math.min(1, 1 / Math.max(r, 1e-9)); basis = early ? "retail so far" : "retail"; }
    else if (tot != null) { odds = Math.min(1, 1 / Math.max(tot, 1e-9)); basis = early ? "total so far" : "total"; }
    else if (g != null && rows) {
      const simSubs = rows.filter((x) => x.segment === p.segment && x.subClose > 0 && x.gmpList != null && Math.abs(x.gmpList / x.price * 100 - g) <= 10).map((x) => x.subClose);
      if (simSubs.length >= 5) { odds = Math.min(1, 1 / median(simSubs)); basis = "similar IPOs"; }
    }
    if (odds == null) odds = cfg.allot[p.segment];
    out.odds = { p: odds, oneIn: odds > 0 ? Math.round(1 / odds) : null, basis };

    // bear / base / bull (stress test) per lot
    if (g != null && p.price) {
      const haveH = hist && hist.n >= 5;
      const base = haveH ? 0.5 * g + 0.5 * hist.avg : g * 0.85;
      const bear = haveH ? Math.min(hist.p10, base) : Math.min(-10, base);
      const bull = haveH ? Math.max(g, hist.p90) : g * 1.2;
      const sc = (pct) => Object.assign({ pct }, netPerLot(p, pct, cfg));
      out.scenarios = { bear: sc(bear), base: sc(base), bull: sc(bull) };
      out.ev = out.scenarios.base.net * odds;
      out.invested = out.scenarios.base.invested;
    }

    // verdict
    const base = out.scenarios ? out.scenarios.base.pct : null;
    if (p.st === "closed") out.verdict = "CLOSED";
    else if (g == null) out.verdict = "WAIT";
    else if (g <= 0 || base <= 3 || (hist && !hist.thin && hist.posRate < 0.45)) out.verdict = "SKIP";
    else if (out.score >= 62 && base >= 8) out.verdict = odds < 0.1 ? "LOTTERY" : "APPLY";
    else if (out.score >= 45) out.verdict = "CONSIDER";
    else out.verdict = "SKIP";
    if (out.verdict === "APPLY" && p.segment === "SME" && out.scenarios.bear.pct < -10 && out.score < 70) out.verdict = "CONSIDER";
    out.reasons.sort((a, b) => b.w - a.w);
    return out;
  }

  /* ---------- Research view: the long-term question ----------
   * Synthesised from how established evaluators work:
   *  - CRISIL IPO grading (1-5): business and financial prospects, management, governance; relative to listed
   *    equities and explicitly not a price opinion  -> fundamental grade
   *  - Renaissance Capital: fundamentals, governance, valuation vs listed peers, insider cash-outs
   *  - Indian brokerage IPO notes: valuation vs peers is the main "avoid" trigger; growth and ROCE justify a
   *    premium; use of proceeds and promoter exit are scrutinised  -> valuation verdict + long-term call
   * Each pillar is 0-1; the grade is their weighted average mapped to 1-5. */
  const PILLARS = { growth: 30, profitability: 30, balance: 15, governance: 25 };
  function monthsBetween(a, b) { // "30 Jun 2026" -> months after "31 Mar 2026"
    const d = (s) => new Date(Date.parse(s + " UTC")); const x = d(a), y = d(b);
    return isNaN(x) || isNaN(y) ? null : (x.getUTCFullYear() - y.getUTCFullYear()) * 12 + x.getUTCMonth() - y.getUTCMonth();
  }
  // CRISIL-style grades are relative: cut the composite score into quintiles of the IPOs analysed
  function gradeCuts(insList) { // per segment, like comparing with peers of the same kind
    const out = {};
    for (const seg of ["SME", "Mainboard"]) {
      const sc = insList.filter((v) => v.segment === seg).map((v) => research({ segment: seg }, v).score).filter((x) => x != null).sort((a, b) => a - b);
      if (sc.length >= 12) { const q = (f) => sc[Math.floor(f * (sc.length - 1))]; out[seg] = [q(0.2), q(0.4), q(0.6), q(0.8)]; }
    }
    return out;
  }
  function research(p, ins, cuts) {
    ins = ins || {};
    const out = { pillars: {}, notes: [], grade: null };
    const P = (k, s, note) => { out.pillars[k] = { s: clamp(s), note }; };
    const note = (t, kind) => out.notes.push({ t, kind });
    const fin = ins.financials, cols = fyCols(fin), kf = ins.kpi_fy || {}, k = ins.kpi || {};
    let revCagr = null, patCagr = null;
    if (fin && cols.length >= 2 && fin["Total Income"]) {
      const inc = fin["Total Income"], pat = fin["Profit After Tax"] || [], a = cols[0], z = cols[cols.length - 1], yrs = cols.length - 1;
      if (inc[a] > 0 && inc[z] > 0) revCagr = (Math.pow(inc[a] / inc[z], 1 / yrs) - 1) * 100;
      if (pat[a] > 0 && pat[z] > 0) patCagr = (Math.pow(pat[a] / pat[z], 1 / yrs) - 1) * 100;
      let s = revCagr == null ? 0.3 : revCagr >= 25 ? 1 : revCagr >= 15 ? 0.8 : revCagr >= 8 ? 0.6 : revCagr >= 0 ? 0.35 : 0.1;
      if (patCagr != null) s += patCagr >= revCagr ? 0.05 : patCagr < 0 ? -0.1 : 0;
      // a profit surge into the IPO is a classic research red flag (window dressing), not a strength
      if (patCagr != null && patCagr > 100) { s = Math.min(s, 0.6); note(`Profit up ${Math.round(patCagr)}% a year into the IPO; check it is sustainable`, "-"); }
      else if (revCagr != null && revCagr > 100) { s = Math.min(s, 0.6); note(`Revenue up ${Math.round(revCagr)}% a year into the IPO; check it is sustainable`, "-"); }
      else if (pat[a] <= 0) s -= 0.15;
      // momentum: annualised latest interim period vs last full year
      if (cols[0] !== 0 && inc[0] != null && inc[a]) {
        const m = monthsBetween(fin.periods[0], fin.periods[a]);
        if (m && m > 0 && m < 12) {
          const run = inc[0] * 12 / m;
          if (run < inc[a] * 0.85) { s -= 0.15; note(`Latest ${m}-month revenue runs ${Math.round((1 - run / inc[a]) * 100)}% below last year's pace`, "-"); }
          else if (run > inc[a] * 1.15) note(`Latest ${m}-month revenue runs ${Math.round((run / inc[a] - 1) * 100)}% ahead of last year's pace`, "+");
        }
      }
      P("growth", s, `Revenue ${revCagr == null ? "—" : pc(revCagr)} a year over ${yrs} yr${yrs > 1 ? "s" : ""}, profit ${patCagr == null ? "n/m" : pc(patCagr)}`);
      if (revCagr != null && revCagr >= 25 && revCagr <= 100) note(`Revenue compounding ${Math.round(revCagr)}% a year`, "+");
      if (revCagr != null && revCagr < 0) note(`Revenue shrinking ${Math.round(-revCagr)}% a year`, "-");
    }
    const roe = kf.ROE != null ? kf.ROE : k.ROE, roce = kf.ROCE != null ? kf.ROCE : k.ROCE;
    const ebm = kf["EBITDA Margin"] != null ? kf["EBITDA Margin"] : k["EBITDA Margin"], patm = kf["PAT Margin"] != null ? kf["PAT Margin"] : k["PAT Margin"];
    if (roe != null || roce != null || patm != null) {
      const parts = [roce == null ? null : roce >= 20 ? 1 : roce >= 12 ? 0.65 : roce >= 0 ? 0.3 : 0,
        roe == null ? null : roe >= 18 ? 1 : roe >= 10 ? 0.6 : roe >= 0 ? 0.3 : 0,
        patm == null ? null : patm >= 12 ? 1 : patm >= 5 ? 0.6 : patm >= 0 ? 0.3 : 0].filter((x) => x != null);
      P("profitability", parts.reduce((a, b) => a + b, 0) / parts.length, `ROCE ${roce == null ? "—" : Math.round(roce) + "%"} · ROE ${roe == null ? "—" : Math.round(roe) + "%"} · EBITDA margin ${ebm == null ? "—" : Math.round(ebm) + "%"} · PAT margin ${patm == null ? "—" : Math.round(patm) + "%"}`);
      if (roce != null && roce >= 25) note(`High return on capital (ROCE ${Math.round(roce)}%)`, "+");
      if (roce != null && roce < 10) note(`Thin return on capital (ROCE ${Math.round(roce)}%)`, "-");
    }
    if (fin && cols.length) {
      const a = cols[0], nw = (fin["NET Worth"] || [])[a], debt = (fin["Total Borrowing"] || [])[a];
      if (nw > 0 && debt != null) {
        const de = debt / nw;
        P("balance", de < 0.3 ? 1 : de < 1 ? 0.7 : de < 2 ? 0.4 : 0.15, `Debt to equity ${de.toFixed(2)}`);
        if (de >= 1.5) note(`Leveraged balance sheet (debt ${de.toFixed(1)}x equity)`, "-");
      }
    }
    // governance & issue structure (CRISIL's emphasis; Renaissance's insider cash-out test)
    const size = ins.issue_size_cr || p.issue_size_cr, uses = ins.uses || [];
    if (size || ins.promoter_post != null || uses.length) {
      const parts = [];
      const fresh = size && ins.fresh_cr != null ? ins.fresh_cr / size : null;
      if (fresh != null) parts.push(fresh >= 0.6 ? 1 : fresh >= 0.3 ? 0.75 : fresh > 0.05 ? 0.55 : 0.4);
      if (ins.promoter_post != null) parts.push(ins.promoter_post >= 50 ? 1 : ins.promoter_post >= 35 ? 0.65 : 0.35);
      if (uses.length && !uses.includes("ofs_only")) parts.push(uses.includes("capex") || uses.includes("debt") ? 0.9 : uses.includes("working_capital") ? 0.7 : 0.5);
      P("governance", parts.reduce((a, b) => a + b, 0) / Math.max(1, parts.length),
        `${fresh == null ? "" : Math.round(fresh * 100) + "% fresh issue · "}${ins.promoter_post != null ? "promoters keep " + ins.promoter_post + "% · " : ""}${uses.length ? "proceeds: " + uses.map((u) => ({ debt: "debt repayment", capex: "capex", working_capital: "working capital", acquisition: "acquisitions", general: "general purposes", ofs_only: "selling shareholders only" }[u])).join(", ") : ""}`.replace(/ · $/, ""));
      if (fresh != null && fresh <= 0.05) note("Entire issue is existing shareholders selling", "-");
      if (ins.promoter_post != null && ins.promoter_post < 35) note(`Promoters keep only ${ins.promoter_post}% after the issue`, "-");
      if (uses.includes("debt")) note("Proceeds pay down debt", "+");
      if (uses.includes("capex")) note("Proceeds fund capacity expansion", "+");
    }
    let wsum = 0, ssum = 0;
    for (const [key, w] of Object.entries(PILLARS)) if (out.pillars[key]) { wsum += w; ssum += w * out.pillars[key].s; }
    if (Object.keys(out.pillars).length >= 2) {
      const sc = ssum / wsum;
      out.score = Math.round(sc * 100);
      const cut = cuts && cuts[p.segment === "SME" ? "SME" : "Mainboard"];
      out.grade = cut ? 1 + cut.filter((c) => out.score > c).length : sc >= 0.86 ? 5 : sc >= 0.72 ? 4 : sc >= 0.56 ? 3 : sc >= 0.4 ? 2 : 1;
      out.relative = !!cut;
    }
    // valuation verdict (broker notes: premium to peers is the main avoid trigger; growth and ROCE can justify it)
    const pe = ins.pe_post > 0 ? ins.pe_post : ins.pe_pre > 0 ? ins.pe_pre : null;
    const posPe = (ins.precedents || []).filter((x) => x.pe > 0 && x.pe < 300), same = posPe.filter((x) => x.segment === p.segment);
    const peers = (same.length >= 2 ? same : posPe).map((x) => x.pe), peerMed = peers.length >= 2 ? median(peers) : null;
    const ebitda = fin && cols.length ? (fin.EBITDA || [])[cols[0]] : null, debt0 = fin && cols.length ? (fin["Total Borrowing"] || [])[cols[0]] : 0;
    const v = { pe, peerMed, peers: peers.length, premium: pe && peerMed ? (pe / peerMed - 1) * 100 : null,
      evEbitda: ins.mcap_cr && ebitda > 0 ? (ins.mcap_cr + (debt0 || 0)) / ebitda : null, peg: pe && patCagr > 0 && patCagr <= 100 ? pe / patCagr : null, pb: kf["P/B (x)"] != null ? kf["P/B (x)"] : k["P/B (x)"] };
    if (ins.loss_making) v.label = "Loss-making";
    else if (v.premium != null) v.label = v.premium <= -15 ? "Discount to peers" : v.premium <= 15 ? "In line with peers" : v.premium <= 50 ? "Premium to peers" : "Stretched";
    else if (v.peg != null) v.label = v.peg < 1 ? "Reasonable for its growth" : v.peg <= 2 ? "Fully priced" : "Stretched";
    else if (pe) v.label = pe < 20 ? "Undemanding" : pe < 40 ? "Fully priced" : "Stretched";
    v.justified = (v.label === "Premium to peers" || v.label === "Stretched") && v.peg != null && v.peg < 1.2 && roce >= 20;
    if (v.justified) v.label += ", growth-justified";
    out.valuation = v;
    // long-term call
    const rich = v.label && (v.label.startsWith("Stretched") || v.label === "Loss-making") && !v.justified;
    if (out.grade == null) out.longTerm = { call: "No view", why: "Not enough disclosed financials" };
    else if (out.grade >= 4 && !rich) out.longTerm = { call: "Positive", why: `Grade ${out.grade}/5 fundamentals; valuation ${(v.label || "unclear").toLowerCase()}` };
    else if (out.grade <= 2 || (rich && out.grade <= 3)) out.longTerm = { call: "Cautious", why: out.grade <= 2 ? `Weak fundamentals (grade ${out.grade}/5)` : `${v.label} valuation for grade ${out.grade}/5 fundamentals` };
    else out.longTerm = { call: "Neutral", why: rich ? `Good business, but ${v.label.toLowerCase()} valuation` : `Average fundamentals (grade ${out.grade}/5)` };
    // sponsorship
    const ab = ins.anchor_book, rv = ins.reviews;
    out.sponsorship = { anchors: ab ? ab.n : 0, longOnly: ab ? (ab.mf_pct || 0) + (ab.insurance_pct || 0) : null, foreign: ab ? ab.foreign_pct : null, houses: ab ? ab.houses : [],
      consensus: rv && rv.subscribe + rv.may_apply + rv.neutral + rv.avoid ? rv : null };
    return out;
  }
  const GRADE = { 5: "Strong", 4: "Above average", 3: "Average", 2: "Below average", 1: "Weak" };

  const LABEL = { APPLY: "Apply", LOTTERY: "Apply · lottery odds", CONSIDER: "Consider", SKIP: "Skip", WAIT: "Wait for GMP", CLOSED: "Bidding closed" };
  return { decide, W, LABEL, netPerLot, fyCols, research, gradeCuts, PILLARS, GRADE };
});
