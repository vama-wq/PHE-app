// Catch "X is not defined" runtime crashes statically: parse each JS/JSX file
// and walk its scopes for identifiers that are used but never bound. Vite and
// node both compile happily past these — they only blow up when the code path
// actually runs, which is how "canWork is not defined" reached the payroll page.
//
//   node scripts/scopecheck.cjs <files...>
//
// Handles ESM + JSX (client) and CommonJS (server): the parser runs in
// 'unambiguous' mode, and both browser and node globals are allowed.
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const BROWSER = ['window', 'document', 'navigator', 'location', 'history', 'alert', 'confirm', 'prompt',
  'fetch', 'localStorage', 'sessionStorage', 'FormData', 'Blob', 'File', 'FileReader', 'Image', 'Audio',
  'Notification', 'WebSocket', 'AbortController', 'IntersectionObserver', 'ResizeObserver',
  'requestAnimationFrame', 'cancelAnimationFrame', 'btoa', 'atob', 'crypto', 'performance',
  'TextEncoder', 'TextDecoder', 'React', 'createImageBitmap', 'OffscreenCanvas', 'DOMParser', 'MutationObserver'];
const NODE = ['require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer', 'global',
  'setImmediate', 'clearImmediate'];
const SHARED = ['console', 'Math', 'JSON', 'Date', 'Number', 'String', 'Object', 'Array', 'Boolean',
  'Promise', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'URL', 'URLSearchParams', 'Intl', 'Error', 'TypeError', 'RangeError', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Symbol', 'RegExp', 'Function', 'Proxy', 'Reflect', 'BigInt', 'queueMicrotask',
  'structuredClone', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'undefined',
  'NaN', 'Infinity', 'globalThis'];
const ALLOWED = new Set([...BROWSER, ...NODE, ...SHARED]);

const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const code = fs.readFileSync(f, 'utf8');
  let ast;
  try {
    ast = parser.parse(code, { sourceType: 'unambiguous', plugins: ['jsx'], errorRecovery: false });
  } catch (e) { console.log(`PARSE FAIL ${f}: ${e.message}`); bad++; continue; }
  traverse(ast, {
    ReferencedIdentifier(p) {
      const name = p.node.name;
      if (p.scope.hasBinding(name, true)) return;
      if (ALLOWED.has(name)) return;
      if (typeof global[name] !== 'undefined') return;
      console.log(`${path.relative(process.cwd(), f)}:${p.node.loc.start.line}  UNDEFINED: ${name}`);
      bad++;
    },
  });
}
console.log(bad ? `\n${bad} problem(s) found` : '\nno undefined identifiers ✓');
process.exit(bad ? 1 : 0);
