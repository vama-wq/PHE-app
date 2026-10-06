// Owner actions on a CAPA report, shared by the dashboard routes
// (routes/capa.js) and the WhatsApp reply dispatcher.
//
// Contract: fn(db, params) with params.actor = { id, name, role } and
// params.via = 'app' | 'whatsapp'. Returns { ok:true, summary, data } or
// { ok:false, code, message } — never throws for an expected condition.
//
// "First one wins": the state change is a conditional UPDATE on
// status='awaiting_approval', so a dashboard click and a WhatsApp reply that
// land together cannot both approve (or approve and send back) — the second
// gets 'already_done' with the state the first one left.
const dbmod = require('../../db');
const { createNotification } = require('../../routes/notifications');

const viaTag = (via) => (via === 'whatsapp' ? ' (via WhatsApp)' : '');

// Activity-log writes go through the module at call time (not a destructured
// copy) so the log stays pluggable, exactly like the routes' own writes.
const logActivity = (...args) => dbmod.logActivity(...args);

// The pg client inside db.withTransaction only has query(); give it the same
// get/all/run shape the rest of the code expects.
function clientDb(client) {
  return {
    get: async (sql, params = []) => (await client.query(sql, params)).rows[0] || null,
    all: async (sql, params = []) => (await client.query(sql, params)).rows,
    run: (sql, params = []) => client.query(sql, params),
  };
}

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "30 Sep 2026" in factory (IST) time.
function fmtDate(d) {
  if (!d) return '';
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Asia/Kolkata',
    }).formatToParts(new Date(d)).map(x => [x.type, x.value]));
    return `${parts.day} ${MONTHS[Number(parts.month) - 1]} ${parts.year}`;
  } catch { return ''; }
}

// Appends one entry to the stored conversation in SQL, so a message posted at
// the same moment is never overwritten by a stale copy of the array.
const APPEND_CONVERSATION =
  "(CASE WHEN jsonb_typeof(conversation)='array' THEN conversation ELSE '[]'::jsonb END) || ";

async function loadCapa(db, id) {
  return db.get(`
    SELECT c.*, jc.job_card_no, ua.name AS approved_by_name, uw.name AS waived_by_name
      FROM capa_reports c
      LEFT JOIN job_cards jc ON jc.id = c.job_card_id
      LEFT JOIN users ua ON ua.id = c.approved_by
      LEFT JOIN users uw ON uw.id = c.waived_by
     WHERE c.id=$1`, [id]);
}

function cardLabel(capa) {
  return `job card ${capa.job_card_no || `#${capa.job_card_id}`} (CAPA #${capa.id})`;
}

// Plain-English "it is no longer waiting — here is where it stands now".
function notWaitingMessage(capa) {
  const what = `The CAPA report for ${cardLabel(capa)}`;
  if (capa.status === 'approved') {
    const by = capa.approved_by_name ? ` by ${capa.approved_by_name}` : '';
    const on = capa.approved_at ? ` on ${fmtDate(capa.approved_at)}` : '';
    return `${what} is already approved${by}${on} — work on the card is unlocked.`;
  }
  if (capa.status === 'waived') {
    const by = capa.waived_by_name ? ` by ${capa.waived_by_name}` : '';
    return `${what} was already waived${by} — no report is needed and work is unlocked.`;
  }
  if (capa.status === 'open') {
    if (capa.reopen_note) {
      const conv = Array.isArray(capa.conversation) ? capa.conversation : [];
      const sent = [...conv].reverse().find(m => typeof m?.text === 'string' && m.text.startsWith('[Owner sent the report back]'));
      const by = sent?.by ? ` by ${sent.by}` : '';
      return `${what} was already sent back to the team${by} — they are reworking it, so it is not waiting for approval.`;
    }
    return `${what} is still being written by the team — it is not ready for approval yet.`;
  }
  return `${what} is not waiting for approval (it is ${capa.status}).`;
}

async function alreadyDone(db, id) {
  const now = await loadCapa(db, id);
  if (!now) return { ok: false, code: 'not_found', message: `CAPA #${id} was not found — it may have been deleted.` };
  return { ok: false, code: 'already_done', message: notWaitingMessage(now), data: { status: now.status } };
}

// Lift the rejection lock (the on-hold status the trigger set). Query-CAPAs
// don't hold the card — the repair-start endpoint checks CAPA state itself.
// A rejection CAPA holds every card of the item, not just the one that tripped
// it, so closing it has to release them together — otherwise the siblings stay
// stopped with nothing on screen to explain why. Shared by approve and waive.
// Runs inside the caller's transaction (q = get/all/run on that client) and
// returns the released cards; log them with logReleased AFTER the commit.
// A card goes back to where the hold found it: a card that had already
// finished its last stage was waiting for QC, not in production (owner,
// 7 Oct 2026 — two cards showed "In Progress" on the QC list after a release).
async function releaseRejectionHold(q, capa, jc) {
  if (capa.trigger_type !== 'rejections') return [];
  return q.all(
    `UPDATE job_cards SET status = CASE WHEN EXISTS (
          SELECT 1 FROM production_checklist pc
           WHERE pc.job_card_id = job_cards.id AND pc.done = 1
             AND pc.stage_no = CASE WHEN job_cards.is_fg THEN 4 ELSE 29 END)
        THEN 'qc_pending' ELSE 'in_progress' END
      WHERE status='on_hold'
        AND (id = $1 OR (order_item_id IS NOT NULL AND order_item_id = $2))
      RETURNING id, job_card_no`,
    [capa.job_card_id, jc?.order_item_id || null]);
}

