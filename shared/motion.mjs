// Progressive enhancement only: no navigation handlers, storage or network calls.
// Observe menu state, not arbitrary content updates, so typing and study timers
// never trigger a fresh entrance. All content remains visible without this file.
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const animations = new Set();
const menuSelector = '.rail, #navigation, #nav, .tabbar, #topics';
const selectedSelector = '[aria-current="page"], .active';
let previousState = '';
let frame = 0;

function cancelAnimations() {
  for (const animation of animations) animation.cancel();
  animations.clear();
}

function entrance(elements) {
  cancelAnimations();
  if (reduced.matches || !Element.prototype.animate) return;
  // Cap work on long libraries and animate only currently visible surfaces.
  const visible = elements.filter(el => {
    const rect = el.getBoundingClientRect();
    return rect.width && rect.height && rect.top < innerHeight && rect.bottom > 0;
  }).slice(0, 6);
  visible.forEach((el, index) => {
    const animation = el.animate([
      { opacity: .65, translate: '0 7px' },
      { opacity: 1, translate: '0 0' }
    ], { duration: 280, delay: index * 35, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
    animations.add(animation);
    animation.onfinish = animation.oncancel = () => animations.delete(animation);
  });
}

function update() {
  frame = 0;
  const state = location.hash + [...document.querySelectorAll(menuSelector)]
    .map(menu => [...menu.querySelectorAll(selectedSelector)]
      .map(el => el.dataset.nav || el.dataset.mode || el.dataset.topic || el.getAttribute('href') || el.textContent.trim())
      .join('|')).join(';');
  if (state === previousState) return;
  previousState = state;
  const content = document.querySelector('#main, #view');
  if (content) entrance([...content.children]);
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(update);
}

const observer = new MutationObserver(schedule);
for (const menu of document.querySelectorAll(menuSelector)) {
  observer.observe(menu, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'aria-current'] });
}
// Async app startup may populate the content after its navigation has loaded.
const content = document.querySelector('#main, #view');
if (content) observer.observe(content, { childList: true });
addEventListener('hashchange', schedule);
addEventListener('popstate', schedule);
reduced.addEventListener('change', cancelAnimations);
addEventListener('pagehide', cancelAnimations);
schedule();
entrance([...document.querySelectorAll('a.app')]);
