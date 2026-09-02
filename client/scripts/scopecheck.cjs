// Catch "X is not defined" runtime crashes statically: parse each JSX file with
// esbuild, then walk scopes to find identifiers used but never bound.
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const code = fs.readFileSync(f, 'utf8');
  let ast;
  try {
    ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx'] });
  } catch (e) { console.log(`PARSE FAIL ${f}: ${e.message}`); bad++; continue; }
  traverse(ast, {
    ReferencedIdentifier(p) {
      const name = p.node.name;
      if (p.scope.hasBinding(name, true)) return;
      if (typeof global[name] !== 'undefined') return;
      if (['window','document','console','React','Math','JSON','Date','Number','String','Object','Array','Boolean','Promise','parseInt','parseFloat','isNaN','alert','confirm','prompt','fetch','navigator','localStorage','sessionStorage','setTimeout','clearTimeout','setInterval','URL','Intl','FormData','Blob','File','Error','Notification','FileReader','AbortController','IntersectionObserver','ResizeObserver','requestAnimationFrame','structuredClone','btoa','atob','crypto','location','history','Image','Audio','WebSocket','performance','TextEncoder','TextDecoder','Map','Set','WeakMap','Symbol','RegExp','encodeURIComponent','decodeURIComponent','undefined'].includes(name)) return;
      console.log(`${path.relative(process.cwd(), f)}:${p.node.loc.start.line}  UNDEFINED: ${name}`);
      bad++;
    },
  });
}
console.log(bad ? `\n${bad} problem(s) found` : '\nno undefined identifiers ✓');
process.exit(bad ? 1 : 0);
