/** Presentation only. Design IDs never select a trading strategy or risk policy. */
export const DESIGNS = [
  { id: 'floor', name: 'Floor', number: '01', theme: 'dark', layout: 'desk', description: 'Charcoal, warm orange and compact sans-serif type. Returns and account P/L share the first row.', detail: 'Balanced · horizontal navigation' },
  { id: 'ledger', name: 'Ledger', number: '02', theme: 'light', layout: 'editorial', description: 'Ivory paper, ink rules and serif headings. Open positions lead; returns follow as a broad ledger.', detail: 'Positions first · warm paper' },
  { id: 'terminal', name: 'Terminal', number: '03', theme: 'dark', layout: 'terminal', description: 'Monospaced type, square edges and restrained green. Quotes and execution sit ahead of performance.', detail: 'Market first · maximum density' },
  { id: 'atlas', name: 'Atlas', number: '04', theme: 'light', layout: 'rail', description: 'A navy navigation rail, cool white surfaces and blue accents. A structured, familiar workstation.', detail: 'Side navigation · cool white' },
  { id: 'bulletin', name: 'Bulletin', number: '05', theme: 'light', layout: 'newsroom', description: 'Black rules, cream stock and large editorial typography. A broad return chart anchors the page.', detail: 'Returns first · editorial hierarchy' },
  { id: 'slate', name: 'Slate', number: '06', theme: 'light', layout: 'compact', description: 'Graphite text on soft gray, short rows and a narrow rail. Built for quick, repeated checks.', detail: 'Compact rail · table emphasis' },
  { id: 'horizon', name: 'Horizon', number: '07', theme: 'dark', layout: 'panorama', description: 'A wide marine canvas, cyan markers and expansive charts. The execution tape runs below price.', detail: 'Panoramic charts · wide canvas' },
  { id: 'copper', name: 'Copper', number: '08', theme: 'dark', layout: 'split', description: 'Warm charcoal, copper accents and a split account overview. Large figures meet a precise grid.', detail: 'Split overview · warm dark' },
  { id: 'folio', name: 'Folio', number: '09', theme: 'light', layout: 'folio', description: 'White space, deep red accents and a narrow reading column. Charts receive a full-width stage.', detail: 'Single column · generous spacing' },
  { id: 'vector', name: 'Vector', number: '10', theme: 'dark', layout: 'matrix', description: 'A blue-black matrix with violet accents, indexed sections and close-set data. Clear operational rhythm.', detail: 'Matrix layout · analytical density' },
];

export const DEFAULT_DESIGN_ID = 'ledger';
export const DASHBOARD_THEMES = DESIGNS.filter(design => ['ledger', 'copper'].includes(design.id));
export function findDesign(id) { return DESIGNS.find(design => design.id === id) ?? DESIGNS.find(design => design.id === DEFAULT_DESIGN_ID); }
