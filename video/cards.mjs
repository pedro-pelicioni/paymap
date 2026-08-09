// PAYMAP demo video — title card generator.
// Emits standalone 1920x1080 HTML cards that headless Chrome rasterizes to PNG.
// Visual language mirrors apps/web exactly: ink/paper/brass/jade/clay,
// Instrument Serif (display), Bricolage Grotesque (UI), DM Mono (numbers).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ASSETS = `file://${ROOT}/apps/web/public/assets`;
const OUT = resolve(HERE, 'cards');
mkdirSync(OUT, { recursive: true });

const shell = (body, extra = '') => `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<style>
  :root{
    --ink:#0B0C0E; --paper:#F2EDE3; --brass:#FF7A18; --jade:#00C2A0; --clay:#B4553A;
    --serif:'Instrument Serif', Georgia, 'Times New Roman', serif;
    --ui:'Bricolage Grotesque', 'Helvetica Neue', Arial, sans-serif;
    --mono:'DM Mono', Menlo, 'SF Mono', monospace;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1920px;height:1080px;overflow:hidden}
  body{background:var(--paper);color:var(--ink);font-family:var(--ui);
       -webkit-font-smoothing:antialiased;position:relative}
  .grain{position:absolute;inset:0;background-image:url('${ASSETS}/texture-grain.png');
         background-size:600px;opacity:.28;mix-blend-mode:multiply;pointer-events:none;z-index:5}
  .ink{background:var(--ink);color:var(--paper)}
  .ink .grain{mix-blend-mode:overlay;opacity:.20}
  .stage{position:absolute;inset:0;display:flex;flex-direction:column;
         justify-content:center;padding:0 132px;z-index:2}
  .eyebrow{font-family:var(--mono);font-size:19px;letter-spacing:.34em;text-transform:uppercase;
           opacity:.55;margin-bottom:34px}
  .rule{height:1px;background:currentColor;opacity:.20;margin:34px 0}
  em{font-family:var(--serif);font-style:italic}
  .mono{font-family:var(--mono)}
  .brass{color:var(--brass)} .jade{color:var(--jade)} .clay{color:var(--clay)}
  ${extra}
</style></head>
<body class="${body.cls || ''}">${body.html}<div class="grain"></div></body></html>`;

const cards = {};

/* ---- 01 cold open ------------------------------------------------------ */
cards['01-open'] = shell({
  cls: 'ink',
  html: `<div class="stage" style="align-items:center;text-align:center;padding-top:20px">
    <div style="width:46px;height:46px;border:2px solid var(--brass);transform:rotate(45deg);
         margin:0 auto 74px"></div>
    <h1 style="font-family:var(--serif);font-size:206px;line-height:.94;letter-spacing:.055em;
        text-indent:.055em">PAYMAP</h1>
    <div style="width:180px;height:1px;background:var(--brass);margin:52px auto"></div>
    <p style="font-family:var(--serif);font-size:60px;opacity:.94">
      Find <em class="brass">what to pay for</em> on Stellar.</p>
  </div>`,
});

/* ---- 02 the gap, stated ------------------------------------------------ */
cards['02-gap'] = shell({
  html: `<div class="stage">
    <div class="eyebrow">The gap</div>
    <h2 style="font-family:var(--serif);font-size:126px;line-height:1.06">
      On Stellar, x402 settlement is <span class="jade">already solved</span>.<br>
      Discovery is <em class="clay">not</em>.
    </h2>
    <div class="rule" style="margin:60px 0 44px"></div>
    <p style="font-size:46px;line-height:1.42;max-width:1500px;opacity:.82">
      An agent that can pay but cannot discover is an agent
      with a wallet and <em>no map</em>.
    </p>
  </div>`,
});

