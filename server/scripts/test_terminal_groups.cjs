// Test for terminal pin groups (owner, 26 Oct 2026; lib/terminalGroups.js):
// every 'Terminal Pin' item names its group — Regular, One Side Threaded or No
// Thread — and a job card picks its pins from its own group only. Make Job
// Card asks the group (Regular unless chosen) and freezes it on the card; the
// card's pins, its slip rows and the Spot take follow it. An item with no
// group is never picked; two items of one group that both fit are never
// guessed between. Adding or editing a Terminal Pin item without its group is
// refused, and so is an import row without one.
//
// Runs inside one transaction that is ROLLED BACK, on made-up M9 pins
// (TP-SS-M9-…), orders, items and cards, plus the real M4 pins for the Make
// Job Card part. Storage uploads and WhatsApp are stubbed.
//   node scripts/test_terminal_groups.cjs
const path = require('path');
const S = path.join(__dirname, '..');
require(S + '/node_modules/dotenv').config({ path: S + '/.env' });

(async () => {
  const dbmod = require(S + '/src/db/index.js');
  const realPool = dbmod.getDB().pool;
  const client = await realPool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '3s'");
  let sp = 0;
  const txDb = {
    get: async (q, p = []) => (await client.query(q, p)).rows[0] || null,
    all: async (q, p = []) => (await client.query(q, p)).rows,
    run: async (q, p = []) => client.query(q, p),
    insert: async (q, p = []) => ({ lastInsertRowid: (await client.query(q.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id', p)).rows[0]?.id || null }),
    withTransaction: async (fn) => { const n = `s${++sp}`; await client.query(`SAVEPOINT ${n}`); try { const r = await fn(client); await client.query(`RELEASE SAVEPOINT ${n}`); return r; } catch (e) { await client.query(`ROLLBACK TO SAVEPOINT ${n}`); throw e; } },
    pool: realPool,
  };
  const logs = [];
  // Stubs BEFORE the routes load: they are destructured at require time.
  dbmod.getDB = () => txDb;
  dbmod.logActivity = async (orderId, jc, type, desc) => { logs.push({ orderId, jc, type, desc }); };
  const wa = require(S + '/src/lib/whatsapp.js');
  wa.queueWhatsApp = async () => {};
  const upload = require(S + '/src/middleware/upload.js');
  upload.uploadToStorage = async (folder, name) => `${folder}/zztest-${name}`;
  upload.deleteFromStorage = async () => {};
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });

  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = owner; next(); };
  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require(S + '/src/routes/inventory.js'));
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  app.use('/api/import', require(S + '/src/routes/import.js'));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const TG = require(S + '/src/lib/terminalGroups.js');
  const T = require(S + '/src/lib/terminals.js');
  const { buildDraft } = require(S + '/src/lib/jobCardDraft.js');
  const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);

  try {
    const col = await q1(`SELECT 1 AS x FROM information_schema.columns WHERE table_name='inventory_items' AND column_name='terminal_group'`);
    if (!col || !owner) { ok('inventory_items.terminal_group exists and an owner user exists', false); return; }

    // ── A. The groups ──
    ok('A1. a group is named by its key or its label, any case',
      TG.normaliseGroup('One Side Threaded') === 'one_side_threaded' && TG.normaliseGroup('no thread') === 'no_thread'
      && TG.normaliseGroup('REGULAR') === 'regular' && TG.normaliseGroup('one_side_threaded') === 'one_side_threaded');
    ok('A2. "plain", blank or anything else is no group (never guessed)',
      TG.normaliseGroup('plain') === null && TG.normaliseGroup('') === null && TG.normaliseGroup(null) === null && TG.normaliseGroup('OT') === null);
    ok('A3. a Terminal Pin item needs its group; any other item has none',
      !!TG.itemGroup('Terminal Pin', '').error && TG.itemGroup(' terminal pin ', 'No Thread').group === 'no_thread'
      && TG.itemGroup('Nut', 'regular').group === null && !TG.itemGroup('Nut', '').error);

    // ── B. Adding and editing an item ──
    let r = await call('POST', '/api/inventory', { item_code: 'ZZT-TG-NEW', name: 'x', unit: 'nos', category: 'Terminal Pin' });
    ok('B1. adding a Terminal Pin with no group is refused', r.status === 400 && r.body.code === 'TERMINAL_GROUP_REQUIRED', JSON.stringify(r.body));
    r = await call('POST', '/api/inventory', { item_code: 'ZZT-TG-NEW', name: 'x', unit: 'nos', category: 'Terminal Pin', terminal_group: 'plain' });
    ok('B2. … and with a group that is not one of the three', r.status === 400 && r.body.code === 'TERMINAL_GROUP_REQUIRED', JSON.stringify(r.body));
    r = await call('POST', '/api/inventory', { item_code: 'ZZT-TG-NEW', name: 'x', unit: 'nos', category: 'Terminal Pin', terminal_group: 'one_side_threaded' });
    ok('B3. with its group it passes the group check (and stops at the drawing rule, as before)', r.status === 400 && r.body.code === 'DRAWING_REQUIRED', JSON.stringify(r.body));
    r = await call('POST', '/api/inventory', { item_code: 'ZZT-TG-NEW', name: 'x', unit: 'nos', category: 'Nut' });
    ok('B4. any other category is not asked', r.status === 400 && r.body.code === 'DRAWING_REQUIRED', JSON.stringify(r.body));

    const mk = async (code, group, s = 100) => (await q1(
      `INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost, terminal_group)
       VALUES ($1,$1,'pcs','Terminal Pin',$2,1,$3) RETURNING id`, [code, s, group])).id;
    const E1 = await mk('TP-SS-M9-09-WH', 'regular');
    const edit = (id, body) => call('PUT', `/api/inventory/${id}`, { item_code: 'TP-SS-M9-09-WH', name: 'x', unit: 'pcs', reorder_level: 0, ...body });
    r = await edit(E1, { category: 'Terminal Pin', terminal_group: '' });
    ok('B5. editing a Terminal Pin to no group is refused', r.status === 400 && r.body.code === 'TERMINAL_GROUP_REQUIRED', JSON.stringify(r.body));
    r = await edit(E1, { category: 'Terminal Pin', terminal_group: 'No Thread' });
    let g = (await q1('SELECT terminal_group FROM inventory_items WHERE id=$1', [E1])).terminal_group;
    ok('B6. editing it to another group is stored', r.status === 200 && g === 'no_thread', `${r.status} ${g}`);
    r = await edit(E1, { category: 'Terminal Pin' });
    g = (await q1('SELECT terminal_group FROM inventory_items WHERE id=$1', [E1])).terminal_group;
    ok('B7. an edit that sends no group keeps the item\'s own', r.status === 200 && g === 'no_thread', `${r.status} ${g}`);
    r = await edit(E1, { category: 'Nut', terminal_group: 'regular' });
    g = (await q1('SELECT terminal_group FROM inventory_items WHERE id=$1', [E1])).terminal_group;
    ok('B8. moved out of Terminal Pin, it has no group', r.status === 200 && g === null, `${r.status} ${g}`);
    r = await edit(E1, { category: 'Terminal Pin' });
    ok('B9. moved back without a group, it is refused', r.status === 400 && r.body.code === 'TERMINAL_GROUP_REQUIRED', JSON.stringify(r.body));

    // ── C. A card picks from its own group only ──
    const R5H = await mk('TP-SS-M9-05-WH', 'regular'), R5O = await mk('TP-SS-M9-05-WO', 'regular');
    const O5H = await mk('TP-SS-M9-05-WH-OT', 'one_side_threaded'), O5O = await mk('TP-SS-M9-05-WO-OT', 'one_side_threaded');
    const N5H = await mk('TP-SS-M9-05-PL-WH', 'no_thread'), N5O = await mk('TP-SS-M9-05-PL-WO', 'no_thread');
    await mk('TP-SS-M9-06-WH', null); await mk('TP-SS-M9-06-WO', null);                     // no group: never picked
    await mk('TP-SS-M9-07-WH-OT', 'one_side_threaded'); await mk('TP-SS-M9-07-WH-OT-B', 'one_side_threaded');   // two fit
    const R35H = await mk('TP-SS-M9-03.5-WH', 'regular'), R35O = await mk('TP-SS-M9-03.5-WO', 'regular');

    const order = (await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction)
      VALUES ('ZZT-TG-1', (SELECT MIN(id) FROM customers), CURRENT_DATE, 'local_he', 'in_progress', FALSE) RETURNING id`)).id;
    const oi = (await q1(`INSERT INTO order_items (order_id, quantity, drawing_number) VALUES ($1, 40, 'ZZT-TG-DWG') RETURNING id`, [order])).id;
    let n = 0;
    const card = async (len, group, qty = 4) => {
      const spec = { input: group === undefined ? {} : { terminalGroup: group },
                     computed: { studLabel: 'M9-SS', terminalPinBig: { studs: len }, terminalPinSmall: { studs: len }, elements: 1 } };
      return q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no, generated_spec)
        VALUES ($1,$2,$3,$4,'in_progress',CURRENT_DATE,'ZZT-TG-DWG',$5) RETURNING *`, [`ZZT-TG-${++n}`, order, oi, qty, JSON.stringify(spec)]);
    };
    const ids = (spec) => spec.rows.map(x => x.inventory_item_id).sort((a, b) => a - b);
    const same = (a, b) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));

    let c = await card(5, undefined);
    let p = await T.cardSpecPins(txDb, c);
    ok('C1. a card made before groups (none stored) takes the Regular pins', same(ids(p), [R5H, R5O]) && p.group === 'regular' && !p.missing.length, JSON.stringify(p));
    c = await card(5, 'one_side_threaded');
    p = await T.cardSpecPins(txDb, c);
    ok('C2. a One Side Threaded card takes the One Side Threaded pins', same(ids(p), [O5H, O5O]) && /One Side Threaded/.test(p.label), JSON.stringify(p));
    c = await card(5, 'no_thread');
    p = await T.cardSpecPins(txDb, c);
    ok('C3. a No Thread card takes the No Thread pins', same(ids(p), [N5H, N5O]), JSON.stringify(p));
    c = await card(3.5, 'regular');
    p = await T.cardSpecPins(txDb, c);
    ok('C4. a 3.5" pin is found at its length', same(ids(p), [R35H, R35O]), JSON.stringify(p));
    c = await card(6, 'regular');
    p = await T.cardSpecPins(txDb, c);
    ok('C5. pins with no group are never picked — named as missing instead',
      !p.rows.length && p.missing.includes('M9 6" With Head (Regular)') && p.missing.includes('M9 6" Without Head (Regular)'), JSON.stringify(p));
    c = await card(6, 'one_side_threaded');
    p = await T.cardSpecPins(txDb, c);
    ok('C6. a group with no pin at that length names it as missing', !p.rows.length && p.missing.includes('M9 6" With Head (One Side Threaded)'), JSON.stringify(p));
    c = await card(7, 'one_side_threaded');
    p = await T.cardSpecPins(txDb, c);
    ok('C7. two pins of one group that both fit are never guessed between', !p.rows.length && p.missing.some(m => /With Head \(One Side Threaded\) — 2 items fit/.test(m)), JSON.stringify(p));

    // ── D. The card's rows, slip and Spot follow its group ──
    c = await card(5, 'one_side_threaded', 4);
    r = await call('GET', `/api/job-cards/${c.id}/terminals`);
    const rowIds = (r.body.rows || []).map(x => x.inventory_item_id);
    ok('D1. the card\'s rows are its group\'s pins × qty, shown with the group, not held',
      r.status === 200 && same(rowIds, [O5H, O5O]) && (r.body.rows || []).every(x => x.qty === 4)
      && r.body.pin_group === 'one_side_threaded' && r.body.pin_group_label === 'One Side Threaded' && r.body.held === false, JSON.stringify(r.body).slice(0, 300));
    const before = { O5H: await stock(O5H), O5O: await stock(O5O), R5H: await stock(R5H), R5O: await stock(R5O) };
    const took = await T.takePinsAtSpot(txDb, c.id, owner.id);
    ok('D2. Spot takes the group\'s pins, and the Regular pins are untouched',
      !!took && await stock(O5H) === before.O5H - 4 && await stock(O5O) === before.O5O - 4
      && await stock(R5H) === before.R5H && await stock(R5O) === before.R5O,
      JSON.stringify({ before, after: { O5H: await stock(O5H), O5O: await stock(O5O), R5H: await stock(R5H) } }));
    c = await card(6, 'one_side_threaded');
    r = await call('GET', `/api/job-cards/${c.id}/terminals`);
    ok('D3. a card whose group has no pin is held, the pin named, for design to choose',
      r.status === 200 && r.body.held === true && (r.body.missing || []).includes('M9 6" With Head (One Side Threaded)'), JSON.stringify(r.body).slice(0, 300));
    const held = logs.filter(l => l.jc === c.id && l.type === 'terminals_short').map(l => l.desc).join(' | ');
    ok('D4. … and the timeline names the pin, never "uploaded job card"', /asks for M9 6" With Head \(One Side Threaded\)/.test(held) && !/uploaded/.test(held), held);
    await client.query(`INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted) VALUES ($1,$2,1,0)`, [oi, E1]);
    r = await call('POST', `/api/job-cards/${c.id}/slip`);
    ok('D5. its slip says which pin is missing, not "uploaded job card"',
      r.status === 409 && /asks for M9 6" With Head \(One Side Threaded\)/.test(r.body.error || '') && !/uploaded/.test(r.body.error || ''), JSON.stringify(r.body));

    // ── E. Make Job Card asks the group and freezes it on the card ──
    const src = await q1(`SELECT oi.* FROM order_items oi JOIN job_cards jc ON jc.order_item_id = oi.id
      WHERE jc.generated_spec IS NOT NULL AND oi.tube_diameter::numeric = 8 AND oi.wattage IS NOT NULL ORDER BY jc.id DESC LIMIT 1`);
    const it = (await q1(`INSERT INTO order_items (order_id, quantity, drawing_number, product_code, tube_material, tube_diameter, wattage, voltage)
      VALUES ($1, 10, 'ZZT-TG-GEN', $2, $3, $4, $5, $6) RETURNING id`, [order, src.product_code, src.tube_material, src.tube_diameter, src.wattage, src.voltage])).id;
    await client.query(`INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted) VALUES ($1,$2,1,0)`, [it, R5H]);
    const ans = { asmbly: '1', fixture: 'test', dispatch_date: '2026-11-30', drawing_total_length_in: 30 };   // 30.7" → a 3" pin each end
    let d = await buildDraft(txDb, it, ans);
    ok('E1. no type chosen: Regular — TP-SS-M4-03-WH + TP-SS-M4-03-WO',
      d.ok && d.terminalGroup === 'regular' && d.pins.big === 'TP-SS-M4-03-WH' && d.pins.small === 'TP-SS-M4-03-WO', JSON.stringify(d.ok ? d.pins : d));
    d = await buildDraft(txDb, it, { ...ans, terminal_group: 'one_side_threaded' });
    ok('E2. One Side Threaded: TP-SS-M4-03-WH-OT + TP-SS-M4-03-WO-OT',
      d.ok && d.pins.big === 'TP-SS-M4-03-WH-OT' && d.pins.small === 'TP-SS-M4-03-WO-OT' && !d.pins.missing.length, JSON.stringify(d.ok ? d.pins : d));
    d = await buildDraft(txDb, it, { ...ans, terminal_group: 'no_thread' });
    ok('E3. No Thread at 3": none in stock\'s list — said up front, the slip will be held',
      d.ok && !d.pins.big && !d.pins.small && d.notes.some(x => /No terminal pin in inventory for M4 3" With Head \(No Thread\) and M4 3" Without Head \(No Thread\)/.test(x)), JSON.stringify(d.ok ? { pins: d.pins, notes: d.notes } : d));
    d = await buildDraft(txDb, it, { ...ans, drawing_total_length_in: 60, terminal_group: 'No Thread' });
    ok('E4. No Thread at 4": TP-SS-M4-04-PL-WH + TP-SS-M4-04-PL-WO',
      d.ok && d.pins.big === 'TP-SS-M4-04-PL-WH' && d.pins.small === 'TP-SS-M4-04-PL-WO', JSON.stringify(d.ok ? d.pins : d));
    d = await buildDraft(txDb, it, { ...ans, terminal_group: 'plain' });
    ok('E5. a type that is not one of the three is refused', !d.ok && /Terminal pin type must be/.test(d.error), JSON.stringify(d));

    const OT3H = (await q1(`SELECT id FROM inventory_items WHERE item_code='TP-SS-M4-03-WH-OT'`)).id;
    const OT3O = (await q1(`SELECT id FROM inventory_items WHERE item_code='TP-SS-M4-03-WO-OT'`)).id;
    r = await call('POST', '/api/job-cards/generate', { order_item_id: it, ...ans, terminal_group: 'one_side_threaded' });
    const made = r.status === 201 ? await q1('SELECT * FROM job_cards WHERE id=$1', [r.body.id]) : null;
    const spec = made ? (typeof made.generated_spec === 'string' ? JSON.parse(made.generated_spec) : made.generated_spec) : null;
    ok('E6. the card made keeps its type frozen in its spec', r.status === 201 && spec?.input?.terminalGroup === 'one_side_threaded', JSON.stringify(r.body).slice(0, 300));
    r = made ? await call('GET', `/api/job-cards/${made.id}/terminals`) : { body: {} };
    ok('E7. … and its rows are the One Side Threaded M4 3" pins × 10',
      same((r.body.rows || []).map(x => x.inventory_item_id), [OT3H, OT3O]) && (r.body.rows || []).every(x => x.qty === 10)
      && r.body.pin_group_label === 'One Side Threaded', JSON.stringify(r.body).slice(0, 300));
    ok('E8. the timeline says which pins the card takes', logs.some(l => /generated by the app .* One Side Threaded terminal pins/.test(l.desc || '')), JSON.stringify(logs.slice(-2)));

    // The printed card names the type beside the stud (owner, 26 Oct 2026: "yes
    // show the pin type on the job card too") — only on a card that stored one.
    const view = async (id) => (await fetch(`${base}/api/job-cards/${id}/view`, { signal: AbortSignal.timeout(30000) })).text();
    const count = (html, s) => html.split(s).length - 1;
    let html = made ? await view(made.id) : '';
    ok('E9. the card prints "One Side Threaded" beside both studs, its Gujarati and Hindi under each',
      count(html, '<b>One Side Threaded</b>') === 2 && count(html, 'એક બાજુ થ્રેડ · एक तरफ थ्रेड') === 2, `${count(html, '<b>One Side Threaded</b>')} / ${count(html, 'એક બાજુ થ્રેડ')}`);
    const copyCard = async (input) => (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no, generated_spec)
      VALUES ($1,$2,$3,1,'in_progress',CURRENT_DATE,'ZZT-TG-GEN',$4) RETURNING id`, [`ZZT-TG-V${++n}`, order, it, JSON.stringify({ ...spec, input })])).id;
    html = await view(await copyCard({ ...spec.input, terminalGroup: 'regular' }));
    ok('E10. a Regular card prints "Regular" (રેગ્યુલર · रेगुलर) beside both studs',
      count(html, '<b>Regular</b>') === 2 && count(html, 'રેગ્યુલર · रेगुलर') === 2, `${count(html, '<b>Regular</b>')}`);
    const { terminalGroup: _drop, ...oldInput } = spec.input;
    html = await view(await copyCard(oldInput));
    ok('E11. a card made before pin types prints no type at all',
      !/<b>(Regular|One Side Threaded|No Thread)<\/b>/.test(html) && !/રેગ્યુલર|એક બાજુ થ્રેડ|થ્રેડ વગર/.test(html) && /Terminal Pin — Big Stud/.test(html), html.length);

    // ── F. An import names the group too ──
    const E2 = await mk('TP-SS-M9-12-WH', 'regular');
    const XLSX = require(S + '/node_modules/xlsx');
    const sheet = XLSX.utils.json_to_sheet([
      { item_code: 'TP-SS-M9-05-WH', name: 'kept', category: 'Terminal Pin', unit: 'pcs', terminal_group: '' },             // keeps Regular
      { item_code: 'TP-SS-M9-05-WH-OT', name: 'moved', category: 'Terminal Pin', unit: 'pcs', terminal_group: 'No Thread' }, // → No Thread
      { item_code: 'TP-SS-M9-09-WH', name: 'refused', category: 'Terminal Pin', unit: 'pcs', terminal_group: '' },          // a Nut now, no group
      { item_code: 'TP-SS-M9-12-WH', name: 'nut', category: 'Nut', unit: 'pcs', terminal_group: '' },                      // out of the category
    ]);
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Items');
    const fd = new FormData();
    fd.append('file', new Blob([XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })]), 'zztest.xlsx');
    const imp = await (await fetch(base + '/api/import/inventory', { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) })).json();
    const grp = async (code) => (await q1('SELECT terminal_group FROM inventory_items WHERE item_code=$1', [code])).terminal_group;
    ok('F1. a row with no group keeps the item\'s own; a row naming one sets it',
      await grp('TP-SS-M9-05-WH') === 'regular' && await grp('TP-SS-M9-05-WH-OT') === 'no_thread', JSON.stringify(imp));
    ok('F2. a Terminal Pin row with no group anywhere is skipped and says why',
      imp.skipped === 1 && (imp.errors || []).some(e => /TP-SS-M9-09-WH — A Terminal Pin item needs its group/.test(e))
      && (await q1('SELECT category FROM inventory_items WHERE id=$1', [E1])).category === 'Nut', JSON.stringify(imp));
    ok('F3. a row moving an item out of Terminal Pin clears its group', await grp('TP-SS-M9-12-WH') === null && imp.imported === 3, JSON.stringify(imp));
  } catch (e) {
    failed = true;
    console.error('ERROR', e);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    server.close();
    await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back)');
    process.exit(failed ? 1 : 0);
  }
})();
