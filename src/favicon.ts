/** Admin UI favicon: pastel paper gradient + ink, matches the handcrafted admin theme. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Someting">
<defs>
<linearGradient id="smt" x1="0%" y1="0%" x2="100%" y2="100%">
<stop offset="0%" stop-color="#ffe1d2"/>
<stop offset="52%" stop-color="#dff5e8"/>
<stop offset="100%" stop-color="#d9efff"/>
</linearGradient>
</defs>
<rect width="32" height="32" rx="8" fill="url(#smt)" stroke="#263238" stroke-width="2"/>
<text x="16" y="22.5" text-anchor="middle" font-family="system-ui,Segoe UI,Inter,sans-serif" font-size="16" font-weight="900" fill="#263238">S</text>
</svg>`;

export function renderFaviconTags(): string {
  return `  <link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any" />
  <meta name="theme-color" content="#fffaf0" />`;
}
