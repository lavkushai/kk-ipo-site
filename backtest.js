/* IPO GMP backtest engine: pure functions, shared by backtest.html and test_backtest.js.
 *
 *   ledger(records, cfg)          -> one row per listed IPO with ticket, costs, timing, allotment probability
 *   run(rows, strategy, cfg)      -> expected-value metrics + series (+ Monte Carlo lottery draws)
 *   calibration(rows, which)      -> how well GMP predicted the listing gain
 *
 * Point-in-time rule: a GMP filter only uses the GMP on the closing day (the last day you can bid).
 * Pages that are paywalled to the last 3 readings have no close-day GMP, so they are excluded from
 * GMP filters unless cfg.allowPost is set (T+1 GMP: not tradable, labelled as such).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Backtest = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = {
    ticket: { Mainboard: 15000, SME: 120000 }, // Rs per application; shares = floor(ticket / price)
    accounts: 1,                               // independent applications (e.g. family PANs)
    allot: { Mainboard: 0.25, SME: 0.08 },     // P(allotment) when subscription is unknown (hot IPOs are lower: see notes)
    useSub: true,                              // else P = min(1, 1 / final subscription)
    allowPost: false,                          // let GMP filters fall back to the T+1 GMP
    slippagePct: { Mainboard: 0.5, SME: 2 },   // exit below the listing price (SME: circuits, thin books); scalar also OK
    brokerage: 20, dpCharge: 15.93,            // flat Rs per sale
    sttPct: 0.1, exchPct: 0.00325, sebiPct: 0.0001, gstPct: 18, stampBuyPct: 0,
    applyTax: true, taxPct: 20.8,              // STCG 20% + 4% cess, netted per financial year
    benchmarkPct: 6.5,                         // liquid-fund comparator
    mcRuns: 3000, seed: 42,
  };

  const PRESETS = [
    { name: "Apply to all" },
    { name: "Mainboard only", segment: "Mainboard" },
    { name: "SME only", segment: "SME" },
    { name: "GMP >= 10%", minGmpPct: 10 },
    { name: "GMP >= 20%", minGmpPct: 20 },
    { name: "GMP >= 20% & sub >= 10x", minGmpPct: 20, minSub: 10 },
    { name: "GMP > 0 & issue >= Rs 500 Cr", minGmpPct: 0.01, minSize: 500 },
  ];

  const DAY = 864e5;
  const dn = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY;
  const iso = (n) => new Date(n * DAY).toISOString().slice(0, 10);
  function addWd(s, n) {
    let d = dn(s);
    while (n > 0) { d++; const w = new Date(d * DAY).getUTCDay(); if (w !== 0 && w !== 6) n--; }
    return iso(d);
  }
  const fyOf = (s) => {
    const y = +s.slice(0, 4), a = +s.slice(5, 7) >= 4 ? y : y - 1;
    return "FY" + String(a).slice(2) + "-" + String(a + 1).slice(2);
  };
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const q = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;

  function ledger(records, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    const rows = [];
    for (const r of records) {
      if (r.listing_price == null || !r.price || !(r.close || r.listing)) continue;
      const seg = r.segment === "SME" ? "SME" : "Mainboard";
      const bid = r.close || addWd(r.listing, -3);
      const listing = r.listing || addWd(bid, 3);
      const shares = Math.max(1, Math.floor(cfg.ticket[seg] / r.price));
      const invested = shares * r.price;
      const slip = typeof cfg.slippagePct === "object" ? cfg.slippagePct[seg] : cfg.slippagePct;
      const sell = shares * r.listing_price * (1 - slip / 100);
      const exch = sell * cfg.exchPct / 100, sebi = sell * cfg.sebiPct / 100;
      const charges = cfg.brokerage + exch + sebi + (cfg.brokerage + exch + sebi) * cfg.gstPct / 100
        + sell * cfg.sttPct / 100 + invested * cfg.stampBuyPct / 100 + cfg.dpCharge;
      const known = cfg.useSub && r.sub_final > 0;
      const sigKind = r.gmp_close != null ? "close" : cfg.allowPost && r.gmp_post != null ? "post" : null;
      const sig = sigKind === "close" ? r.gmp_close : sigKind === "post" ? r.gmp_post : null;
      const refund = addWd(bid, 2), release = addWd(listing, 1);
      rows.push({
        id: r.id, name: r.name, segment: seg, bid, listing, refund, release, fy: fyOf(listing),
        price: r.price, shares, invested, sell, charges, gross: sell - invested, netAllot: sell - invested - charges,
        gainPct: r.listing_gain_pct, p: known ? Math.min(1, 1 / r.sub_final) : cfg.allot[seg], pKnown: known,
        sigKind, gmpPct: sig == null ? null : sig / r.price * 100, gmpList: r.gmp_list,
        subClose: r.sub_final != null ? r.sub_final : r.sub_close, size: r.issue_size_cr, limited: !!r.limited,
        sector: r.sector || null, rating: r.rating, exchange: r.exchange || null, month: listing.slice(0, 7),
        gmpFirstPct: r.gmp_first == null ? null : r.gmp_first / r.price * 100, gmpPos: r.gmp_pos, gmpSlope: r.gmp_slope,
        ofsShare: r.ofs_cr != null && r.issue_size_cr ? r.ofs_cr / r.issue_size_cr * 100 : null, lead: r.lead_manager || null,
        dAllot: dn(release) - dn(bid), dRefund: dn(refund) - dn(bid),
      });
    }
    return rows.sort((a, b) => a.bid < b.bid ? -1 : 1);
  }

  function pass(r, s) {
    if (s.segment && s.segment !== "All" && r.segment !== s.segment) return false;
    if (s.from && r.bid < s.from) return false;
    if (s.to && r.bid > s.to) return false;
    if (s.minGmpPct != null && (r.sigKind == null || r.gmpPct < s.minGmpPct)) return false;
    if (s.minFirstGmpPct != null && !(r.gmpFirstPct >= s.minFirstGmpPct)) return false; // first-quoted GMP: known before bidding
    if (s.minSub != null && !(r.subClose >= s.minSub)) return false;   // final subscription (known as bidding closes)
    if (s.maxSub != null && !(r.subClose <= s.maxSub)) return false;
    if (s.minRating != null && !(r.rating >= s.minRating)) return false;
    if (s.minSize != null && !(r.size >= s.minSize)) return false;
    return true;
  }

  function rng(seed) { // mulberry32
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  function monteCarlo(sel, cfg) {
    const rand = rng(cfg.seed), N = cfg.accounts, runs = [];
    for (let i = 0; i < cfg.mcRuns; i++) {
      const fy = {};
      for (const r of sel) {
        let k = 0;
        for (let a = 0; a < N; a++) if (rand() < r.p) k++;
        if (k) fy[r.fy] = (fy[r.fy] || 0) + k * r.netAllot;
      }
      let tot = 0;
      for (const v of Object.values(fy)) tot += v - (cfg.applyTax && v > 0 ? v * cfg.taxPct / 100 : 0);
      runs.push(tot);
    }
    runs.sort((a, b) => a - b);
    return { mean: sum(runs, (x) => x) / runs.length, p10: q(runs, 0.1), p50: q(runs, 0.5), p90: q(runs, 0.9),
      pLoss: runs.filter((x) => x < 0).length / runs.length, worst: runs[0], best: runs[runs.length - 1] };
  }

  function run(rows, strat, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    const sel = rows.filter((r) => pass(r, strat || {})), N = cfg.accounts;
    if (!sel.length) return { strat, n: 0, empty: true };
    const fyNet = {}, tl = new Map(), eq = [];
    let gross = 0, charges = 0, capital = 0, cum = 0, peakEq = 0, maxDD = 0;
    for (const r of sel) {
      const k = N * r.p;
      gross += k * r.gross; charges += k * r.charges; capital += N * r.invested;
      fyNet[r.fy] = (fyNet[r.fy] || 0) + k * r.netAllot;
      const b = dn(r.bid), f = dn(r.refund), e = dn(r.release);
      for (let d = b; d < f; d++) tl.set(d, (tl.get(d) || 0) + N * r.invested);
      for (let d = f; d < e; d++) tl.set(d, (tl.get(d) || 0) + N * r.invested * r.p);
    }
    for (const r of sel.slice().sort((a, b) => a.listing < b.listing ? -1 : 1)) {
      cum += N * r.p * r.netAllot; eq.push([r.listing, cum]);
      peakEq = Math.max(peakEq, cum); maxDD = Math.max(maxDD, peakEq - cum);
    }
    const preTax = gross - charges;
    const tax = cfg.applyTax ? sum(Object.values(fyNet), (v) => Math.max(0, v) * cfg.taxPct / 100) : 0;
    const net = preTax - tax;
    const days = [...tl.keys()].sort((a, b) => a - b);
    const span = days.length ? days[days.length - 1] - days[0] + 1 : 0;
    const capitalDays = sum([...tl.values()], (v) => v);
    const gains = sel.map((r) => r.gainPct).filter((x) => x != null).sort((a, b) => a - b);
    const allotted = sel.map((r) => r.netAllot);
    return {
      strat, n: sel.length, applications: sel.length * N, expAllotments: N * sum(sel, (r) => r.p),
      allotRate: sum(sel, (r) => r.p) / sel.length, subKnownShare: sum(sel, (r) => +r.pKnown) / sel.length,
      gross, charges, tax, preTax, net, netPerApplication: net / (sel.length * N),
      avgNetPerAllotment: sum(sel, (r) => r.netAllot) / sel.length, // independent of allotment odds
      avgTicket: capital / (sel.length * N), capital,
      capitalDays, avgBlockedDays: capitalDays / capital,
      avgDaysAllot: sum(sel, (r) => r.dAllot) / sel.length, avgDaysRefund: sum(sel, (r) => r.dRefund) / sel.length,
      peakCapital: Math.max(0, ...tl.values()), avgCapital: span ? capitalDays / span : 0,
      utilisation: span ? days.length / span : 0, spanDays: span,
      annReturnPct: capitalDays ? net / capitalDays * 365 * 100 : 0,
      benchmarkPnl: capitalDays * cfg.benchmarkPct / 100 / 365,
      avgGainPct: gains.length ? sum(gains, (x) => x) / gains.length : null, medianGainPct: q(gains, 0.5),
      bestGainPct: gains.length ? gains[gains.length - 1] : null, worstGainPct: gains.length ? gains[0] : null,
      winRate: allotted.filter((x) => x > 0).length / allotted.length,
      // average listing gain of the shares you would actually receive (weights each IPO by its allotment odds)
      weightedGainPct: (() => {
        const w = sel.filter((r) => r.gainPct != null), tw = sum(w, (r) => r.p);
        return tw ? sum(w, (r) => r.p * r.gainPct) / tw : null;
      })(),
      lossRate: gains.filter((x) => x < 0).length / Math.max(1, gains.length),
      deepLossRate: gains.filter((x) => x <= -10).length / Math.max(1, gains.length),
      bigWinRate: gains.filter((x) => x >= 25).length / Math.max(1, gains.length),
      maxDrawdown: maxDD, equity: eq,
      blocked: days.map((d) => [iso(d), tl.get(d)]),
      byFy: Object.keys(fyNet).sort().map((k) => ({ fy: k, net: fyNet[k], n: sel.filter((r) => r.fy === k).length })),
      mc: cfg.mcRuns > 0 ? monteCarlo(sel, cfg) : null,
    };
  }

  function calibration(rows, which) {
    const val = (r) => (which === "close" ? (r.sigKind === "close" ? r.gmpPct : null)
      : r.gmpList == null ? null : r.gmpList / r.price * 100);
    const pts = rows.map((r) => ({ g: val(r), a: r.gainPct, seg: r.segment })).filter((x) => x.g != null && x.a != null);
    const n = pts.length;
    if (n < 3) return { n, buckets: [] };
    const mg = sum(pts, (x) => x.g) / n, ma = sum(pts, (x) => x.a) / n;
    const cov = sum(pts, (x) => (x.g - mg) * (x.a - ma)), vg = sum(pts, (x) => (x.g - mg) ** 2), va = sum(pts, (x) => (x.a - ma) ** 2);
    const edges = [-Infinity, 0.0001, 10, 25, 50, Infinity], names = ["<= 0%", "0-10%", "10-25%", "25-50%", "> 50%"];
    const buckets = names.map((label, i) => {
      const b = pts.filter((x) => x.g >= edges[i] && x.g < edges[i + 1] && !(i === 0 && x.g > 0.0001));
      return { label, n: b.length, avgGmp: b.length ? sum(b, (x) => x.g) / b.length : null,
        avgGain: b.length ? sum(b, (x) => x.a) / b.length : null, posRate: b.length ? b.filter((x) => x.a > 0).length / b.length : null };
    });
    return { n, corr: vg && va ? cov / Math.sqrt(vg * va) : null, bias: mg - ma,
      mae: sum(pts, (x) => Math.abs(x.g - x.a)) / n, buckets };
  }

  // ---- factor analytics (descriptive: applied, sold on listing day) ----
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return q(s, 0.5); };
  function stats(list) {
    const g = list.map((r) => r.gainPct).filter((x) => x != null);
    return { n: list.length, avgGain: g.length ? sum(g, (x) => x) / g.length : null, medianGain: g.length ? median(g) : null,
      posRate: g.length ? g.filter((x) => x > 0).length / g.length : null,
      avgNet: list.length ? sum(list, (r) => r.netAllot) / list.length : null,
      avgP: list.length ? sum(list, (r) => r.p) / list.length : null };
  }
  const HIST = [[-Infinity, -20, "< -20%"], [-20, -10, "-20 to -10"], [-10, 0, "-10 to 0"], [0, 10, "0 to 10"],
    [10, 25, "10 to 25"], [25, 50, "25 to 50"], [50, 100, "50 to 100"], [100, Infinity, "> 100%"]];
  function distribution(rows) {
    const g = rows.map((r) => r.gainPct).filter((x) => x != null);
    return HIST.map(([lo, hi, label]) => { const n = g.filter((x) => x >= lo && x < hi).length; return { label, n, share: g.length ? n / g.length : 0, lo, hi }; });
  }
  const BUCKETS = {
    gmp: [["<= 0%", (r) => r.gmpList != null && r.gmpList / r.price * 100 <= 0], ["0-10%", (r) => r.gmpList / r.price * 100 > 0 && r.gmpList / r.price * 100 < 10],
      ["10-25%", (r) => r.gmpList / r.price * 100 >= 10 && r.gmpList / r.price * 100 < 25], ["25-50%", (r) => r.gmpList / r.price * 100 >= 25 && r.gmpList / r.price * 100 < 50],
      ["> 50%", (r) => r.gmpList / r.price * 100 >= 50]],
    sub: [["< 1x", (r) => r.subClose < 1], ["1-3x", (r) => r.subClose >= 1 && r.subClose < 3], ["3-10x", (r) => r.subClose >= 3 && r.subClose < 10],
      ["10-50x", (r) => r.subClose >= 10 && r.subClose < 50], ["50-100x", (r) => r.subClose >= 50 && r.subClose < 100], ["> 100x", (r) => r.subClose >= 100]],
    size: [["< 50 Cr", (r) => r.size < 50], ["50-250 Cr", (r) => r.size >= 50 && r.size < 250], ["250-1000 Cr", (r) => r.size >= 250 && r.size < 1000], ["> 1000 Cr", (r) => r.size >= 1000]],
    rating: [["<= 2.5", (r) => r.rating <= 2.5], ["3-3.5", (r) => r.rating >= 3 && r.rating <= 3.5], ["4+", (r) => r.rating >= 4]],
  };
  function byBucket(rows, kind) {
    return (BUCKETS[kind] || []).map(([label, fn]) => Object.assign({ label }, stats(rows.filter((r) => { try { return fn(r) === true; } catch (e) { return false; } }))));
  }
  function byKey(rows, key, minN) {
    const m = new Map();
    for (const r of rows) { const k = r[key]; if (k == null || k === "") continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].map(([label, l]) => Object.assign({ label }, stats(l))).filter((x) => x.n >= (minN || 1)).sort((a, b) => b.n - a.n);
  }
  function monthly(rows) {
    return byKey(rows, "month").sort((a, b) => a.label < b.label ? -1 : 1);
  }
  // Evidence for a live IPO: listed IPOs of the same segment with a similar listing-eve GMP %.
  function similar(rows, seg, gmpPct, minN) {
    minN = minN || 8;
    const pool = rows.filter((r) => r.segment === seg && r.gmpList != null && r.gainPct != null);
    for (const tol of [4, 8, 15, 30]) {
      const m = pool.filter((r) => Math.abs(r.gmpList / r.price * 100 - gmpPct) <= tol);
      if (m.length >= minN || tol === 30) {
        const g = m.map((r) => r.gainPct).sort((a, b) => a - b);
        return { n: m.length, tol, avg: g.length ? sum(g, (x) => x) / g.length : null, median: q(g, 0.5),
          posRate: g.length ? g.filter((x) => x > 0).length / g.length : null, p10: q(g, 0.1), p90: q(g, 0.9),
          thin: m.length < minN };
      }
    }
    return { n: 0, thin: true };
  }

  function csv(rows) {
    const cols = ["id", "name", "segment", "bid", "listing", "price", "shares", "invested", "p", "sigKind", "gmpPct", "gainPct", "gross", "charges", "netAllot", "dAllot", "dRefund"];
    const f = (v) => v == null ? "" : typeof v === "number" ? String(Math.round(v * 100) / 100) : '"' + String(v).replace(/"/g, '""') + '"';
    return [cols.join(",")].concat(rows.map((r) => cols.map((c) => f(r[c])).join(","))).join("\n");
  }

  return { DEFAULTS, PRESETS, ledger, run, calibration, csv, addWd, fyOf, pass,
    stats, distribution, byBucket, byKey, monthly, similar, BUCKETS };
});
