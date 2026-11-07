import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const source = page.match(/<script>([\s\S]*)<\/script>/)[1]

// Run the actual page loop with a controlled clock and a minimal DOM/canvas.
function animation(reducedMotion, search = '') {
  let now = 0, draws = 0
  const listeners = new Map()
  const noop = () => {}
  const context = new Proxy({}, {
    get: (_, key) => key === 'clearRect' ? () => { draws++ } : noop,
    set: () => true,
  })
  const elements = new Map()
  function element(key) {
    if (!elements.has(key)) {
      const classes = new Set()
      elements.set(key, {
        dataset: {},
        style: { setProperty: noop },
        classList: {
          toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
          contains: (name) => classes.has(name),
        },
        getContext: () => context,
        querySelectorAll: () => [],
      })
    }
    return elements.get(key)
  }
  const scope = vm.createContext({
    innerWidth: 339, innerHeight: 977, devicePixelRatio: 2,
    performance: { now: () => now },
    document: { documentElement: element('html'), getElementById: element, querySelector: element, querySelectorAll: () => [], createElement: () => element('canvas') },
    location: { search }, URLSearchParams,
    matchMedia: () => ({ matches: reducedMotion }),
    addEventListener: (name, listener) => listeners.set(name, listener),
    scrollTo: noop, history: {}, requestAnimationFrame: noop,
    setTimeout: (fn) => fn(),
  })
  vm.runInContext(source, scope)
  return {
    go: (step) => vm.runInContext(`go(${step})`, scope),
    tick() { now += 16; vm.runInContext(`frame(${now})`, scope) },
    wheel(deltaY, options = {}, elapsed = 16) {
      now += elapsed
      let prevented = false
      listeners.get('wheel')({
        deltaY, deltaX: 0, deltaMode: 0, ctrlKey: false,
        target: { closest: () => null },
        ...options,
        preventDefault: () => { prevented = true },
      })
      return prevented
    },
    state: () => ({
      ...vm.runInContext('({step, shown, y, u, animating: !!tween})', scope),
      heading: element('h').textContent,
      visible: element('card').classList.contains('on'),
      draws,
    }),
  }
}

test('reduced motion renders each card in both directions and stops drawing at rest', () => {
  const page = animation(true)
  page.tick()
  const steps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
  for (const step of steps) {
    page.go(step)
    page.tick()
    const state = page.state()
    assert.equal(state.step, step)
    assert.equal(state.animating, false)
    assert.equal(state.visible, step > 0 && step < 13)
    if (state.visible) {
      assert.equal(state.shown, step - 1)
      assert.ok(state.heading)
    }
    for (let i = 0; i < 10; i++) page.tick()
    assert.equal(page.state().draws, state.draws)
  }
})

test('normal motion retains the animated transition and settles on the first card', () => {
  const page = animation(false)
  page.tick()
  page.go(1)
  page.tick()
  for (let i = 0; i < 35; i++) page.tick()
  assert.equal(page.state().animating, true)
  assert.ok(page.state().y > 0 && page.state().y < 1821.128)
  for (let i = 0; i < 145; i++) page.tick()
  assert.equal(page.state().animating, false)
  assert.equal(page.state().visible, true)
  assert.equal(page.state().heading, 'Wallets broadcast their swaps.')
})

test('explicit full motion matches the normal-motion animation on a reduced-motion system', () => {
  const normal = animation(false)
  const override = animation(true, '?motion=full')
  for (const step of [0, 1, 4, 8, 12, 13, 8, 1, 0]) {
    normal.go(step)
    override.go(step)
    for (let i = 0; i < 180; i++) {
      normal.tick()
      override.tick()
      assert.deepEqual(override.state(), normal.state())
    }
  }
})

test('a gentle trackpad gesture advances once even when its first event is below threshold', () => {
  const page = animation(true, '?motion=full')
  page.tick()
  page.wheel(0.5, {}, 250)
  for (const delta of [1, 2, 3, 6, 12]) {
    page.wheel(delta)
    page.tick()
  }
  assert.equal(page.state().step, 1)
  assert.equal(page.state().animating, true)
  // Momentum continues past the end of the transition without advancing again.
  for (let i = 0; i < 150; i++) {
    page.wheel(12 * Math.pow(0.95, i))
    page.tick()
  }
  assert.equal(page.state().step, 1)
  assert.equal(page.state().heading, 'Wallets broadcast their swaps.')
  // The next stroke grows out of the tail without any 200 ms pause or large mouse-like delta.
  page.wheel(0.5)
  for (const delta of [1, 2, 3, 6]) { page.wheel(delta); page.tick() }
  assert.equal(page.state().step, 2)
  for (let i = 0; i < 180; i++) page.tick()
  page.wheel(-0.5, {}, 250)
  for (const delta of [-1, -2, -3, -6]) { page.wheel(delta); page.tick() }
  assert.equal(page.state().step, 1)
})

test('gentle wheel input also advances only once with instant reduced-motion transitions', () => {
  const page = animation(true)
  page.tick()
  for (const delta of [0.5, 1, 2, 3, 6, 12, 10, 8, 4, 2, 1, 0.5]) {
    page.wheel(delta)
    page.tick()
  }
  assert.equal(page.state().step, 1)
})

test('wheel stepping preserves results scrolling, pinch zoom, horizontal gestures and line/page units', () => {
  const page = animation(true, '?motion=full')
  page.tick()
  assert.equal(page.wheel(100, { ctrlKey: true }), false)
  page.wheel(1, { deltaX: 20 })
  const panel = { scrollTop: 10, clientHeight: 100, scrollHeight: 400 }
  assert.equal(page.wheel(100, { target: { closest: () => panel } }), false)
  assert.equal(page.state().step, 0)
  page.wheel(1, { deltaMode: 1 }, 250)
  assert.equal(page.state().step, 1)
  for (let i = 0; i < 180; i++) page.tick()
  page.wheel(1, { deltaMode: 2 }, 250)
  assert.equal(page.state().step, 2)
})
