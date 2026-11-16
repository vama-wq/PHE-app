// ── Drawings to make: the drawing agent, in the app (owner, 14 Nov 2026) ──────
// "lets do directly in the app": a page where the owner sees which order items
// need a plain U type drawing, the questions with the likely answers filled in,
// the sheet, and ONE button that puts the approved drawing on the order item
// and makes its job card — so she no longer types the total length or the cold
// zone on Make Job Card.
//
// Phase 1 is the plain U on Ø8 and Ø11. Every answer comes from rules — the
// drawing number, the remark, the tube and the job card engine (uRules.js) —
// so there is no AI call anywhere here.
//   findDue(db)                       which items need a drawing, and why the rest are skipped
//   propose(db, itemId, answers)      the sheet, the questions with their defaults, the card figures
//   approve(db, itemId, {...}, user)  her approval: the drawing on the item + its job card(s), one transaction
//   notifyDrawingsDue(db, orderId)    tells the owner when items on an approved order become drawable
// Only the owner answers and approves (owner, 14 Nov 2026; routes/drawingAgent.js).
const E = require('../jobCardEngine');
const { buildDraft } = require('../jobCardDraft');
const TG = require('../terminalGroups');
const { PINS_RULE } = require('../terminals');
const { isTerminalCategory } = require('../stockLedger');
const { toGujarati, toHindi, isTranslated } = require('../translit');
const U = require('./uTypeSheet');
const R = require('./uRules');
const { uploadToStorage, deleteFromStorage, storageFilename } = require('../../middleware/upload');
const { createNotification } = require('../../routes/notifications');
// The upload, approve and Make Job Card code itself, so a drawing made here
// passes the same checks and leaves the same trail as one made by hand.
const orderRoutes = require('../../routes/orders');
const jobCardRoutes = require('../../routes/jobCards');

// Advisory-lock namespace (first key of pg_advisory_xact_lock(int, int)): one
// approval at a time per order item.
const LOCK_DRAWING_AGENT = 0x44574741;   // 'DWGA'
// Her own SolidWorks U sheets, one row per order item (uWidthHistory.json):
// built once on 14 Nov 2026 from the survey of her 152 U drawings (scratchpad
// survey_uw/rows.json: inside / outside / roller as each sheet prints them,
// the 4" gap sheet of items 23 / 24 as 100 inside) joined to the read-only
// lists, each row's set being this agent's own fitting set for the item.
// Item 6 (its file is an invoice) and item 1926 (Thermolab's PDF reused for
// SHIV) are left out. A snapshot of 14 Nov 2026 — never updated; the sheets
// approved here are added at runtime (agentSheetWidths).
const WIDTH_HISTORY = require('./uWidthHistory.json').rows;
const NOT_OPEN = [...R.CLOSED, 'pending_approval', 'rejected'];
const HEAVY_PIN_REMARK_RE = /heavy[\s\-_.]*terminal[\s\-_.]*pin/i;   // as routes/orders.js

// The shop works in IST; the server's clock is UTC.
const todayIst = () => new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 10);
const fx = (v, d = 2) => (Math.round(Number(v) * 10 ** d) / 10 ** d).toFixed(d);

const MAT = (code) => {
  const s = String(code || '').toUpperCase();
  if (/INC/.test(s)) return 'INCOLOY';
  if (/SS\s*-?316/.test(s)) return 'SS316';
  if (/SS\s*-?310/.test(s)) return 'SS310';
  if (/SS\s*-?304|\bSS\b/.test(s)) return 'SS304';
  if (/\bCU\b|^CU-|COPPER/.test(s)) return 'COPPER';
  return s || '—';
};
const wallFor = (code) => { const m = String(code || '').match(/-T0?(\d)(\d)?\b/i); return m ? Number(`0.${m[1]}${m[2] || ''}`) : 0.6; };
// What each list line is in Detail D, and where the floor fits it.
const roleFor = (code) => {
  const c = String(code || '').toUpperCase();
  if (/^ESB-/.test(c)) return 'esb';
  if (/^NUT-HV-/.test(c)) return 'hvnut';
  if (/^WSH-HV-/.test(c)) return 'hvwasher';
  if (/^TP-HV-/.test(c)) return 'hvpin';
  if (/^NUT-(SS|BR)-/.test(c)) return 'nut';
  if (/^WSH-(SS|BR)-/.test(c)) return 'washer';
  if (/^BKT-/.test(c)) return 'bracket';
  if (/^NIP-BR-.*(-N|-NUT)$/.test(c)) return 'nipnut';
  if (/^NIP-BR-/.test(c)) return 'nipple';
  if (/^IWS-/.test(c)) return 'nipwasher';
  if (/^FIN-/.test(c)) return 'fins';
  if (/^TP-/.test(c)) return 'listpin';
  return 'other';
};
const STAGE_FOR = { listpin: ['St 4 Spot', 'from the list'], esb: ['St 23', 'Sealing'], nipple: ['St 21', 'Nipple Press'], nipnut: ['St 21', 'Nipple Press'], nipwasher: ['St 21', 'Nipple Press'] };
const ORDER_OF = { listpin: 0, nipple: 1, nipwasher: 2, nipnut: 3, bracket: 4, esb: 5, nut: 6, washer: 7, hvpin: 8, hvwasher: 9, hvnut: 10, other: 11, fins: 12 };

// ── Her answers ───────────────────────────────────────────────────────────────
// Only these keys, trimmed; a blank answer means "use the default". `ack:<kind>`
// is her answer to a remark instruction the rules cannot apply.
const ANSWER_KEYS = ['u_length_in', 'inside_mm', 'roller_mm', 'cold_zone_in', 'cold_zone_small_in', 'pin_in', 'pin_small_in',
  'fixture', 'asmbly', 'dispatch_date', 'terminal_group', 'fitting_set', 'nipple', 'nuts', 'note'];

// ── Brass nuts on a two-nut stack ─────────────────────────────────────────────
// Her nut-washer order names SS nuts: "ESB → SS nut → washer → washer → SS nut"
// (owner, 14 Nov 2026). Some lists carry brass nuts instead (2 SS + 2 brass per
// heater on 1403 / 1404 / 283 / 298; brass only on 1907, 2077, 2198…). The
// drawing must show what St 26 will take, and the agent never edits a list, so
// she says which (review, 14 Nov 2026) — until then the sheet cannot be approved.
// → null when the list has no brass nut; else the choices and the nut line
// drawn at each place (from the ESB outward) for her answer.
function nutChoice(lines, qty, answer) {
  const per = (re) => lines.filter(l => re.test(String(l.code || ''))).reduce((a, l) => a + Number(l.qty || 0), 0) / (Number(qty) || 1);
  const br = lines.find(l => /^NUT-BR-/i.test(String(l.code || '')))?.code;
  const ss = lines.find(l => /^NUT-SS-/i.test(String(l.code || '')))?.code;
  if (!br) return ss ? { nuts: [ss, ss], asked: false } : null;
  const toSs = { value: 'ss', label: 'SS nuts at both places, as your order — design changes the list to SS first' };
  const c = { asked: true, brass: br, ss: ss || null, perBrass: R.round(per(/^NUT-BR-/i), 2), perSs: R.round(per(/^NUT-SS-/i), 2) };
  if (!ss) {
    c.options = [{ value: 'brass', label: `Brass nuts at both places, as the list (ESB → brass nut → washer → washer → brass nut)` }, toSs];
    c.nuts = [br, br];
  } else if (c.perBrass === 2 && c.perSs === 2) {
    // One of each on every pin end: which one goes next to the ESB is hers to say.
    c.options = [
      { value: 'brass_inner', label: 'Brass nut next to the ESB, SS nut outside (ESB → brass nut → washer → washer → SS nut)' },
      { value: 'brass_outer', label: 'SS nut next to the ESB, brass nut outside (ESB → SS nut → washer → washer → brass nut)' }, toSs];
    c.nuts = answer === 'brass_inner' ? [br, ss] : answer === 'brass_outer' ? [ss, br] : [ss, ss];
  } else {
    c.options = [];
    c.nuts = [ss, ss];
    c.block = `the list has ${c.perSs} SS and ${c.perBrass} brass nuts per heater — not one of each per pin end; design to fix the list`;
  }
  c.answer = c.options.some(o => o.value === answer) ? answer : null;
  if (c.answer === 'ss') c.block = `you chose SS nuts: design changes the list's brass nut ${br} to SS (Inventory Add), then the sheet can be approved`;
  return c;
}
const nutWord = (code) => (/^NUT-BR-/i.test(String(code || '')) ? 'brass nut' : 'SS nut');
function cleanAnswers(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!(ANSWER_KEYS.includes(k) || /^ack:[a-z /+]{1,40}$/.test(k)) || v == null) continue;
    const s = String(v).replace(/\s+/g, ' ').trim().slice(0, k === 'note' || k.startsWith('ack:') ? 400 : 120);
    if (s) out[k] = s;
  }
  return out;
}

