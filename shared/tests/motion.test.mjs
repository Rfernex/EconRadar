import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../motion.mjs', import.meta.url), 'utf8');
function harness(reduce = false) {
  const frames = [], played = [], events = {}, preferenceEvents = {};
  const preference = { matches: reduce, addEventListener: (name, fn) => preferenceEvents[name] = fn };
  const selected = { dataset: { nav: 'overview' } };
  const menu = { querySelectorAll: () => [selected] };
  const content = { children: Array.from({ length: 10 }, (_, i) => ({
    getBoundingClientRect: () => ({ width: 100, height: 100, top: i * 100, bottom: i * 100 + 100 }),
    animate: (keyframes, options) => {
      const animation = { cancelled: false, cancel() { this.cancelled = true; this.oncancel?.(); } };
      played.push({ animation, keyframes, options });
      return animation;
    }
  })) };
  let mutation;
  runInNewContext(source, {
    matchMedia: () => preference, Element: { prototype: { animate() {} } }, innerHeight: 900,
    document: { querySelector: () => content, querySelectorAll: s => s === 'a.app' ? [] : [menu] },
    location: { hash: '' }, requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} },
    addEventListener: (name, fn) => events[name] = fn
  });
  const flush = () => { while (frames.length) frames.shift()(); };
  return { played, selected, mutation: () => { mutation(); flush(); }, flush, preference, preferenceEvents };
}

test('section changes animate visible surfaces once, capped at six; ordinary updates stay still', () => {
  const h = harness(); h.flush();
  assert.equal(h.played.length, 6);
  h.mutation(); h.mutation();
  assert.equal(h.played.length, 6);
  h.selected.dataset.nav = 'library'; h.mutation();
  assert.equal(h.played.length, 12);
  assert.ok(h.played.slice(0, 6).every(p => p.animation.cancelled));
  assert.equal(h.played[11].options.delay, 175);
});

test('reduced motion prevents entrances and cancels running animations when enabled', () => {
  const quiet = harness(true); quiet.flush();
  quiet.selected.dataset.nav = 'library'; quiet.mutation();
  assert.equal(quiet.played.length, 0);
  const h = harness(); h.flush();
  h.preference.matches = true; h.preferenceEvents.change();
  assert.ok(h.played.every(p => p.animation.cancelled));
  h.selected.dataset.nav = 'library'; h.mutation();
  assert.equal(h.played.length, 6);
});