/* ---- 03 the gap, evidenced --------------------------------------------- */
cards['03-evidence'] = shell({
  html: `<div class="stage">
    <div class="eyebrow">Verifiable, not asserted</div>
    <div style="display:flex;flex-direction:column;gap:0;margin-top:14px">
      <div class="row"><div class="mark jade">&#10003;</div><div>
        <div class="t">The <span class="mono">bazaar</span> extension spec defines
          <span class="mono">/discovery/resources</span> + <span class="mono">/discovery/search</span></div>
        <div class="s">Specified.</div></div></div>
      <div class="row"><div class="mark clay">&#10007;</div><div>
        <div class="t"><span class="mono">@x402/extensions/bazaar</span> ships
          <em>no facilitator-side catalog</em></div>
        <div class="s">Its own README says so — client and server helpers only.</div></div></div>
      <div class="row" style="border-bottom:none"><div class="mark clay">&#10007;</div><div>
        <div class="t">Stellar has a Bazaar</div>
        <div class="s"><span class="mono">stellar/x402-stellar#50</span> — open and unassigned since April 2026.</div></div></div>
    </div>
    <p style="font-size:42px;margin-top:52px;line-height:1.4">
      PAYMAP is that <span class="brass">missing facilitator-side layer</span>.</p>
  </div>`,
}, `
  .row{display:flex;gap:40px;align-items:flex-start;padding:34px 0;
       border-bottom:1px solid rgba(11,12,14,.14)}
  .mark{font-size:44px;line-height:1;width:44px;flex:none;padding-top:6px}
  .t{font-size:44px;line-height:1.32}
  .s{font-size:30px;opacity:.58;margin-top:12px;line-height:1.4}
  .mono{font-size:.92em}
`);

/* ---- 04 chapter: the product ------------------------------------------- */
cards['04-chapter'] = shell({
  cls: 'ink',
  html: `<div class="stage">
    <div class="eyebrow brass">Live on stellar:testnet</div>
    <h2 style="font-family:var(--serif);font-size:132px;line-height:1.04">
      The <em class="brass">Sight Board</em>.</h2>
    <p style="font-size:46px;line-height:1.44;max-width:1560px;opacity:.80;margin-top:34px">
      Natural-language query over 30 indexed resources. BM25 hybrid ranking,
      re-ordered live — with the score broken open.</p>
  </div>`,
});

/* ---- 05 explain caption (overlaid context for the crop) ---------------- */
cards['05-explain'] = shell({
  cls: 'ink',
  html: `<div class="stage">
    <div class="eyebrow brass">_EXPLAIN</div>
    <h2 style="font-family:var(--serif);font-size:118px;line-height:1.05">
      Every score, <em>broken open</em>.</h2>
    <div class="rule" style="margin:48px 0 42px;background:var(--paper)"></div>
    <div class="mono" style="font-size:41px;line-height:2.0;opacity:.92">
      <span class="brass">1.00</span> &middot; bm25 &nbsp;
      <span class="brass">0.12</span> &middot; completeness &nbsp;
      <span class="brass">0.08</span> &middot; settlements &nbsp;
      <span class="brass">0.05</span> &middot; recency
    </div>
    <p style="font-size:40px;margin-top:40px;opacity:.78;line-height:1.42;max-width:1560px">
      The quality prior caps at <span class="mono">0.25</span> against relevance's
      <span class="mono">1.00</span> — quality breaks ties, it never overrides relevance.
      A test asserts it.</p>
  </div>`,
});

