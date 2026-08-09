// Renders apps/web/public/assets/og-card.svg -> og-card.png (1200x630).
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
const svg = readFileSync(new URL('../apps/web/public/assets/og-card.svg', import.meta.url), 'utf8');
const png = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1200 },
  font: { loadSystemFonts: true },
  background: '#0B0C0E',
}).render().asPng();
writeFileSync(new URL('../apps/web/public/assets/og-card.png', import.meta.url), png);
console.log('og-card.png written', png.length, 'bytes');