// ── One item, everything the agent reads ──────────────────────────────────────
async function loadItem(db, itemId) {
  const item = await db.get('SELECT * FROM order_items WHERE id=$1', [itemId]);
  if (!item) return null;
  const order = await db.get(`SELECT o.*, o.order_date::text AS order_date_text, o.dispatch_date::text AS dispatch_date_text,
      c.customer_code, c.name AS customer_name
    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id=$1`, [item.order_id]);
  const lines = await db.all(`SELECT oii.id, oii.inventory_item_id, oii.qty, oii.rework_qty, oii.qty_deducted, oii.qty_waived,
      ii.item_code AS code, ii.name, ii.name_gu, TRIM(ii.category) AS category, ii.unit, ii.terminal_group
    FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
    WHERE oii.order_item_id=$1 ORDER BY oii.id`, [itemId]);
  const drawings = await db.all(`SELECT id, drawing_status, original_name, file_name, file_path, created_at
    FROM order_drawings WHERE item_id=$1 ORDER BY id`, [itemId]);
  const orderLevel = await db.all(`SELECT id, drawing_status, original_name, file_name
    FROM order_drawings WHERE order_id=$1 AND item_id IS NULL`, [item.order_id]);
  const cards = await db.all('SELECT id, job_card_no, qty FROM job_cards WHERE order_item_id=$1 ORDER BY id', [itemId]);
  const legacyCards = await db.all(`SELECT id, job_card_no FROM job_cards
    WHERE order_id=$1 AND order_item_id IS NULL AND LOWER(TRIM(drawing_no)) = LOWER(TRIM($2))`, [item.order_id, item.drawing_number || '']);
  // Same normalised number and the same tube Ø on any other item (owner, 14 Nov 2026).
  const key = R.normaliseDwgNo(item.drawing_number);
  const sameNo = (await db.all(`SELECT oi.id, oi.drawing_number, o.order_code,
      EXISTS (SELECT 1 FROM order_drawings d WHERE d.item_id = oi.id AND d.file_path IS NOT NULL) AS filed
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.id <> $1 AND oi.tube_diameter = $2`, [itemId, item.tube_diameter]))
    .filter(r => key && R.normaliseDwgNo(r.drawing_number) === key);
  // The cold zone an earlier app-made card of the same number and Ø was given.
  const sameNoCards = sameNo.length ? await db.all(`SELECT jc.id, jc.job_card_no,
      jc.generated_spec->'computed'->>'coldZoneBigIn' AS cz, jc.generated_spec->'computed'->>'coldZoneSmallIn' AS cz_small
    FROM job_cards jc WHERE jc.order_item_id = ANY($1) AND jc.generated_spec IS NOT NULL ORDER BY jc.created_at DESC`, [sameNo.map(r => r.id)]) : [];
  return {
    item, order, lines, drawings, cards, legacyCards, sameNoCards, key,
    sameFiled: sameNo.filter(r => r.filed).map(r => ({ itemId: r.id, order: r.order_code, dwg: r.drawing_number })),
    orderLevelSame: orderLevel.filter(d => sameOrderLevel(d, key)),
  };
}
// An order-level drawing (no item) whose file name is this drawing number.
const sameOrderLevel = (d, key) => !!key && R.normaliseDwgNo(String(d.original_name || d.file_name || '')
  .replace(/\.[a-z0-9]+$/i, '').replace(/^\d{10,}_/, '')) === key;

// ── Is the item due? ──────────────────────────────────────────────────────────
// Due: an open, approved order (not finished goods, not a replacement, no
// drawing bypass); a plain U on Ø8 or Ø11; no drawing on the item, none for the
// same number + Ø anywhere, none on the order under its number; no job card
// (owner, 14 Nov 2026: "do not make a drawing when the app already has one…
// do not make a job card when the item already has one"). `scope` is set when
// the item is simply out of phase 1.
function verdict(st) {
  const { item, order, lines } = st;
  const reasons = [];
  const sc = R.statusClass(order.status);
  if (sc === 'pending_approval') reasons.push('the order is waiting for approval');
  else if (sc !== 'open') reasons.push(`the order is ${String(order.status).replace(/_/g, ' ')}`);
  if (order.order_type === 'finished_goods') reasons.push('a finished goods order');
  if (order.replacement_query_id || order.replacement_of_order_id) reasons.push('a replacement order');
  if (order.drawing_bypassed) reasons.push('the order\'s drawing bypass is on');
  const label = R.parseULabel(item.drawing_number, item.product_code);
  let scope = null;
  if (!label.ok) scope = `not a plain U the app draws yet — ${label.reason}`;
  else if (!R.PHASE1_DIAMETERS.includes(Number(item.tube_diameter))) scope = `tube Ø${item.tube_diameter ?? '—'} (the app draws Ø8 and Ø11)`;
  else if (R.parseRemark(item.remark).fins || R.listShape(lines.map(l => ({ code: l.code, qty: l.qty })), item.quantity).fins) scope = 'finned heater (phase 2)';
  if (st.drawings.length) {
    const d = st.drawings[st.drawings.length - 1];
    reasons.push(`the item already has a drawing ("${d.original_name || d.file_name || 'no file'}", ${String(d.drawing_status || '').replace(/_/g, ' ')})`);
  }
  if (st.cards.length) reasons.push(`the item already has job card${st.cards.length > 1 ? 's' : ''} ${st.cards.map(c => c.job_card_no).join(', ')}`);
  if (st.legacyCards.length) reasons.push(`the order has job card ${st.legacyCards[0].job_card_no} with this drawing number`);
  if (st.orderLevelSame.length) reasons.push(`the order has a drawing "${st.orderLevelSame[0].original_name || st.orderLevelSame[0].file_name}" for this number`);
  if (st.sameFiled.length) reasons.push(`${st.sameFiled[0].order} item ${st.sameFiled[0].itemId} (${st.sameFiled[0].dwg}) has a drawing with the same number and tube size — use Reuse`);
  return { due: !scope && !reasons.length, scope, reasons, label };
}

// What stops the list going on the drawing as it is: the agent never edits a
// list (design does, with Inventory Add) and never confirms design's check.
function listBlocks(st) {
  const { item, order, lines } = st;
  const b = [];
  if (!lines.length) b.push('no parts list on the item yet — design adds it with Inventory Add, then it can be drawn');
  if (item.bom_review === 'needed') b.push(`design has not confirmed the inventory on ${item.drawing_number || 'this item'} yet (BOM check)`);
  if (item.inventory_deducted || lines.some(l => Number(l.qty_deducted) > 0 || Number(l.qty_waived) > 0)) b.push('stock has already been taken for this item');
  if (lines.length && R.filteredForResend(lines, order.id, PINS_RULE.afterOrderId).length !== lines.length) {
    b.push('the list has a line the drawing upload would drop (quantity 0, or a regular terminal pin — those come from the job card) — design to fix the list');
  }
  const otherSize = R.partsForOtherTube(lines, item.tube_diameter);
  if (otherSize.length) {
    b.push(`the list has parts for a Ø${otherSize[0].sizeMm} tube on this Ø${Number(item.tube_diameter)} tube (${[...new Set(otherSize.map(x => x.code))].join(', ')}) — design to fix the tube or the list`);
  }
  if (HEAVY_PIN_REMARK_RE.test(item.remark || '') && lines.length && !lines.some(l => /^heavy terminal pin$/i.test(String(l.category || '').trim()))) {
    b.push('the remark calls for a Heavy Terminal Pin and the list has none — design to add it');
  }
  if (!(Number(item.quantity) > 0)) b.push('the item has no quantity');
  return b;
}

// ── The queue ─────────────────────────────────────────────────────────────────
// Items on open orders with no drawing of their own. due[]: the ones the app
// can draw now. skipped[]: the rest, each with its reason. Finished goods and
// bypassed orders never need a drawing, so they are not listed at all.
async function findDue(db, { orderId = null } = {}) {
  const rows = await db.all(`SELECT oi.*, o.order_code, o.status, o.order_type, o.drawing_bypassed, o.replacement_query_id,
      o.replacement_of_order_id, o.order_date::text AS order_date_text, c.customer_code,
      (SELECT string_agg(jc.job_card_no, ', ' ORDER BY jc.id) FROM job_cards jc WHERE jc.order_item_id = oi.id) AS card_nos,
      (SELECT string_agg(jc.job_card_no, ', ' ORDER BY jc.id) FROM job_cards jc WHERE jc.order_id = oi.order_id
         AND jc.order_item_id IS NULL AND LOWER(TRIM(jc.drawing_no)) = LOWER(TRIM(oi.drawing_number))) AS legacy_nos
    FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN customers c ON c.id = o.customer_id
    WHERE o.status <> ALL($1::text[]) AND o.order_type IS DISTINCT FROM 'finished_goods' AND NOT COALESCE(o.drawing_bypassed, FALSE)
      AND ($2::int IS NULL OR o.id = $2)
      AND NOT EXISTS (SELECT 1 FROM order_drawings d WHERE d.item_id = oi.id)
    ORDER BY o.order_date NULLS LAST, oi.id`, [NOT_OPEN, orderId ? parseInt(orderId, 10) : null]);
  const due = [], skipped = [];
  if (!rows.length) return { due, skipped, counts: { due: 0, skipped: 0 } };
  const ids = rows.map(r => r.id);
  const lineRows = await db.all(`SELECT oii.order_item_id, oii.id, oii.inventory_item_id, oii.qty, oii.qty_deducted, oii.qty_waived,
      ii.item_code AS code, TRIM(ii.category) AS category
    FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id WHERE oii.order_item_id = ANY($1)`, [ids]);
  const linesOf = new Map();
  for (const l of lineRows) { if (!linesOf.has(l.order_item_id)) linesOf.set(l.order_item_id, []); linesOf.get(l.order_item_id).push(l); }
  // Every filed drawing by normalised number + Ø, and the order-level ones on these orders.
  const filed = new Map();
  for (const r of await db.all(`SELECT oi.id, oi.drawing_number, oi.tube_diameter, o.order_code
      FROM order_drawings d JOIN order_items oi ON oi.id = d.item_id JOIN orders o ON o.id = oi.order_id
      WHERE d.file_path IS NOT NULL ORDER BY d.id`)) {
    const k = `${R.normaliseDwgNo(r.drawing_number)}|${Number(r.tube_diameter)}`;
    if (!filed.has(k)) filed.set(k, { itemId: r.id, order: r.order_code, dwg: r.drawing_number });
  }
  const orderLevel = await db.all('SELECT order_id, original_name, file_name FROM order_drawings WHERE item_id IS NULL AND order_id = ANY($1)',
    [[...new Set(rows.map(r => r.order_id))]]);
  for (const r of rows) {
    const key = R.normaliseDwgNo(r.drawing_number);
    const same = key ? filed.get(`${key}|${Number(r.tube_diameter)}`) : null;
    const st = {
      item: r, order: { id: r.order_id, status: r.status, order_type: r.order_type, drawing_bypassed: r.drawing_bypassed,
        replacement_query_id: r.replacement_query_id, replacement_of_order_id: r.replacement_of_order_id },
      lines: linesOf.get(r.id) || [], drawings: [],
      cards: r.card_nos ? r.card_nos.split(', ').map(no => ({ job_card_no: no })) : [],
      legacyCards: r.legacy_nos ? r.legacy_nos.split(', ').map(no => ({ job_card_no: no })) : [],
      sameFiled: same && same.itemId !== r.id ? [same] : [],
      orderLevelSame: orderLevel.filter(d => d.order_id === r.order_id && sameOrderLevel(d, key)),
    };
    const v = verdict(st);
    const base = { itemId: r.id, orderId: r.order_id, order: r.order_code, customer: r.customer_code || '', dwg: r.drawing_number, qty: Number(r.quantity) };
    if (!v.due) { skipped.push({ ...base, reason: v.scope || v.reasons[0] }); continue; }
    const lb = listBlocks(st);
    if (lb.length) { skipped.push({ ...base, reason: lb[0] }); continue; }
    due.push({ ...base, uIn: v.label.uIn, dia: Number(r.tube_diameter), wattage: Number(r.wattage), voltage: Number(r.voltage),
      tube: r.tube_material, remark: String(r.remark || '').trim(), orderDate: r.order_date_text, orderType: r.order_type });
  }
  return { due, skipped, counts: { due: due.length, skipped: skipped.length } };
}
const dueCount = async (db) => (await findDue(db)).due.length;