/* ---- 06 the paid loop -------------------------------------------------- */
cards['06-loop'] = shell({
  cls: 'ink',
  html: `<div class="stage" style="justify-content:center">
    <div class="eyebrow brass">Discover &rarr; pay &rarr; settle</div>
    <div style="display:flex;align-items:center;gap:40px;margin:26px 0 60px;flex-wrap:nowrap">
      <div class="step"><div class="n">402</div><div class="l">Payment Required</div></div>
      <div class="arw">&rarr;</div>
      <div class="step"><div class="n">SIGN</div><div class="l">PAYMENT-SIGNATURE</div></div>
      <div class="arw">&rarr;</div>
      <div class="step"><div class="n">SETTLE</div><div class="l">facilitator</div></div>
      <div class="arw">&rarr;</div>
      <div class="step ok"><div class="n jade">200</div><div class="l">resource returned</div></div>
    </div>
    <div class="rule" style="background:var(--paper);margin:0 0 40px"></div>
    <div style="font-size:34px;opacity:.62;letter-spacing:.06em;margin-bottom:18px"
         class="mono">SETTLED &middot; STELLAR TESTNET</div>
    <div class="mono brass" style="font-size:37px;letter-spacing:.02em;word-break:break-all">
      c1acc578032a3a06a88603f971d871703f45b1246e0f1aa8862500495edbfba6</div>
    <p style="font-size:38px;margin-top:38px;opacity:.80">
      Fees sponsored by the facilitator — the paying agent needs
      <span class="jade">zero XLM</span>.</p>
  </div>`,
}, `
  .step{border:1px solid rgba(242,237,227,.30);padding:32px 40px;min-width:290px;text-align:center}
  .step.ok{border-color:var(--jade)}
  .n{font-family:var(--mono);font-size:60px;letter-spacing:.04em}
  .l{font-size:25px;opacity:.60;margin-top:14px;letter-spacing:.04em}
  .arw{font-size:52px;opacity:.42;flex:none}
`);

/* ---- 07 close ---------------------------------------------------------- */
cards['07-close'] = shell({
  html: `<div class="stage" style="align-items:center;text-align:center">
    <div style="display:flex;gap:0;margin-bottom:74px;width:100%;justify-content:center">
      <div class="stat"><div class="v">20</div><div class="k">settled testnet<br>transactions</div></div>
      <div class="stat"><div class="v">70<span style="opacity:.34">/70</span></div><div class="k">tests<br>passing</div></div>
      <div class="stat"><div class="v" style="font-size:96px;letter-spacing:0">Apache&#8209;2.0</div><div class="k">public from the<br>first commit</div></div>
      <div class="stat" style="border-right:none"><div class="v" style="font-size:96px">0</div><div class="k">faucets, captchas,<br>API keys</div></div>
    </div>
    <p style="font-family:var(--serif);font-size:66px;line-height:1.3;max-width:1520px">
      <span class="mono" style="font-size:.72em">npm install &amp;&amp; npm run setup</span><br>
      <span style="opacity:.62;font-size:.78em">Runs start to finish. No web forms. No keys.</span></p>
    <div class="rule" style="width:200px;margin:56px auto"></div>
    <div class="mono" style="font-size:44px;letter-spacing:.03em">
      github.com/<span class="brass">pedro-pelicioni/paymap</span></div>
  </div>`,
}, `
  .stat{padding:0 62px;border-right:1px solid rgba(11,12,14,.16)}
  .v{font-family:var(--mono);font-size:126px;line-height:1;letter-spacing:-.01em}
  .k{font-size:25px;opacity:.58;margin-top:22px;line-height:1.45;letter-spacing:.05em;
     text-transform:uppercase}
`);

/* ---- 08 wordmark outro -------------------------------------------------- */
cards['08-end'] = shell({
  cls: 'ink',
  html: `<div class="stage" style="align-items:center;text-align:center">
    <div style="width:38px;height:38px;border:2px solid var(--brass);transform:rotate(45deg);
         margin:0 auto 58px"></div>
    <h1 style="font-family:var(--serif);font-size:152px;letter-spacing:.06em;text-indent:.06em">PAYMAP</h1>
    <p style="font-family:var(--serif);font-size:48px;opacity:.80;margin-top:30px">
      Find <em class="brass">what to pay for</em> on Stellar.</p>
    <p class="mono" style="font-size:26px;opacity:.50;margin-top:64px;letter-spacing:.20em">
      STELLAR SUMMIT SP 2026 &middot; SUB-LANE 3A &middot; AGENTIC PAYMENTS</p>
  </div>`,
});

for (const [name, html] of Object.entries(cards)) {
  writeFileSync(`${OUT}/${name}.html`, html);
}
console.log(`wrote ${Object.keys(cards).length} cards to ${OUT}`);
