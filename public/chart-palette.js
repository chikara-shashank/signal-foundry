let key, cached;
/** Read once per design, not on every incoming quote or canvas frame. */
export function chartPalette() {
  const design = document.documentElement.dataset.design ?? 'floor';
  if (key !== design) {
    const style = getComputedStyle(document.documentElement);
    const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    cached = {
      bg: read('--plot-bg', '#0e151e'), grid: read('--line', '#20303b'), text: read('--muted', '#8496a8'),
      foreground: read('--text', '#e5edf4'), up: read('--green', '#6ce0b5'), down: read('--red', '#f08298'),
      amber: read('--amber', '#ecc37c'), blue: read('--blue', '#84b8fa'), purple: read('--purple', '#b3a1df'),
    };
    key = design;
  }
  return cached;
}