// Fitting sets she has confirmed (drawing_rulings), plus the ones she ruled in
// chat. The table is new (14 Nov 2026): until it exists, only her ruled sets.
async function confirmedSets(db) {
  const out = new Set(Object.keys(R.RULED_SETS));
  const t = await db.get("SELECT to_regclass('drawing_rulings') IS NOT NULL AS ok");
  if (!t?.ok) return out;
  for (const r of await db.all("SELECT key, value FROM drawing_rulings WHERE key LIKE 'fitting:%'")) {
    const v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
    if (v && v.confirmed === true) out.add(r.key.slice('fitting:'.length));
  }
  return out;
}

// Her roller list (drawing_rulings 'rollers', saved on the page; owner, 14 Nov
// 2026: "we can make as many roller as per client inner dia requirement").
// Until she saves one, the three rollers on her drawings.
async function rollerList(db) {
  const def = { mm: [...R.DEFAULT_ROLLERS], source: R.DEFAULT_ROLLERS_SOURCE, saved: false, setAt: null, setBy: null };
  const t = await db.get("SELECT to_regclass('drawing_rulings') IS NOT NULL AS ok");
  if (!t?.ok) return def;
  // The day she saved it, in IST (the shop's clock).
  const r = await db.get(`SELECT r.value, r.set_at::text AS set_at, (r.set_at AT TIME ZONE 'Asia/Kolkata')::date::text AS set_on, u.name AS set_by
    FROM drawing_rulings r LEFT JOIN users u ON u.id = r.set_by WHERE r.key = 'rollers'`);
  const v = r && (typeof r.value === 'string' ? JSON.parse(r.value) : r.value);
  const ok = v && R.validateRollers(v.mm);
  if (!ok?.ok) return def;
  const on = String(r.set_on || '');
  return { mm: ok.mm, source: `your list${on ? `, saved ${on.slice(8, 10)}.${on.slice(5, 7)}.${on.slice(0, 4)}` : ''}${r.set_by ? ` by ${r.set_by}` : ''}`, saved: true, setAt: r.set_at, setBy: r.set_by };
}
// Her answer on the page (routes/drawingAgent.js PUT /rollers, owner only).
// A roller choice on a sheet is per order and never stored here.
async function saveRollers(db, raw, user) {
  if (!user || user.role !== 'owner') return { status: 403, body: { error: 'Only the owner sets the rollers.' } };
  const v = R.validateRollers(raw);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const t = await db.get("SELECT to_regclass('drawing_rulings') IS NOT NULL AS ok");
  if (!t?.ok) return { status: 503, body: { error: 'The app is finishing an update — nothing was saved. Try again in a few minutes.', code: 'SCHEMA_NOT_READY' } };
  await db.run(`INSERT INTO drawing_rulings (key, value, set_by, set_at) VALUES ('rollers', $1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, set_by = EXCLUDED.set_by, set_at = NOW()`,
  [JSON.stringify({ mm: v.mm, words: 'Saved on Drawings to make' }), user.id]);
  return { status: 200, body: await rollerList(db) };
}

// The U widths of the sheets approved here, for one customer (the history
// flag, R-g): the frozen sheet's shape, or W − 2Ø on a sheet from before the
// inside gap was a question.
async function agentSheetWidths(db, customerCode) {
  if (!customerCode) return [];
  const t = await db.get(`SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('order_drawings')
    AND attname = 'agent_spec' AND NOT attisdropped) AS ok`);
  if (!t?.ok) return [];
  const rows = await db.all(`SELECT d.item_id, o.order_code, c.customer_code, oi.tube_diameter, oi.drawing_number,
      d.agent_spec->'fitting'->>'set' AS set, d.agent_spec->'sheet'->'shape' AS shape
    FROM order_drawings d JOIN order_items oi ON oi.id = d.item_id JOIN orders o ON o.id = oi.order_id
    JOIN customers c ON c.id = o.customer_id
    WHERE d.agent_spec IS NOT NULL AND d.drawing_status = 'approved' AND c.customer_code = $1`, [customerCode]);
  return rows.map(r => {
    const sh = (typeof r.shape === 'string' ? JSON.parse(r.shape) : r.shape) || {};
    const dia = Number(r.tube_diameter);
    const inside = sh.insideMm != null ? Number(sh.insideMm) : Number(sh.outsideWidthMm) - 2 * dia;
    return { item_id: r.item_id, order_code: r.order_code, customer_code: r.customer_code, dia, set: r.set || null,
      inside: R.round(inside, 2), roller: sh.rollerMm != null ? Number(sh.rollerMm) : null, dwg: r.drawing_number };
  }).filter(r => r.inside > 0);
}

