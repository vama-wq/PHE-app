// Finished-goods QC rule, tested on TEMPORARY test parts only (no live stock row
// is touched or locked), inside one transaction that is rolled back.
const S = require('path').join(__dirname, '..');
require(S + '/node_modules/dotenv').config({ path: S + '/.env' });
(async () => {
  const dbmod = require(S + '/src/db/index.js');
  const pool = dbmod.getDB().pool;
  const c = await pool.connect();
  await c.query('BEGIN'); await c.query("SET LOCAL lock_timeout='3s'");
  let sp = 0;
  const tx = {
    get: async (q, p = []) => (await c.query(q, p)).rows[0] || null, all: async (q, p = []) => (await c.query(q, p)).rows,
    run: async (q, p = []) => c.query(q, p), insert: async (q, p = []) => ({ lastInsertRowid: (await c.query(q.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id', p)).rows[0]?.id }),
    withTransaction: async (fn) => { const n = 's' + (++sp); await c.query(`SAVEPOINT ${n}`); try { const r = await fn(c); await c.query(`RELEASE SAVEPOINT ${n}`); return r; } catch (e) { await c.query(`ROLLBACK TO SAVEPOINT ${n}`); throw e; } }, pool,
  };
  dbmod.getDB = () => tx;
  const ded = require(S + '/src/lib/inventoryDeduction.js');
  const { applyBomCorrection } = require(S + '/src/lib/bomCorrection.js');
  let failed = false;
  const ok = (l, cond, x = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + l + (x ? '  ' + x : '')); if (!cond) failed = true; };
  const q1 = async (q, p = []) => (await c.query(q, p)).rows[0];
  try {
    const mk = async (code, cat, unit = 'pcs') => (await q1(`INSERT INTO inventory_items (item_code, name, unit, category, current_stock, approval_status)
       VALUES ($1,$1,$3,$2,100,'approved') RETURNING id`, ['ZZTEST-' + code, cat, unit])).id;
    const P = { nut: await mk('NUT', 'Nut'), wsh: await mk('WSH', 'Washer'), hvp: await mk('HVPIN', 'Heavy Terminal Pin'), wire: await mk('WIRE', 'Wire'),
      lug: await mk('LUG', 'Lugs'), thm: await mk('THM', 'Thermostat Spare'), brk: await mk('BRK', 'Bracket'), fin: await mk('FIN', 'Finns', 'kg'),
      pin: await mk('PIN', 'Terminal Pin'), esb: await mk('ESB', 'End Sealing Bush'), nip: await mk('NIP', 'Nipple Fastner'), pkg: await mk('PKG', 'Packaging') };
    const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
    const setLines = async (itemId, lines) => {
      await c.query('DELETE FROM order_item_inventory WHERE order_item_id=$1', [itemId]);
      for (const [id, qty] of lines) await c.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted, qty_waived) VALUES ($1,$2,$3,0,0)', [itemId, id, qty]);
      await c.query('UPDATE order_items SET inventory_deducted=FALSE WHERE id=$1', [itemId]);
    };
    // A finished-goods order line (already dispatched in real life; its real lines are swapped for test parts here).
    const fg = await q1(`SELECT oi.id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.order_type='finished_goods' ORDER BY oi.id DESC LIMIT 1`);
    await setLines(fg.id, [[P.nut, 10], [P.wsh, 10], [P.hvp, 5], [P.wire, 2], [P.lug, 4], [P.thm, 1], [P.brk, 2], [P.fin, 0.35], [P.pin, 5], [P.esb, 5], [P.nip, 5], [P.pkg, 1]]);
    await ded.deductItemInventory(tx, fg.id, 'TEST', 4, 'Consumed (QC/dispatch)');
    const want = { nut: 90, wsh: 90, hvp: 95, wire: 98, lug: 96, thm: 99, brk: 98, fin: 99.65, pin: 100, esb: 100, nip: 100, pkg: 100 };
    const got = {}; for (const k of Object.keys(want)) got[k] = await stock(P[k]);
    ok('Finished-goods QC takes nuts, washers, heavy pin, wire, lugs, thermostat, bracket and fins (by the kg on the list)',
      ['nut', 'wsh', 'hvp', 'wire', 'lug', 'thm', 'brk', 'fin'].every(k => Math.abs(got[k] - want[k]) < 1e-6), JSON.stringify(got));
    ok('…and does not take terminal pins, end sealing bushes, nipples or packaging', ['pin', 'esb', 'nip', 'pkg'].every(k => got[k] === 100));
    const ws = (await c.query('SELECT inventory_item_id, qty_deducted::float d, qty_waived::float w FROM order_item_inventory WHERE order_item_id=$1', [fg.id])).rows;
    ok('…the parts not taken are marked settled, so nothing takes them later', [P.pin, P.esb, P.nip, P.pkg].every(id => ws.find(r => r.inventory_item_id === id).w > 0));
    // A correction on that finished-goods order: never moves the parts inside the heater.
    const r = await applyBomCorrection(tx, { orderItemId: fg.id, userId: 4, userRole: 'design',
      sels: [{ id: P.nut, qty: 12 }, { id: P.wsh, qty: 10 }, { id: P.hvp, qty: 5 }, { id: P.wire, qty: 2 }, { id: P.lug, qty: 4 }, { id: P.thm, qty: 1 }, { id: P.brk, qty: 2 }, { id: P.fin, qty: 0.35 }, { id: P.pin, qty: 9 }] });
    ok('A correction on a finished-goods order moves only the prep parts (2 more nuts), never the pins inside the heater',
      Math.abs((await stock(P.nut)) - 88) < 1e-6 && (await stock(P.pin)) === 100 && (await stock(P.esb)) === 100, r.summary);
    // A normal order still takes everything as before.
    const nl = await q1(`SELECT oi.id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.order_type <> 'finished_goods' ORDER BY oi.id DESC LIMIT 1`);
    await setLines(nl.id, [[P.pin, 6], [P.esb, 3], [P.nut, 4]]);
    const b = { pin: await stock(P.pin), esb: await stock(P.esb), nut: await stock(P.nut) };
    await ded.deductItemInventory(tx, nl.id, 'TEST', 4, 'Consumed (QC/dispatch)');
    ok('A normal order still takes its whole list at QC (pins, sealing bush, nuts)',
      (await stock(P.pin)) === b.pin - 6 && (await stock(P.esb)) === b.esb - 3 && (await stock(P.nut)) === b.nut - 4);
  } catch (e) { console.error('TEST ERROR', e); failed = true; }
  finally { await c.query('ROLLBACK'); c.release(); await pool.end(); console.log('rolled back — nothing kept'); process.exit(failed ? 1 : 0); }
})();
