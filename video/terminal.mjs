// Renders the REAL narrated-CLI output (apps/agent/src/cli.mjs) as 1920x1080 cards.
// Text below is verbatim from a live run against stellar:testnet — nothing invented.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'cards');
mkdirSync(OUT, { recursive: true });

const term = (title, lines, fontSize = 27) => `<!doctype html>
<html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&family=DM+Mono:ital,wght@0,300;0,400;0,500&display=swap" rel="stylesheet">
<style>
  :root{--ink:#0B0C0E;--paper:#F2EDE3;--brass:#FF7A18;--jade:#00C2A0;--clay:#B4553A}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1920px;height:1080px;overflow:hidden}
  body{background:var(--ink);color:var(--paper);
       font-family:'Bricolage Grotesque',Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .bar{height:74px;display:flex;align-items:center;gap:18px;padding:0 40px;
       border-bottom:1px solid rgba(242,237,227,.16)}
  .dot{width:13px;height:13px;border-radius:50%;background:rgba(242,237,227,.26)}
  .ttl{font-family:'DM Mono',Menlo,monospace;font-size:21px;letter-spacing:.16em;
       opacity:.62;margin-left:14px;text-transform:uppercase}
  pre{font-family:'DM Mono',Menlo,'SF Mono',monospace;font-size:${fontSize}px;line-height:1.5;
      padding:34px 46px;white-space:pre;color:rgba(242,237,227,.90)}
  .b{color:var(--brass)} .j{color:var(--jade)} .d{opacity:.42} .w{color:#fff}
</style></head><body>
<div class="bar"><div class="dot"></div><div class="dot"></div><div class="dot"></div>
<div class="ttl">${title}</div></div>
<pre>${lines}</pre></body></html>`;

/* --- verbatim excerpt: ranked sights ------------------------------------ */
const sights = `<span class="d">├──</span> <span class="b">02  SIGHTS TAKEN</span> <span class="d">GET http://localhost:4022/discovery/search</span>

  <span class="w">01</span> <span class="b">██████████████████████</span>  <span class="w">0.862</span>  <span class="w">paymap-fx</span>
                            <span class="d">http://localhost:4023/v1/fx/usd-brl</span>
                            <span class="j">100000 SXT</span> · http · <span class="j">2 settled</span>
                            <span class="d">bm25 14.35 · fields description+tags+url · terms usd+brl+exchang+rate · completeness 0.80</span>

  <span class="w">02</span> <span class="b">██████████████████████</span>  <span class="w">0.860</span>  <span class="w">USD/BRL FX Rate</span>
                            <span class="d">https://api.fxrates.example/v1/fx/usd-brl</span>
                            <span class="j">2500 SXT</span> · http · 0 settled
                            <span class="d">bm25 13.34 · fields serviceName+description+params+url+tags · terms usd+brl+rate+exchang · completeness 1.00</span>

  <span class="w">03</span> <span class="b">████████████████████</span><span class="d">░░</span>  <span class="w">0.800</span>  <span class="w">USDC/BRL Stablecoin Rate</span>
                            <span class="d">https://api.fxrates.example/v1/fx/usdc-brl</span>
                            <span class="j">2500 SXT</span> · http · 0 settled
                            <span class="d">bm25 10.27 · fields description+serviceName+tags+url · terms brl+rate+usd · completeness 1.00</span>

  <span class="w">04</span> <span class="b">████████████</span><span class="d">░░░░░░░░░░</span>  <span class="w">0.478</span>  <span class="w">Central Bank Indicators</span>
                            <span class="d">https://api.centralbank.example/v1/indicators</span>
                            <span class="j">1000 SXT</span> · http · 0 settled
                            <span class="d">bm25 3.11 · fields description · terms rate · completeness 0.80</span>

  <span class="w">05</span> <span class="b">███████████</span><span class="d">░░░░░░░░░░░</span>  <span class="w">0.441</span>  <span class="w">FX Historical Time Series</span>
                            <span class="d">https://api.fxrates.example/v1/fx/history</span>
                            <span class="j">6000 SXT</span> · http · 0 settled
                            <span class="d">bm25 2.60 · fields description · terms exchang · completeness 0.80</span>`;

/* --- verbatim excerpt: the paid loop ------------------------------------ */
const settle = `<span class="d">├──</span> <span class="b">04  PAYMENT SETTLED</span> <span class="d">x402: challenge · sign · retry · settle</span>

  <span class="d">-&gt;</span> GET http://localhost:4023/v1/fx/usd-brl <span class="d">(unpaid)</span>
  <span class="d">&lt;-</span> <span class="b">402 Payment Required</span> <span class="d">2ms</span>
     <span class="d">PAYMENT-REQUIRED x402 v2 · 1 option(s)</span>
     <span class="d">quote</span>  <span class="j">100000 SXT</span> -&gt; GCWHOZ…KG3O · CAYCPW…GPO2
  <span class="d">..</span> signing Soroban auth entry with GC2ZLS…W5AO <span class="d">2118ms</span>
     <span class="d">PAYMENT-SIGNATURE 3572 bytes</span>
  <span class="d">-&gt;</span> retry with payment header
  <span class="d">&lt;-</span> <span class="j">settled on stellar:testnet</span> <span class="d">7333ms</span>

  <span class="d">tx</span>         <span class="b">e1061055153ead603dd515446f5512850b2e858c16cd19e5b65f8a67b14e1c2b</span>
  <span class="d">explorer</span>   <span class="d">stellar.expert/explorer/testnet/tx/e1061055…</span>
  <span class="d">paid</span>       <span class="j">100000 SXT</span> -&gt; GCWHOZ…KG3O
  <span class="d">bazaar</span>     <span class="j">success</span>

  <span class="d">timings</span>
    <span class="d">challenge</span>      <span class="w">2ms</span>  <span class="d">▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁</span>
    <span class="d">sign</span>        <span class="w">2118ms</span>  <span class="b">▄▄▄▄▄▄▄</span><span class="d">▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁</span>
    <span class="d">settle</span>      <span class="w">7333ms</span>  <span class="b">▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄</span><span class="d">▁▁▁▁▁▁▁</span>
    <span class="d">total</span>       <span class="w">9462ms</span>

<span class="d">├──</span>    <span class="b">UNLOCKED PAYLOAD</span> <span class="j">HTTP 200</span>

  {
    <span class="j">"ok"</span>: true,
    <span class="j">"data"</span>: { <span class="j">"pair"</span>: "USD/BRL", <span class="j">"bid"</span>: <span class="w">5.4324</span>, <span class="j">"ask"</span>: <span class="w">5.4401</span>, <span class="j">"mid"</span>: <span class="w">5.4362</span> }
  }

  <span class="d">Discovered, priced, paid and delivered without a human in the loop.</span>`;

writeFileSync(`${OUT}/t1-sights.html`, term('agent · paymap discovery', sights, 25));
writeFileSync(`${OUT}/t2-settle.html`, term('agent · x402 paid loop · stellar:testnet', settle, 27));
console.log('wrote 2 terminal cards');