// ── The proposal ──────────────────────────────────────────────────────────────
// Everything she sees on the page for one item: the order as typed, the
// questions with the defaults filled in (and where each came from), what stops
// it, the job card figures (the app's own buildDraft, called with exactly the
// sheet's numbers, so the sheet and the card can never disagree), the sheet,
// and the sheet code her approval is tied to.
async function propose(db, itemId, rawAnswers = {}, { today = todayIst(), approver = null } = {}) {
  const st = await loadItem(db, itemId);
  if (!st) return { ok: false, status: 404, error: 'Order item not found' };
  const answers = cleanAnswers(rawAnswers);
  const { item, order, lines } = st;
  const p = {
    ok: true, itemId: item.id, orderId: order.id, today, answers,
    order: {
      orderCode: order.order_code, orderType: order.order_type, status: order.status, customerCode: order.customer_code || '',
      customerName: order.customer_name || '', orderDate: order.order_date_text, dispatchDate: order.dispatch_date_text || null,
      drawingNumber: item.drawing_number, productCode: item.product_code, qty: Number(item.quantity), wattage: Number(item.wattage),
      voltage: Number(item.voltage), tubeMaterial: item.tube_material, tubeDiameter: Number(item.tube_diameter),
      remark: String(item.remark || '').trim(), plating: item.plating_instructions || '',
    },
    status: null, statusLine: null, reasons: [], blocks: [], flags: [], draftNotes: [], mismatches: [], questions: [],
  };
  p.snapshot = R.itemSnapshot({ order: { ...order, dispatch_date: order.dispatch_date_text }, item, lines,
    drawingCount: st.drawings.length, cardCount: st.cards.length, legacyCardCount: st.legacyCards.length });
  const finish = (status, line) => {
    p.status = status; p.statusLine = line || null;
    p.ready = status === 'ready';
    return p;
  };
  const v = verdict(st);
  if (v.scope) { p.reasons = [v.scope]; return finish('out_of_scope', v.scope); }
  if (!v.due) { p.reasons = v.reasons; return finish('not_due', v.reasons[0]); }
  p.blocks.push(...listBlocks(st));
  // The upload's own list checks (routes/orders.js), on the list as it stands:
  // whatever it would refuse or change, refuses here too.
  if (lines.length && !p.blocks.length) {
    const checked = await orderRoutes.checkDrawingList(db, { orderId: order.id, itemId: item.id, ord: order,
      sels: lines.map(l => ({ id: l.inventory_item_id, qty: Number(l.qty), rework_qty: Number(l.rework_qty) || 0 })) });
    if (checked.status) p.blocks.push(`the drawing upload refuses the list: ${checked.body.error}`);
    else if (checked.sels.length !== lines.length || checked.sels.some((s, i) => Number(s.qty) !== Number(lines[i].qty))) {
      p.blocks.push('the drawing upload would change the list — design to fix the list');
    }
  }

  // Her number answers: a blank one means the default; anything else must be a number above 0.
  const NUM_LABEL = { u_length_in: 'U length', inside_mm: 'Inside gap', cold_zone_in: 'Cold zone (big end)',
    cold_zone_small_in: 'Cold zone (small end)', pin_in: 'Terminal pin (big end)', pin_small_in: 'Terminal pin (small end)' };
  const num = (k) => {
    if (answers[k] == null) return null;
    const n = Number(answers[k]);
    if (!(n > 0) || !Number.isFinite(n)) { p.blocks.push(`${NUM_LABEL[k]} must be a number above 0 (got "${answers[k]}")`); return null; }
    return R.round(n, 2);
  };

  // ── Remark and fitting set ──
  const rem = R.parseRemark(item.remark);
  const lineCodes = lines.map(l => ({ code: l.code, qty: l.qty }));
  const ls = R.listShape(lineCodes, item.quantity);
  const fitRes = R.fittingSetFor(rem, lineCodes, item.quantity);
  const setAnswered = !!(answers.fitting_set && R.SET_LABEL[answers.fitting_set]);
  const set = setAnswered ? answers.fitting_set : fitRes.set;
  const nipple = set && set.startsWith('nipple')
    ? (['M12', 'M16'].includes(answers.nipple) ? answers.nipple
      : fitRes.nipple && fitRes.nipple !== 'unknown' ? fitRes.nipple
        : (rem.nipple && rem.nipple !== 'unknown' ? rem.nipple : ls.nippleSize))
    : null;
  p.mismatches = fitRes.notes;
  const confirmedSet = await confirmedSets(db);
  const confirmed = !!set && confirmedSet.has(set);
  // A set with two nut places (nut washer, + brackets, + nipple): which nut line
  // is at each, and whether she must say so because the list has brass.
  const twoNuts = (U.FITTING_SETS[set]?.pin || []).filter(rl => rl === 'nut').length === 2;
  const nutC = twoNuts ? nutChoice(lines, item.quantity, answers.nuts) : null;
  if (nutC?.block) p.blocks.push(nutC.block);

  // ── Shape: the client's inside gap, the roller, the total length ──
  // (owner, 14 Nov 2026: "clients inner dia is more important"). The inside is
  // her answer → the remark → the drawing number → the Ø standard (27); the
  // roller makes it (inside − 2 mm opening, ±2 mm on the inside if she
  // accepts, else a new roller); the sheet is drawn with the inside that roller
  // MAKES, outside = made inside + 2 × Ø.
  const d = Number(item.tube_diameter);
  const std = R.SHAPE_STANDARD[d];
  const uAns = num('u_length_in');
  const uIn = uAns || v.label.uIn;
  const uLabel = uAns && uAns !== v.label.uIn ? `${uIn}U` : v.label.label;
  const insideSrc = R.insideDefault({ answerMm: num('inside_mm'), remarkGap: rem.gap, dwgGap: R.readDwgGap(item.drawing_number), diaMm: d });
  const insChk = R.insideChecks({ insideMm: insideSrc.mm, diaMm: d });
  p.blocks.push(...insChk.blocks);
  p.flags.push(...insChk.flags);
  // A gap the U cannot have is refused above; the sheet is still drawn, at the standard.
  const clientInside = insChk.blocks.length ? std.insideMm : insideSrc.mm;
  const rollers = await rollerList(db);
  const pick = R.pickRoller({ insideMm: clientInside, rollers: rollers.mm });
  const rollerAns = answers.roller_mm;
  const rollerChosen = rollerAns != null ? pick.options.find(o => Math.abs(Number(o.value) - Number(rollerAns)) < 0.005) || null : null;
  if (rollerAns != null && !rollerChosen) p.blocks.push(`Roller must be one of ${pick.options.map(o => o.value).join(', ')} mm (got "${rollerAns}")`);
  const rollerOpt = rollerChosen || pick.options.find(o => o.mm === pick.suggestMm) || pick.options[0];
  const roller = rollerOpt.mm, rollerIsNew = rollerOpt.isNew;
  const madeInside = rollerOpt.madeInsideMm;
  const W = R.round(madeInside + 2 * d, 2);
  // The client's inside, kept only when the roller makes another one.
  const clientInsideMm = Math.abs(madeInside - clientInside) > 0.01 ? clientInside : null;
  if (rollerIsNew) p.flags.push(`New roller ${R.trimNum(roller)} mm to make before bending — not in your roller list`);
  const TL = R.totalLength({ uIn, diaMm: d, outsideWidthMm: W });
  const geo = TL.geo;
  const totalForCard = TL.num + E.TOTAL_LENGTH_ALLOWANCE_IN;

  // Cold zone: remark → earlier app card (same number and Ø) → standard; her answer wins.
  const earlier = st.sameNoCards.find(c => c.cz != null);
  let cz = R.coldZoneDefault({ rem, earlierCard: earlier ? { big: earlier.cz, small: earlier.cz_small, no: earlier.job_card_no } : null,
    totalLengthIn: totalForCard, diaMm: d, standardColdZone: E.standardColdZone });
  const czBigAns = num('cold_zone_in'), czSmallAns = num('cold_zone_small_in');
  if (czBigAns != null || czSmallAns != null) {
    cz = { big: czBigAns ?? cz.big, small: czSmallAns ?? czBigAns ?? cz.small, source: 'your answer', override: true };
  }
  // Pin: the engine's from the cold zone, or cold zone + 1" when the remark asks
  // a stud outside; her answer wins (and is sent as an override only when it
  // differs from the engine's).
  const material = E.materialClass(item.tube_material) || 'steel';
  const enginePin = E.terminalPin(cz.big, d, material).studs;
  const engineSmallPin = E.terminalPin(cz.small, d, material).studs;
  let pin = R.pinDefault({ rem, set, coldZone: cz, enginePin });
  const pinBigAns = num('pin_in'), pinSmallAns = num('pin_small_in');
  if (pinBigAns != null || pinSmallAns != null) {
    const big = pinBigAns ?? pin.big;
    const small = pinSmallAns ?? pinBigAns ?? (pin.small ?? engineSmallPin);
    pin = big === enginePin && small === engineSmallPin
      ? { big, small, override: false, source: 'the job card engine (from the cold zone)' }
      : { big, small, override: true, source: 'your answer' };
  }
  const fixture = answers.fixture || R.fixtureText(set, rem, nipple, lineCodes);
  const asmbly = ['1', '2', '3'].includes(answers.asmbly) ? answers.asmbly : R.asmblyDefault(set);
  const disp = answers.dispatch_date
    ? { date: answers.dispatch_date, weekday: R.isIsoDate(answers.dispatch_date) ? R.weekday(answers.dispatch_date) : '', source: 'your answer' }
    : R.dispatchDefault({ orderDispatchDate: order.dispatch_date_text, orderType: order.order_type, todayIso: today });
  if (!R.isIsoDate(disp.date)) p.blocks.push(`the dispatch date "${disp.date}" is not a date`);
  const group = answers.terminal_group ? TG.normaliseGroup(answers.terminal_group) : TG.DEFAULT_GROUP;
  if (!group) p.blocks.push(`Terminal pin type must be ${TG.GROUP_CHOICES}.`);

  // The exact body the Make Job Card form posts (every value a string), with
  // the total length and the cold zones from the sheet.
  p.body = {
    order_item_id: String(item.id), asmbly: String(asmbly), fixture: String(fixture || ''), dispatch_date: disp.date,
    drawing_total_length_in: TL.str, terminal_group: group || TG.DEFAULT_GROUP,
    cold_zone_big_in: String(cz.big), cold_zone_small_in: String(cz.small),
    terminal_pin_big_in: pin.override ? String(pin.big) : '', terminal_pin_small_in: pin.override ? String(pin.small ?? pin.big) : '',
    punching: '', notes: '',
  };

  // ── The questions: blocking ones first, then the defaults she may change ──
  const q = (o) => p.questions.push({ required: false, answered: answers[o.key] != null, ...o });
  for (const ins of rem.instructions) {
    // Words no rule reads (uRules 'other'): quoted, so nothing in a remark is passed over.
    const other = ins.kind === 'other';
    q({ key: `ack:${ins.kind}`, type: 'textarea', required: true, label: other ? 'Remark: other words' : `Remark: ${ins.kind}`, value: answers[`ack:${ins.kind}`] || '',
      text: other
        ? `The remark "${p.order.remark}" has words no rule reads: "${ins.text}". Say what the drawing or the job card should do about them ("nothing" if they are not for the drawing; change a figure below if it needs one); your answer is printed on the sheet.`
        : `The remark says "${ins.text}". The rules cannot apply that — say what the drawing should do (change a figure below if it needs one); your answer is printed on the sheet.`,
      source: 'the remark' });
  }
  const setOptions = Object.entries(R.SET_LABEL).map(([value, label]) => ({ value, label }));
  q({ key: 'fitting_set', type: 'select', options: setOptions, required: !set, label: 'Fittings', value: set || '',
    source: setAnswered ? 'your answer' : fitRes.set ? `the ${fitRes.from === 'remark' ? 'remark' : 'parts list'}` : 'neither the remark nor the list names one — choose it' });
  if (set && set.startsWith('nipple')) {
    q({ key: 'nipple', type: 'select', options: ['M12', 'M16'].map(x => ({ value: x, label: x })), required: !nipple, label: 'Nipple size',
      value: nipple || '', source: answers.nipple ? 'your answer' : nipple ? 'the remark / list' : 'not in the remark or the list — choose it' });
  }
  if (nutC?.asked && nutC.options.length) {
    q({ key: 'nuts', type: 'select', options: nutC.options, required: true, answered: !!nutC.answer, label: 'Nuts (the list has brass)', value: nutC.answer || '',
      text: `Your nut-washer order names SS nuts; the list has ${nutC.ss ? `${nutC.perSs} SS (${nutC.ss}) and ` : ''}${nutC.perBrass} brass (${nutC.brass}) per heater. Say which the drawing shows — St 26 takes what the list says.`,
      source: nutC.answer ? 'your answer' : 'the parts list has brass — choose it' });
  }
  q({ key: 'u_length_in', type: 'number', label: 'U length (in)', value: String(uIn),
    source: uAns ? 'your answer' : `the drawing number ("${v.label.label}" = ${v.label.uIn}" from the end of the tube to the far end of the U)` });
  q({ key: 'inside_mm', type: 'number', label: 'Inside gap (mm) — the client\'s', value: R.trimNum(insideSrc.mm), source: insideSrc.source });
  // The roller (R-d): one that makes the client's inside is filled in; else she
  // picks — the closest she has within ±2 mm, or a new one. Per order, never remembered.
  const rollerWords = `your rollers ${pick.rollers.map(R.trimNum).join(', ')} mm (${rollers.source})`;
  const ci = R.trimNum(clientInside);
  q({ key: 'roller_mm', type: 'select', label: 'Roller (mm)', options: pick.options.map(o => ({ value: o.value, label: o.label })),
    required: pick.kind !== 'exact', value: rollerChosen ? rollerChosen.value : pick.kind === 'exact' ? R.trimNum(pick.suggestMm) : '',
    ...(pick.kind === 'exact' ? {} : { suggest: R.trimNum(pick.suggestMm), suggestLabel: pick.kind === 'new' ? `Use ${R.trimNum(pick.suggestMm)} — new roller` : `Use ${R.trimNum(pick.suggestMm)}` }),
    text: pick.kind === 'suggest'
      ? `Suggested: roller ${R.trimNum(pick.suggestMm)} — the closest you have within ±2 mm (gives ${R.trimNum(pick.suggestMm + R.OPENING_MM)} inside; the client's is ${ci}). Or a new ${R.trimNum(Math.round(pick.idealMm))} mm roller for ${R.trimNum(Math.round(pick.idealMm) + R.OPENING_MM)} inside.`
      : pick.kind === 'new' ? `No roller you have is within ±2 mm of ${ci} inside — a new ${R.trimNum(pick.suggestMm)} mm roller is needed.` : undefined,
    source: rollerChosen ? `your answer · ${rollerWords}` : pick.kind === 'exact' ? `roller ${R.trimNum(pick.suggestMm)} + ${R.OPENING_MM} mm opening = the client's ${ci} inside · ${rollerWords}` : rollerWords });
  q({ key: 'cold_zone_in', type: 'number', label: 'Cold zone, big end (in)', value: String(cz.big), source: cz.source });
  q({ key: 'cold_zone_small_in', type: 'number', label: 'Cold zone, small end (in)', value: String(cz.small), source: cz.source });
  q({ key: 'pin_in', type: 'number', label: 'Terminal pin, big end (in)', value: String(pin.big), source: pin.source });
  q({ key: 'pin_small_in', type: 'number', label: 'Terminal pin, small end (in)', value: String(pin.small ?? engineSmallPin), source: pin.source });
  q({ key: 'fixture', type: 'text', required: !fixture, label: 'Fixture', value: fixture || '',
    source: answers.fixture ? 'your answer' : fixture ? `the ${fitRes.from === 'list' && !setAnswered ? 'parts list' : 'fittings'} in house wording` : 'no fittings named — type it' });
  q({ key: 'asmbly', type: 'select', options: ['1', '2', '3'].map(x => ({ value: x, label: `ASMBLY ${x}` })), label: 'ASMBLY', value: String(asmbly),
    source: answers.asmbly ? 'your answer' : '2 with a nipple, else 1' });
  q({ key: 'dispatch_date', type: 'date', label: 'Dispatch date', value: disp.date, help: disp.weekday, source: disp.source });
  q({ key: 'terminal_group', type: 'select', options: TG.TERMINAL_GROUPS.map(g => ({ value: g.key, label: g.label })), label: 'Terminal pin type',
    value: group || TG.DEFAULT_GROUP, source: answers.terminal_group ? 'your answer' : 'Regular unless you choose' });
  q({ key: 'note', type: 'textarea', label: 'Note on the sheet (optional)', value: answers.note || '', source: '' });

  // ── The card, from the app's own draft ──
  const draft = await buildDraft(db, item.id, p.body.fixture ? p.body : { ...p.body, fixture: '?' });
  if (!draft.ok) { p.blocks.push(`the job card engine refuses it: ${draft.error}`); return finish('blocked', p.blocks[0]); }
  const card = draft.card;
  if (card.gauge == null) p.blocks.push('no wire on the gauge sheet reaches this coil length — make this card by hand on the order');
  p.draftNotes = [...(card.warnings || []), ...(draft.notes || [])];
  const stud = String(card.studLabel || '').match(/M\d+/i)?.[0]?.toUpperCase() || (d === 11 ? 'M5' : 'M4');
  p.figures = {
    totalLengthIn: TL.str, cardTotalIn: card.totalLengthIn, cuttingLengthIn: card.cuttingLengthIn, cuttingLengthMm: card.cuttingLengthMm,
    gauge: card.gauge, coldZoneBigIn: card.coldZoneBigIn, coldZoneSmallIn: card.coldZoneSmallIn,
    pinBig: card.terminalPinBig.studs, pinSmall: card.terminalPinSmall.studs, pinOverridden: !!card.terminalPinBig.overridden, stud,
    ohms: card.ohmsAfterDraw, ohmsMin: card.ohmsAfterDrawMin, ohmsMax: card.ohmsAfterDrawMax,
    tubeDrawPct: card.tubeDrawPct, wireDrawPct: card.wireDrawPct, doubleCoil: !!card.doubleCoil,
    quantities: draft.split.quantities, names: draft.split.names,
    pins: { big: draft.pins?.big || null, small: draft.pins?.small || null, missing: draft.pins?.missing || [], groupLabel: draft.pins?.groupLabel || null },
    drawnULengthMm: R.round(TL.drawnULengthMm, 1), uLabel, totalFormula: TL.formula,
    insideMm: madeInside, outsideWidthMm: W, rollerMm: roller, rollerKind: pick.kind, rollerIsNew, clientInsideMm,
  };

  // ── Shape checks ──
  const chk = R.shapeChecks({ geo, outsideWidthMm: W, drawnULengthMm: TL.drawnULengthMm, czBigIn: card.coldZoneBigIn,
    czSmallIn: card.coldZoneSmallIn, diaMm: d, wattsPerElement: card.wattage });
  p.blocks.push(...chk.blocks);
  p.flags.push(...chk.flags);
  if (draft.pins?.missing?.length) p.flags.push(`no terminal pin in inventory for ${draft.pins.missing.join(' and ')} — the card's slip waits until design chooses the pin`);
  if (set && set.includes('ceramic')) p.flags.push('the ceramic is not an inventory item — Detail D shows it without a part number');
  if (fitRes.notes.length) p.flags.push(...fitRes.notes.map(nt => `list vs remark: ${nt}`));
  // The customer's earlier U widths for this Ø and set: a flag only (R-g).
  const histFlag = R.widthHistoryFlag({ rows: [...WIDTH_HISTORY, ...(await agentSheetWidths(db, order.customer_code))],
    customerCode: order.customer_code, diaMm: d, set, itemId: item.id, madeInsideMm: madeInside, insideFrom: insideSrc.from });
  if (histFlag) p.flags.push(histFlag);

  // ── Parts: the stages' material by the card, then the item's list unchanged ──
  const codes = [`SPR-KD-${card.gauge}`, draft.pins?.big, draft.pins?.small, d === 11 ? 'PVC-FB11-M5' : 'PVC-FB08-M4', 'MGO-65A', item.tube_material].filter(Boolean);
  const inv = Object.fromEntries((await db.all('SELECT item_code, name, name_gu FROM inventory_items WHERE upper(item_code) = ANY($1)',
    [codes.map(c => String(c).toUpperCase())])).map(r => [r.item_code.toUpperCase(), r]));
  // The Gujarati follows the English name, as the job card does; the stored
  // name_gu only when the shop dictionary cannot translate it.
  const tri = (code, fallbackName, nameGu) => {
    const r = inv[String(code || '').toUpperCase()] || null;
    const name = String(r?.name || fallbackName || code).replace(/\s+/g, ' ').replace(/W\/0/, 'W/O').trim();
    const tg = toGujarati(name); const gu = isTranslated(name, tg) ? tg : (r?.name_gu || nameGu || ''); const hi = toHindi(name);
    return { line1: `${code} · ${name}`, gu, hi: isTranslated(name, hi) ? hi : '' };
  };
  const q0 = Number(item.quantity);
  // An order on the old pin rule (up to ORD-160-26) keeps the list's pins and
  // its job card adds none (lib/terminals.js), so the sheet shows the list's.
  const listPins = Number(order.id) <= PINS_RULE.afterOrderId ? lines.filter(l => isTerminalCategory(l.category)) : [];
  const pinsFromList = listPins.length > 0;
  const shownGroup = pinsFromList ? (TG.normaliseGroup(listPins[0].terminal_group) || group) : group;
  const pinCode = (end) => draft.pins?.[end] || `TP-SS-${stud}-${String(end === 'big' ? card.terminalPinBig.studs : card.terminalPinSmall.studs).padStart(2, '0')}-${end === 'big' ? 'WH' : 'WO'}`;
  const ftPc = card.cuttingLengthMm / 304.8;
  const mgoKgPc = (card.cuttingLengthIn / 5) * 0.018;            // MgO 18 g per 5" of cut tube
  const fbush = d === 11 ? 'PVC-FB11-M5' : 'PVC-FB08-M4';
  const parts = [
    { key: 'coil', role: 'coil', code: `SPR-KD-${card.gauge}`, stage: ['St 1 Coil', '(weighed St 3)'], ...tri(`SPR-KD-${card.gauge}`), perPc: '1 coil', forOrder: `${q0} coils` },
    ...(pinsFromList ? [] : [{ key: 'pinwh', role: 'pinwh', code: pinCode('big'), stage: ['St 4 Spot', 'big end'], ...tri(pinCode('big'), draft.pins?.big ? null : 'no item in inventory'), perPc: '1', forOrder: String(q0) },
      { key: 'pinwo', role: 'pinwo', code: pinCode('small'), stage: ['St 4 Spot', 'small end'], ...tri(pinCode('small'), draft.pins?.small ? null : 'no item in inventory'), perPc: '1', forOrder: String(q0) }]),
    { key: 'tube', role: 'tube', code: item.tube_material, stage: ['St 5', 'Tube cutting'], ...tri(item.tube_material), perPc: [`${fx(ftPc)} ft`, `${fx(card.cuttingLengthMm, 1)} mm`], forOrder: `${fx(ftPc * q0, 1)} ft` },
    { key: 'fbush', role: 'fbush', code: fbush, stage: ['St 6', 'Filling'], ...tri(fbush), perPc: '2', forOrder: String(2 * q0) },
    { key: 'mgo', role: 'mgo', code: 'MGO-65A', stage: ['St 6', 'Filling'], ...tri('MGO-65A'), perPc: `${Math.round(mgoKgPc * 1000)} g`, forOrder: `${fx(mgoKgPc * q0)} kg` },
    ...[...lines].sort((a, b) => (ORDER_OF[roleFor(a.code)] ?? 99) - (ORDER_OF[roleFor(b.code)] ?? 99)).map(l => {
      const role = roleFor(l.code);
      const per = Number(l.qty) / (q0 || 1);
      return { key: role, role, code: l.code, stage: STAGE_FOR[role] || ['St 26', 'Nut Washer'], ...tri(l.code, l.name, l.name_gu),
        perPc: Number.isInteger(per) ? String(per) : fx(per, 2), forOrder: String(Number(l.qty)) };
    }),
  ].map((x, i) => ({ ...x, no: i + 1 }));
  p.parts = parts.map(x => ({ no: x.no, code: x.code, line: x.line1, stage: Array.isArray(x.stage) ? x.stage.join(' ') : x.stage,
    perPc: Array.isArray(x.perPc) ? x.perPc.join(' · ') : x.perPc, forOrder: x.forOrder, fromList: !['coil', 'pinwh', 'pinwo', 'tube', 'fbush', 'mgo'].includes(x.role) }));

  // Detail D for this set, from the list where it says more than the set's default.
  const FS = U.FITTING_SETS[set] || { pin: [], tube: [] };
  let pinRoles = [...FS.pin], tubeRoles = [...FS.tube];
  if (set === 'heavy_pin' && ls.nut > 0) pinRoles = ['nut', ...pinRoles];
  if (set === 'nipple' && lines.length) {
    const w = Math.min(2, Math.round(ls.nipwasher / 2));
    tubeRoles = ['nipple', ...Array(w).fill('nipwasher'), ...(ls.nipnut > 0 ? ['nipnut'] : [])];
  }
  // `order` is the set's fitting order (what she confirms once per set);
  // `stack` is this sheet's, with each nut named as the line drawn there.
  const stack = [...(R.FITTING_ORDER[set] || [])];
  if (nutC?.nuts) { let k = 0; stack.forEach((s, i) => { if (s === 'SS nut') stack[i] = nutWord(nutC.nuts[k++]); }); }
  p.fitting = { set: set || null, label: R.SET_LABEL[set] || '—', confirmed, nipple: nipple || null, pin: pinRoles, tube: tubeRoles,
    order: R.FITTING_ORDER[set] || [], stack, nuts: nutC?.nuts || null, nutsAnswer: nutC?.answer || null, ruled: !!R.RULED_SETS[set] };

  // ── The sheet ──
  const shape = { uLabel, uLengthIn: uIn, uLengthMm: TL.drawnULengthMm, nominalULengthMm: TL.nominalULengthMm, outsideWidthMm: W, insideMm: madeInside,
    rollerMm: roller, rollerIsNew, clientInsideMm, insideSource: insideSrc.short };
  const ctx = { st, p, card, geo, TL, uIn, uLabel, shape, insideSrc, rollerAnswered: !!rollerChosen, std, d, cz, pin, fixture, stud, parts, group, shownGroup, pinsFromList, rem, inv, approver, today };
  const preview = U.renderUTypeSheet(buildSheetSpec(ctx, { production: false, confirmed }));
  p.html = preview.html;
  // Her approval covers the order item as she saw it, her answers, and exactly
  // what would be written: the production sheet and the job card body.
  // (The approver's name in the title block is left out: it is whoever presses approve.)
  const production = buildSheetSpec(ctx, { production: true, confirmed: true });
  // A note cut off at the box edge would be lost on the floor: refused instead.
  if (!preview.notesFit || !U.renderUTypeSheet(production).notesFit) {
    p.blocks.push('the notes do not fit on the sheet even in the smallest letters — shorten your answers or the note');
  }
  const sheetForCode = { ...production, tb: { ...production.tb, approved: null } };
  p.sheetCode = R.sheetCode({ snapshot: p.snapshot, answers, spec: { body: p.body, figures: p.figures, sheet: sheetForCode } });
  Object.defineProperty(p, 'production', { value: production, enumerable: false });

  const open = p.questions.filter(x => x.required && !x.answered);
  if (p.blocks.length) return finish('blocked', p.blocks[0]);
  if (open.length) return finish('needs_answer', `answer ${open.map(x => x.label).join(', ')}`);
  return finish('ready', `${item.drawing_number}: total length ${TL.str}" (${TL.formula}), cold zone ${card.coldZoneBigIn}" / ${card.coldZoneSmallIn}", ${card.gauge} SWG`);
}

