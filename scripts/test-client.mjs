/**
 * Render-time smoke test for the client half, without a browser.
 * It catches missing references / bad hook order in the first render.
 */
let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
}

await import('../client.js')

let View
const ctx = {
  locale: {
    register() {
      return () => {}
    },
    bind() {
      return (key) => key
    },
  },
  remote: { workspaceFiles: {} },
  effect(fn) {
    return fn()
  },
  slots: {
    inject(_key, callback) {
      return callback()
    },
    register(_options, component) {
      View = component
      return () => {}
    },
  },
}

loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
}).apply(ctx)

if (!View) throw new Error('view was not registered')
const tree = View({ sessionId: 'test-session' })
if (!tree) throw new Error('view returned no tree')
console.log('client render OK; root class =', tree.props.className)