async function logReleased(released, capa, jc, userId, verb, via = 'app') {
  for (const c of released.filter(c => c.id !== capa.job_card_id)) {
    await logActivity(jc?.order_id, c.id, 'status_changed',
      `Job card ${c.job_card_no} released — CAPA on ${jc?.job_card_no || 'a sibling card'} ${verb}${viaTag(via)}`, userId);
  }
}

// ── Owner approves — unlocks the job card (and its held siblings) ────────────
async function approveCapa(db, { capaId, actor, via = 'app' } = {}) {
  if (!actor || actor.role !== 'owner') {
    return { ok: false, code: 'forbidden', message: 'Only the owner can approve a CAPA report.' };
  }
  const id = toId(capaId);
  if (!id) return { ok: false, code: 'not_found', message: `CAPA #${capaId} was not found.` };

  const capa = await loadCapa(db, id);
  if (!capa) return { ok: false, code: 'not_found', message: `CAPA #${id} was not found — it may have been deleted.` };
  if (capa.status !== 'awaiting_approval') {
    return { ok: false, code: 'already_done', message: notWaitingMessage(capa), data: { status: capa.status } };
  }

  const res = await db.withTransaction(async (client) => {
    const q = clientDb(client);
    const won = await q.get(
      `UPDATE capa_reports SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
        WHERE id=$2 AND status='awaiting_approval'
        RETURNING *`,
      [actor.id, id]);
    if (!won) return null; // someone else acted first
    const jc = await q.get('SELECT * FROM job_cards WHERE id=$1', [won.job_card_id]);
    const released = await releaseRejectionHold(q, won, jc);
    return { capa: won, jc, released };
  });
  if (!res) return alreadyDone(db, id);

  const { capa: done, jc, released } = res;
  await logReleased(released, done, jc, actor.id, 'approved', via);

  if (done.created_by) {
    await createNotification(db, {
      userId: done.created_by, type: 'capa_approved',
      title: `CAPA approved — ${jc?.job_card_no || ''}`,
      body: 'Work can continue on the job card.',
      link: `/capa/${done.id}`, sourceUserId: actor.id,
    });
  }
  await logActivity(done.order_id, done.job_card_id, 'capa_approved',
    `CAPA on ${jc?.job_card_no || `card #${done.job_card_id}`} approved — work unlocked${viaTag(via)}`, actor.id);

  const siblings = released.filter(c => c.id !== done.job_card_id);
  const also = siblings.length
    ? `, along with ${siblings.length} other card${siblings.length === 1 ? '' : 's'} of the same item`
    : '';
  return {
    ok: true,
    summary: `Approved the CAPA report for job card ${jc?.job_card_no || `#${done.job_card_id}`} (CAPA #${done.id}) — work on the card is unlocked${also}.`,
    data: {
      capaId: done.id, jobCardId: done.job_card_id, jobCardNo: jc?.job_card_no || null,
      releasedJobCards: released.map(c => c.job_card_no),
    },
  };
}

// ── Owner sends it back to the team for more work ────────────────────────────
async function sendBackCapa(db, { capaId, actor, note, via = 'app' } = {}) {
  if (!actor || actor.role !== 'owner') {
    return { ok: false, code: 'forbidden', message: 'Only the owner can send a CAPA report back.' };
  }
  const text = String(note ?? '').trim();
  if (!text) return { ok: false, code: 'invalid', message: 'Tell the team what is missing.' };
  const id = toId(capaId);
  if (!id) return { ok: false, code: 'not_found', message: `CAPA #${capaId} was not found.` };

  const capa = await loadCapa(db, id);
  if (!capa) return { ok: false, code: 'not_found', message: `CAPA #${id} was not found — it may have been deleted.` };
  if (capa.status !== 'awaiting_approval') {
    return { ok: false, code: 'already_done', message: notWaitingMessage(capa), data: { status: capa.status } };
  }

  const entry = {
    role: 'user', text: `[Owner sent the report back]: ${text}${viaTag(via)}`,
    by: actor.name, at: new Date().toISOString(),
  };
  const won = await db.get(
    `UPDATE capa_reports SET status='open', reopen_note=$1,
            conversation=${APPEND_CONVERSATION}$2::jsonb, updated_at=NOW()
      WHERE id=$3 AND status='awaiting_approval'
      RETURNING id, created_by`,
    [text, JSON.stringify([entry]), id]);
  if (!won) return alreadyDone(db, id);

  if (won.created_by) {
    await createNotification(db, {
      userId: won.created_by, type: 'capa_reopened',
      title: 'CAPA sent back by owner',
      body: text, link: `/capa/${won.id}`, sourceUserId: actor.id,
    });
  }
  return {
    ok: true,
    summary: `Sent the CAPA report for ${cardLabel(capa)} back to the team with your note.`,
    data: { capaId: won.id, jobCardId: capa.job_card_id, jobCardNo: capa.job_card_no || null },
  };
}

module.exports = {
  approveCapa,
  sendBackCapa,
  // Helpers for the waive route (not owner actions in their own right).
  releaseRejectionHold,
  logReleased,
  clientDb,
  APPEND_CONVERSATION,
};