// The sheet's content (uTypeSheet.renderUTypeSheet lays it out). The preview
// says FOR APPROVAL; the production copy — the one stored on the order item —
// FOR PRODUCTION, with the fitting order no longer TO CONFIRM once she approved it.
function buildSheetSpec(c, { production, confirmed }) {
  const { st, p, card, geo, TL, uIn, uLabel, shape, insideSrc, rollerAnswered, std, d, cz, pin, fixture, stud, parts, group, shownGroup, pinsFromList, rem, inv, approver, today } = c;
  const { item, order } = st;
  const q0 = Number(item.quantity);
  const matShort = MAT(item.tube_material);
  const tubeName = inv[String(item.tube_material || '').toUpperCase()]?.name || item.tube_material;
  const fixUp = String(fixture || '').toUpperCase();
  const fitOrder = p.fitting.stack;
  const brassByAnswer = !!p.fitting.nutsAnswer && p.fitting.nutsAnswer !== 'ss';
  const heatedMm = geo.clMm - (card.coldZoneBigIn + card.coldZoneSmallIn) * 25.4;
  const heatedIn = heatedMm / 25.4;
  const load = card.wattage / (Math.PI * (d / 10) * (heatedMm / 10));
  const nominalMm = TL.nominalULengthMm, drawnMm = TL.drawnULengthMm;
  const czShort = cz.source.startsWith('the remark') ? 'from the remark' : cz.source.startsWith('the earlier') ? 'as the earlier card' : cz.source === 'your answer' ? 'Ms. Vama' : `the Ø${d} standard`;
  const tbDate = `${today.slice(8, 10)}.${today.slice(5, 7)}.${today.slice(0, 4)}`;
  // The shape, with where the inside came from (R-a … R-e).
  const t2 = R.trimNum;
  const rollerTxt = `roller ${t2(shape.rollerMm)}${shape.rollerIsNew ? ' NEW' : ''}`;
  const clientTxt = shape.clientInsideMm != null
    ? ` Client's inside ${t2(shape.clientInsideMm)} (${insideSrc.note}); ${shape.rollerIsNew ? 'new roller' : 'roller'} ${t2(shape.rollerMm)} gives ${t2(shape.insideMm)} — within ±${R.ROLLER_TOL_MM} mm, ${rollerAnswered ? 'accepted by Ms. Vama' : 'to be accepted by Ms. Vama'}.`
    : '';
  const shapeNote = `Shape: ${t2(shape.insideMm)} inside${shape.clientInsideMm != null ? '' : ` (${insideSrc.note})`} / ${t2(shape.outsideWidthMm)} outside / roller ${t2(shape.rollerMm)}${shape.rollerIsNew ? ' NEW — to make before bending' : ''}, + ${R.OPENING_MM} mm opening after bending.${clientTxt}`;
  const totalNote = TL.extraIn === 0
    ? `TOTAL LENGTH ${TL.str}" = ${TL.formula} (Ms. Vama, 14 Nov 2026)`
    : `TOTAL LENGTH ${TL.str}" = ${TL.formula} for the ${TL.extraIn > 0 ? 'wider' : 'narrower'} bend (${t2(shape.insideMm)} inside vs the standard ${std.insideMm})`;
  // Her answer to each remark instruction this remark has (an answer left over
  // from an earlier remark is not hers for this one, and is not printed).
  const instrNotes = [...new Map(rem.instructions.map(ins => [ins.kind, ins])).values()]
    .filter(ins => p.answers[`ack:${ins.kind}`])
    .map(ins => (ins.kind === 'other' ? `Remark, the words "${ins.text}": ${p.answers['ack:other']}` : `Remark (${ins.kind}): ${p.answers[`ack:${ins.kind}`]}`));
  return {
    banner: `U TYPE HEATER  |  ${card.statedWattage} W, ${card.voltage} V AC  |  ${matShort} Ø${d}  |  ${q0} NOS  |  ${order.order_code} · ${order.customer_code || ''}  |  ${card.coldZoneBigIn}" COLD ZONE · ${fixUp}`,
    title: `U TYPE HEATER — ${card.statedWattage} W / ${card.voltage} V`,
    subtitle: `${matShort === 'INCOLOY' ? 'Incoloy' : matShort} Ø${d} · ${uLabel} · ${card.coldZoneBigIn}" cold zone · ${String(fixture || '').toLowerCase()}`,
    terminalNote: `${stud} SS PIN ${card.terminalPinBig.studs}" + ${fixUp}${confirmed ? '' : ' — TO CONFIRM'}`,
    item: { drawingNumber: item.drawing_number, qty: q0, finish: item.plating_instructions || '' },
    tube: { code: item.tube_material, diaMm: d, wallMm: wallFor(item.tube_material), material: matShort === 'INCOLOY' ? 'Incoloy' : matShort === 'COPPER' ? 'Copper' : matShort,
      label: `${String(tubeName || '').toUpperCase()}, DRAWN TO Ø${d}` },
    shape,
    geo,
    r1: { mode: '2u', totalLengthStr: TL.str, formula: TL.formula, extraIn: TL.extraIn },
    fitting: { ...p.fitting, confirmed },
    card: {
      totalLengthIn: card.totalLengthIn, cuttingLengthIn: card.cuttingLengthIn, cuttingLengthMm: card.cuttingLengthMm,
      coldZoneBigIn: card.coldZoneBigIn, coldZoneSmallIn: card.coldZoneSmallIn, pinStudsIn: card.terminalPinBig.studs, studLabel: stud,
      gauge: card.gauge, wireDiaMm: card.wire?.dia_mm, mandrelMm: card.wire?.mandrel_mm, wireCode: `SPR-KD-${card.gauge}`, heatedMm,
      rows: [
        ['Rating', `${card.statedWattage} W${card.elements > 1 ? ` (${card.elements} elements)` : ''}`],
        ['Supply', `${card.voltage} V AC, 1-ph · ${fx(card.statedWattage / card.voltage)} A`],
        ['Resistance, finished', `${fx(card.ohmsAfterDraw)} Ω ± 5% (${fx(card.ohmsAfterDrawMin)} – ${fx(card.ohmsAfterDrawMax)})`],
        ['Coil ohms at St 3', card.ohmsRangeMid != null ? `${fx(card.ohmsRangeMin, 1)} – ${fx(card.ohmsRangeMid, 1)} – ${fx(card.ohmsRangeMax, 1)} Ω` : '—'],
        ['Coil', `${card.gauge} SWG FeCrAl on ${card.wire?.mandrel_mm} mm mandrel · spring ${fx(card.springWindowLowIn)} – ${fx(card.springWindowHighIn)}"${card.doubleCoil ? ' · DOUBLE COIL' : ''}`],
        ['Sheath', `${tubeName}, drawn to Ø${d}`],
        ['Shape', `${t2(shape.insideMm)} inside (${shape.clientInsideMm != null ? `client ${t2(shape.clientInsideMm)}` : insideSrc.short.replace(/^the /, '')}) · ${t2(shape.outsideWidthMm)} outside · legs ${t2(geo.cc)} c/c · R${fx(geo.rCL, 1)} CL · ${rollerTxt}`],
        [`U length "${uLabel}"`, `${fx(drawnMm, 1)} end to end, as it comes out of a ${TL.extraIn === 0 ? '2U' : `${TL.str}"`} tube`],
        ['Total length', `${TL.str}" (${fx(geo.clMm, 1)} mm) = ${TL.formula}`],
        ['Job card', `+0.7" = ${fx(card.totalLengthIn)}" · cut ${fx(card.cuttingLengthIn)}" (${fx(card.cuttingLengthMm, 1)} mm) · draw ${Math.round(card.tubeDrawPct * 1000) / 10}%`],
        ['Cold zone', `${card.coldZoneBigIn}" (${fx(card.coldZoneBigIn * 25.4, 1)}) ${card.coldZoneSmallIn === card.coldZoneBigIn ? 'each leg' : `big / ${card.coldZoneSmallIn}" small`} — ${czShort}`],
        ['Heated length', `≈ ${fx(heatedMm, 1)} mm (${fx(heatedIn)}")`],
        ['Surface load', `≈ ${fx(load, 1)} W/cm² · ${fx(card.wattage / heatedIn, 1)} W per inch`],
        ['Terminal pins', `${stud} SS ${card.terminalPinBig.studs}" (${TG.groupLabel(shownGroup) || 'Regular'}): ${card.terminalPinBig.studs - 1}" in + 1" out${pinsFromList ? ' · from the list' : ''}`],
        ['Finish', `${item.plating_instructions || '—'} (plating instruction)`],
      ],
    },
    parts,
    notes: [
      'All dimensions in mm; inches marked ". Do not scale. Tolerances as the title block; resistance ± 5%.',
      `The order as typed: ${order.order_code} · ${order.customer_code || ''} · ${item.drawing_number} · ${q0} Nos · ${card.statedWattage} W ${card.voltage} V · ${item.tube_material} · remark "${p.order.remark}" · ${item.plating_instructions || '—'}.`,
      `${shapeNote} ${totalNote}; the U is drawn as it comes out of that tube — ${fx(drawnMm, 1)} mm end to end, ${fx(nominalMm - drawnMm, 1)} mm short of ${fx(nominalMm, 1)}.`,
      `Cold zone ${card.coldZoneBigIn}"${card.coldZoneSmallIn !== card.coldZoneBigIn ? ` / ${card.coldZoneSmallIn}"` : ''} from ${cz.source === 'your answer' ? 'Ms. Vama' : cz.source}; pins ${card.terminalPinBig.studs}" from ${pin.source === 'your answer' ? 'Ms. Vama' : pin.source}. The job card adds 0.7" and works out the cut, coil, wire length and spring from the spool picked on the machine.`,
      `Parts: lines ${parts.filter(x => !['coil', 'pinwh', 'pinwo', 'tube', 'fbush', 'mgo'].includes(x.role)).map(x => x.no).join(', ') || '—'} are the item's list in the app, unchanged; lines 1–${parts.filter(x => ['coil', 'pinwh', 'pinwo', 'tube', 'fbush', 'mgo'].includes(x.role)).length} are what the stages take by the job card.${p.fitting.set && p.fitting.set.includes('ceramic') ? ' The ceramic is not an inventory item.' : ''}`,
      ...(p.mismatches.length ? [`List vs remark: ${p.mismatches.join('; ')}.`] : []),
      `${fitOrder.length ? `Terminal end, from the tube: ${fitOrder.join(', ')}.` : 'Terminal end: as Detail D.'}${confirmed ? (p.fitting.ruled ? ' (Ms. Vama, 14 Nov 2026.)' : ' (confirmed by Ms. Vama.)') : ' Fitting order TO CONFIRM by Ms. Vama before production.'}${brassByAnswer ? ` ${p.fitting.nuts.every(c => /^NUT-BR-/i.test(c)) ? 'Brass nuts' : 'Brass nut'} as the item's list — Ms. Vama's answer on this sheet.` : ''}`,
      ...instrNotes,
      ...(p.answers.note ? [p.answers.note] : []),
      'Every heater: HV + light check, megger (IR) and resistance before dispatch.',
    ],
    tb: {
      status: production ? 'FOR PRODUCTION — APPROVED BY OWNER' : 'FOR APPROVAL', material: matShort, wattVolt: `${card.statedWattage} W · ${card.voltage} V`, qty: `${q0} NOS`,
      client: order.customer_code || '', product: item.product_code || '', dwgNo: item.drawing_number, rev: '00', date: tbDate, order: order.order_code,
      drawn: 'PHE APP (DRAWING AGENT)', checked: '—', approved: production ? String(approver?.name || 'OWNER').toUpperCase() : 'OWNER (ON APPROVAL)',
    },
  };
}

// ── Her approval ──────────────────────────────────────────────────────────────
// One transaction: re-work the proposal under a lock and refuse unless it is
// still the sheet she saw (same sheet code) and still due; then store the
// production sheet in 'order-drawings', put the drawing on the item through the
// app's own upload + approve code (approved, with its frozen spec), and make
// the job card(s) through the app's own Make Job Card code with the sheet's
// total length (2U; on a non-standard inside, 2U + the bend's difference — R-e)
// and her cold zones, pins, fixture, ASMBLY and dispatch date.
// Anything that fails rolls all of it back, and the stored files are removed.
// A second approval finds the drawing and is refused.
function refusal(status, body) { return Object.assign(new Error(body.error), { refusal: { status, body } }); }

// The figures a made card froze that must equal the sheet's.
function figureDiffs(fig, cards) {
  const out = [];
  if (JSON.stringify(cards.map(c => c.qty)) !== JSON.stringify(fig.quantities)) out.push(`cards ${fig.quantities.join('/')} → ${cards.map(c => c.qty).join('/')}`);
  for (const c of cards) {
    const spec = typeof c.generated_spec === 'string' ? JSON.parse(c.generated_spec) : c.generated_spec;
    const k = spec?.computed || {};
    const pairs = [['total length', spec?.input?.drawingTotalLengthIn, fig.totalLengthIn], ['cut', k.cuttingLengthIn, fig.cuttingLengthIn],
      ['gauge', k.gauge, fig.gauge], ['cold zone big', k.coldZoneBigIn, fig.coldZoneBigIn], ['cold zone small', k.coldZoneSmallIn, fig.coldZoneSmallIn],
      ['pin big', k.terminalPinBig?.studs, fig.pinBig], ['pin small', k.terminalPinSmall?.studs, fig.pinSmall]];
    for (const [label, got, want] of pairs) if (String(got) !== String(want)) out.push(`${c.job_card_no} ${label} ${want} → ${got}`);
  }
  return out;
}

// The app's db shape over one client inside a transaction; withTransaction is a
// savepoint, so the job card code's own transaction nests inside this one.
function clientTx(client, pool) {
  let sp = 0;
  return {
    get: async (q, prm = []) => (await client.query(q, prm)).rows[0] || null,
    all: async (q, prm = []) => (await client.query(q, prm)).rows,
    run: (q, prm = []) => client.query(q, prm),
    insert: async (q, prm = []) => ({ lastInsertRowid: (await client.query(`${q.trimEnd().replace(/;?\s*$/, '')} RETURNING id`, prm)).rows[0]?.id || null }),
    withTransaction: async (fn) => {
      const n = `dwg_agent_${++sp}`;
      await client.query(`SAVEPOINT ${n}`);
      try { const r = await fn(client); await client.query(`RELEASE SAVEPOINT ${n}`); return r; } catch (e) { await client.query(`ROLLBACK TO SAVEPOINT ${n}`); throw e; }
    },
    pool,
  };
}

// The two schema additions this needs (initDB, 14 Nov 2026): order_drawings.
// agent_spec and the drawing_rulings table. Checked before an approval so that
// one made in the minutes before the main session adds them gets a plain answer
// instead of a failed write (as lib/stockLedger.js ledgerColumnsReady does).
// Looked up through the search path, as the writes themselves are.
let schemaReady = false;
let schemaCheckedAt = 0;
async function agentSchemaReady(db) {
  if (schemaReady) return true;
  if (Date.now() - schemaCheckedAt < 30e3) return false;
  schemaCheckedAt = Date.now();
  try {
    const r = await db.get(`SELECT to_regclass('drawing_rulings') IS NOT NULL AS rulings,
      EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('order_drawings') AND attname = 'agent_spec' AND NOT attisdropped) AS spec`);
    schemaReady = !!(r?.rulings && r?.spec);
  } catch (_) { schemaReady = false; }
  return schemaReady;
}

async function approve(db, itemId, { answers = {}, sheetCode, fittingConfirmed = false, fittingConfirmedSet = null, seenSnapshot = null } = {}, user) {
  if (!user || user.role !== 'owner') return { status: 403, body: { error: 'Only the owner approves drawings.' } };
  const id = parseInt(itemId, 10);
  if (!(id > 0)) return { status: 400, body: { error: 'No order item was given.' } };
  if (!/^[0-9a-f]{6}-[0-9a-f]{6}-[0-9a-f]{6}$/.test(String(sheetCode || ''))) return { status: 400, body: { error: 'The sheet code is missing — open the drawing again.' } };
  if (!(await agentSchemaReady(db))) {
    return { status: 503, body: { error: 'The app is finishing an update — nothing was saved. Try again in a few minutes.', code: 'SCHEMA_NOT_READY' } };
  }
  const today = todayIst();
  const written = [];          // storage paths, removed again if nothing is kept
  try {
    return await db.withTransaction(async (client) => {
      const t = clientTx(client, db.pool);
      await t.run("SET LOCAL lock_timeout = '5s'");
      await t.run("SET LOCAL statement_timeout = '60s'");
      // One approval at a time per item: a double click waits here, then finds the drawing made.
      await t.run('SELECT pg_advisory_xact_lock($1::int, $2::int)', [LOCK_DRAWING_AGENT, id]);
      if (!(await t.get('SELECT id FROM order_items WHERE id=$1 FOR UPDATE', [id]))) throw refusal(404, { error: 'Order item not found' });
      const p = await propose(t, id, answers, { today, approver: user });
      if (!p.ok) throw refusal(p.status || 400, { error: p.error });
      if (p.status === 'not_due' || p.status === 'out_of_scope') {
        throw refusal(409, { error: `Nothing done — ${p.statusLine}.`, code: 'NOT_DUE', reasons: p.reasons });
      }
      // Blocked before a sheet could be drawn (the engine refused it): say why.
      if (!p.sheetCode) throw refusal(400, { error: p.blocks[0] || 'This item cannot be drawn.', code: 'BLOCKED', blocks: p.blocks });
      if (p.sheetCode !== String(sheetCode)) {
        const changed = R.codeChanges(sheetCode, p.sheetCode);
        const fields = seenSnapshot && typeof seenSnapshot === 'object' ? R.snapshotDiff(seenSnapshot, p.snapshot) : [];
        throw refusal(409, { error: `Nothing done — ${changed.join(' and ')} changed since this sheet was shown${fields.length ? ` (${fields.join(', ')})` : ''}. Check the new sheet and approve it again.`,
          code: 'SHEET_CHANGED', changed, fields, sheetCode: p.sheetCode });
      }
      if (p.blocks.length) throw refusal(400, { error: p.blocks[0], code: 'BLOCKED', blocks: p.blocks });
      const open = p.questions.filter(x => x.required && !x.answered);
      if (open.length) throw refusal(400, { error: `Answer first: ${open.map(x => x.label).join(', ')}.`, code: 'NEEDS_ANSWER' });
      // Her tick counts only for the set it was given for: ticked for one set,
      // then the Fittings answer switched to another, is not a confirmation of
      // the other (review, 14 Nov 2026).
      if (!p.fitting.confirmed && !(fittingConfirmed === true && fittingConfirmedSet === p.fitting.set)) {
        throw refusal(400, { error: `Confirm the fitting order first: ${p.fitting.stack.join(' → ')}.`, code: 'FITTING_CONFIRM_REQUIRED' });
      }
      // Timeline entries go in with everything else, or not at all.
      const log = (orderId, jobCardId, type, description, userId) => t.run(
        'INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1, $2, $3, $4, $5)',
        [orderId || null, jobCardId || null, type, description, userId]);
      // The first approval of a set's fitting order is her confirmation of it:
      // later sheets for that set no longer print TO CONFIRM.
      if (!p.fitting.confirmed) {
        await t.run(`INSERT INTO drawing_rulings (key, value, set_by, set_at) VALUES ($1, $2, $3, NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, set_by = EXCLUDED.set_by, set_at = NOW()`,
          [`fitting:${p.fitting.set}`, JSON.stringify({ confirmed: true, label: p.fitting.label, order: p.fitting.order, stack: p.fitting.stack,
            words: 'Confirmed on Drawings to make, with the approval of this drawing', item_id: id, order_code: p.order.orderCode }), user.id]);
        await log(p.orderId, null, 'drawing_ruling', `Fitting order confirmed for "${p.fitting.label}": ${p.fitting.stack.join(' → ')}`, user.id);
      }

      // The production sheet, stored like an uploaded drawing and named after the drawing number.
      const html = U.renderUTypeSheet(p.production).html;
      const originalname = `${String(p.order.drawingNumber || `item-${id}`).trim()}.html`;
      const filename = storageFilename(originalname);
      const storagePath = await uploadToStorage('order-drawings', filename, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
      written.push(storagePath);
      const notes = `Drawn in the app (Drawings to make) and approved by ${user.name || 'the owner'} on ${today} — sheet ${p.sheetCode}. Total length ${p.figures.totalLengthIn}" = ${p.figures.totalFormula}; ${R.trimNum(p.figures.insideMm)} inside, roller ${R.trimNum(p.figures.rollerMm)}${p.figures.rollerIsNew ? ' (NEW)' : ''}.`;
      const drawingId = await orderRoutes.recordOrderDrawing(t, { orderId: p.orderId, itemId: id, file: { storagePath, filename, originalname }, notes, userId: user.id, log });
      const approvedAt = new Date().toISOString();
      await t.run('UPDATE order_drawings SET agent_spec = $1 WHERE id = $2', [JSON.stringify({
        v: 1, sheetCode: p.sheetCode, approvedAt, approvedBy: { id: user.id, name: user.name || null },
        answers: p.answers, body: p.body, figures: p.figures, fitting: { ...p.fitting, confirmed: true }, snapshot: p.snapshot, sheet: p.production,
      }), drawingId]);
      const drawing = await t.get('SELECT * FROM order_drawings WHERE id=$1', [drawingId]);
      const refused = await orderRoutes.approveOrderDrawing(t, { orderId: p.orderId, drawing, userId: user.id, log });
      if (refused) throw refusal(refused.status, refused.body);

      // The job card(s), exactly as Make Job Card makes them.
      const g = await jobCardRoutes.generateJobCard(t, { body: p.body, user, log });
      if (g.body?.file_path) written.push(g.body.file_path);
      if (g.status !== 201) throw refusal(g.status, { ...g.body, error: `The job card could not be made, so nothing was saved: ${g.body?.error || g.status}` });
      const cards = await t.all('SELECT id, job_card_no, qty, generated_spec FROM job_cards WHERE order_item_id=$1 ORDER BY id', [id]);
      const diffs = figureDiffs(p.figures, cards);
      if (diffs.length) throw refusal(500, { error: `The job card does not match the sheet (${diffs.join('; ')}) — nothing was saved.` });
      return { status: 201, body: {
        ok: true, itemId: id, orderId: p.orderId, orderCode: p.order.orderCode, drawingNumber: p.order.drawingNumber, sheetCode: p.sheetCode,
        drawing: { id: drawingId, file_path: storagePath, file_name: filename, original_name: originalname },
        cards: cards.map(c => ({ id: c.id, job_card_no: c.job_card_no, qty: c.qty })),
      } };
    });
  } catch (e) {
    for (const path of written) await deleteFromStorage(path);
    if (e.refusal) return e.refusal;
    if (e.code === '55P03' || e.code === '57014') return { status: 503, body: { error: 'The app is busy with this item — try again in a moment.' } };
    throw e;
  }
}

// ── Telling the owner ─────────────────────────────────────────────────────────
// When items on an approved order become drawable: at the order's approval
// (services/actions/orders.js — in the app and on WhatsApp alike), and when
// design saves an item's list or confirms its BOM (routes/orders.js), which is
// when a new item usually does — at approval it rarely has a list yet (review,
// 14 Nov 2026). `itemIds` limits it to those items. Each item is told once:
// the notice links to its item(s) (?item= / ?items=), and an item an owner was
// already told about is left out. Every caller is failure-safe.
const itemsInLink = (link) => {
  const m = String(link || '').match(/[?&]items?=([\d,]+)/);
  return m ? m[1].split(',').map(Number).filter(n => n > 0) : [];
};
async function notifyDrawingsDue(db, orderId, actor, { itemIds = null } = {}) {
  let { due } = await findDue(db, { orderId });
  if (itemIds) { const want = new Set(itemIds.map(Number)); due = due.filter(x => want.has(x.itemId)); }
  if (!due.length) return 0;
  let sent = 0;
  for (const u of await db.all("SELECT id FROM users WHERE role='owner'")) {
    const told = new Set((await db.all("SELECT link FROM notifications WHERE user_id=$1 AND type='drawing_ready' AND link LIKE '/drawings-to-make?item%'", [u.id]))
      .flatMap(r => itemsInLink(r.link)));
    const fresh = due.filter(x => !told.has(x.itemId));
    if (!fresh.length) continue;
    const n = fresh.length;
    await createNotification(db, {
      userId: u.id, type: 'drawing_ready', sourceUserId: actor?.id || null,
      link: n === 1 ? `/drawings-to-make?item=${fresh[0].itemId}` : `/drawings-to-make?items=${fresh.map(x => x.itemId).join(',')}`,
      title: `${n} U type drawing${n > 1 ? 's' : ''} ready to check on ${fresh[0].order}`,
      body: `${fresh.map(x => x.dwg).join(', ')} — the app has worked out the sheet${n > 1 ? 's' : ''} and the job card figures; check the answers and approve.`,
    });
    sent++;
  }
  return sent ? due.length : 0;
}

module.exports = { findDue, dueCount, propose, approve, notifyDrawingsDue, cleanAnswers, verdict, listBlocks, loadItem, rollerList, saveRollers, LOCK_DRAWING_AGENT };
