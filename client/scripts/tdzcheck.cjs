// Catch "Cannot access 'X' before initialization".
//
// The dangerous shape is a component that returns early:
//
//   const load = () => { if (canSee) ... };   // reads a const declared later
//   useEffect(() => { load(); }, []);
//   if (loading) return <Spinner/>;           // first render stops here
//   const canSee = ...;                       // never reached on that render
//
// The effect fires after that first render and calls load(), which touches a
// binding whose declaration never executed. Builds pass; the page white-screens.
//
//   node scripts/tdzcheck.cjs <files...>
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

let bad = 0;
for (const f of process.argv.slice(2)) {
  const code = fs.readFileSync(f, 'utf8');
  let ast;
  try { ast = parser.parse(code, { sourceType: 'unambiguous', plugins: ['jsx'] }); }
  catch { continue; }

  traverse(ast, {
    Scopable(p) {
      for (const [name, binding] of Object.entries(p.scope.bindings)) {
        if (binding.kind !== 'const' && binding.kind !== 'let') continue;
        const declLine = binding.identifier.loc?.start.line;
        if (!declLine) continue;

        for (const ref of binding.referencePaths) {
          const refLine = ref.node.loc?.start.line;
          if (!refLine || refLine >= declLine) continue;

          // Is the reference inside a function defined before the declaration?
          // If so it is only safe when every caller runs after that line — which
          // an effect on the first render does not.
          let fn = null, cur = ref;
          while (cur && cur.node !== p.node) {
            if (cur.isFunction() || cur.isArrowFunctionExpression()) { fn = cur; break; }
            cur = cur.parentPath;
          }
          // Reading a later const from inside an earlier function is only a
          // problem when the declaration can be skipped — i.e. an early return
          // sits between the two. Without one, the whole body runs before any
          // effect fires and the binding is set by then.
          if (fn) {
            // Look for ANY return between the two lines that belongs to this
            // scope — including `if (loading) return <Spinner/>`, where the
            // return is nested inside an if rather than a direct child.
            let skipped = false;
            p.traverse({
              Function(fp) { fp.skip(); },          // returns inside nested fns don't count
              ReturnStatement(rp) {
                const l = rp.node.loc?.start.line;
                if (l > refLine && l < declLine) skipped = true;
              },
            });
            if (!skipped) continue;
          }
          console.log(`${path.relative(process.cwd(), f)}:${refLine}  USED BEFORE DECLARED: ${name} (declared line ${declLine})`
            + (fn ? ` — an early return on line between them can skip the declaration` : ''));
          bad++;
        }
      }
    },
  });
}
console.log(bad ? `\n${bad} problem(s) found` : '\nno use-before-declaration ✓');
process.exit(bad ? 1 : 0);
