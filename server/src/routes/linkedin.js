const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

// LinkedIn connections (owner, 16 Nov 2026): "make an agent that tells me which connection requests i need to send
// with the connection notes easily available to copy, then also check who accepted and who do i need to send thank you
// notes to, also finds new connections ... as daily updated app, ... the relevant groups i need to join ... posts for
// that group ... ideas on how further increase connections organically".
// The LinkedIn agent fills the li_* tables every evening (read-only on LinkedIn). The owner does every LinkedIn action
// herself: Connect, thank-you notes, joining groups, posting. This page only shows the work and keeps her ticks.
const SALES = ['owner', 'admin', 'accounts'];
const DAILY = 15;          // invitations a day (LinkedIn flags accounts that send many unanswered invites)
const WEEKLY_CAP = 80;     // LinkedIn allows roughly 100 a week; stop well before it
const POST_STATUSES = ['ready', 'posted', 'skip'];
const GROUP_STATUSES = ['suggested', 'requested', 'joined', 'skip'];
const KEY = /^[a-z0-9_-]{1,80}$/i;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });   // YYYY-MM-DD in IST

const PERSON_COLS = `p.id, p.slug, p.profile_url, p.person, p.title, p.company, p.place, p.list_name, p.phase,
  p.plan_date::text AS plan_date, p.note, p.use_note, p.why, p.message, p.company_page, p.sent_at, p.sent_how,
  p.pending_seen::text AS pending_seen, p.accepted_on::text AS accepted_on, p.thanked_at, p.skipped_at, p.skip_reason,
  p.check_note, p.source, p.added_at`;

/** Everything the page shows, in one call. */
router.get('/', authenticate, authorize(...SALES), async (req, res) => {
  const db = getDB();
  const day = today();
  const [stats] = await db.all(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
      COUNT(*) FILTER (WHERE sent_at IS NOT NULL AND accepted_on IS NULL)::int AS pending,
      COUNT(*) FILTER (WHERE accepted_on IS NOT NULL)::int AS accepted,
      COUNT(*) FILTER (WHERE thanked_at IS NOT NULL)::int AS thanked,
      COUNT(*) FILTER (WHERE sent_at IS NULL AND skipped_at IS NULL AND accepted_on IS NULL)::int AS unsent_left,
      COUNT(*) FILTER (WHERE sent_at IS NULL AND skipped_at IS NULL AND accepted_on IS NULL AND (plan_date IS NULL OR plan_date <= $1::date))::int AS due_now,
      COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '7 days' AND sent_how = 'app')::int AS sent_7d,
      COUNT(*) FILTER (WHERE (sent_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date AND sent_how = 'app')::int AS sent_today,
      COUNT(*) FILTER (WHERE added_at >= NOW() - INTERVAL '1 day' AND source = 'agent')::int AS added_today
    FROM li_people`, [day]);
  const room = Math.max(0, Math.min(DAILY - stats.sent_today, WEEKLY_CAP - stats.sent_7d));
  // Today's invitations: overdue first (phase order, then planned day), never people whose phase starts later
  // (Gulf / Vietnam rows are planned for January).
  const send = room ? await db.all(`SELECT ${PERSON_COLS} FROM li_people p
      WHERE p.sent_at IS NULL AND p.skipped_at IS NULL AND p.accepted_on IS NULL AND (p.plan_date IS NULL OR p.plan_date <= $1::date)
      ORDER BY p.use_note DESC, p.phase_order, p.plan_date NULLS LAST, p.id LIMIT $2`, [day, room]) : [];
  const sentToday = await db.all(`SELECT ${PERSON_COLS} FROM li_people p
      WHERE (p.sent_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date AND p.sent_how = 'app' ORDER BY p.sent_at`, [day]);
  const thank = await db.all(`SELECT ${PERSON_COLS} FROM li_people p
      WHERE p.accepted_on IS NOT NULL AND p.thanked_at IS NULL AND p.skipped_at IS NULL ORDER BY p.accepted_on, p.id`);
  const thankedRecent = await db.all(`SELECT ${PERSON_COLS} FROM li_people p
      WHERE p.thanked_at >= NOW() - INTERVAL '2 days' ORDER BY p.thanked_at DESC`);
  const notFound = await db.all(`SELECT ${PERSON_COLS} FROM li_people p
      WHERE p.check_note LIKE 'NOT FOUND%' AND p.accepted_on IS NULL AND p.skipped_at IS NULL ORDER BY p.id`);
  const groups = await db.all(`SELECT group_key, name, url, area, region, members, who, why, rules, status, status_at
      FROM li_groups ORDER BY CASE status WHEN 'joined' THEN 0 WHEN 'requested' THEN 1 WHEN 'suggested' THEN 2 ELSE 3 END, area, name`);
  const posts = await db.all(`SELECT post_key, area, kind, title, body, image, status, posted_in, posted_at, added_at
      FROM li_group_posts WHERE status <> 'skip' OR added_at >= NOW() - INTERVAL '14 days'
      ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'posted' THEN 1 ELSE 2 END, added_at DESC LIMIT 60`);
  const ideas = await db.all(`SELECT i.idea_key, i.day::text AS day, i.kind, i.text, i.copy_text, i.link, i.done_at,
      p.person, p.company, p.profile_url
      FROM li_ideas i LEFT JOIN li_people p ON p.id = i.person_id
      WHERE i.done_at IS NULL OR i.done_at >= NOW() - INTERVAL '2 days'
      ORDER BY (i.done_at IS NOT NULL), i.day DESC, i.idea_key LIMIT 40`);
  const lastCheck = await db.get(`SELECT checked_at, connections_read, pending, accepted_new, note FROM li_checks ORDER BY checked_at DESC LIMIT 1`);
  res.json({ day, daily: DAILY, weeklyCap: WEEKLY_CAP, room, stats, send, sentToday, thank, thankedRecent, notFound, groups, posts, ideas, lastCheck });
});

/** Every person, for the "All people" list. */
router.get('/people', authenticate, authorize(...SALES), async (req, res) => {
  res.json(await getDB().all(`SELECT ${PERSON_COLS} FROM li_people p ORDER BY p.phase_order, p.plan_date NULLS LAST, p.id`));
});

const personId = v => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };

/** She pressed Connect on LinkedIn (or undoes the tick). */
router.post('/people/:id/sent', authenticate, authorize(...SALES), async (req, res) => {
  const id = personId(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
  const r = req.body.undo
    // undo also puts back requests the agent found were never really sent (check_note "NOT FOUND …")
    ? await getDB().run(`UPDATE li_people SET sent_at = NULL, sent_by = NULL, sent_how = NULL, pending_seen = NULL,
        check_note = CASE WHEN check_note LIKE 'NOT FOUND%' THEN 'RESEND: LinkedIn did not show it pending. Use More → Connect.' ELSE check_note END,
        updated_at = NOW() WHERE id = $1 AND accepted_on IS NULL`, [id])
    : await getDB().run(`UPDATE li_people SET sent_at = NOW(), sent_by = $2, sent_how = 'app', check_note = NULL, updated_at = NOW()
        WHERE id = $1 AND sent_at IS NULL`, [id, req.user.id]);
  res.json({ message: req.body.undo ? 'Undone' : 'Marked sent', changed: r.changes ?? r.rowCount ?? null });
});

/** She sent the thank-you message on LinkedIn (or undoes it). */
router.post('/people/:id/thanked', authenticate, authorize(...SALES), async (req, res) => {
  const id = personId(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
  if (req.body.undo) await getDB().run(`UPDATE li_people SET thanked_at = NULL, thanked_by = NULL, updated_at = NOW() WHERE id = $1`, [id]);
  else await getDB().run(`UPDATE li_people SET thanked_at = NOW(), thanked_by = $2, updated_at = NOW() WHERE id = $1 AND thanked_at IS NULL`, [id, req.user.id]);
  res.json({ message: req.body.undo ? 'Undone' : 'Marked thanked' });
});

/** Not worth inviting (wrong person, no fit, said no elsewhere). */
router.post('/people/:id/skip', authenticate, authorize(...SALES), async (req, res) => {
  const id = personId(req.params.id); if (!id) return res.status(400).json({ error: 'Bad id' });
  if (req.body.undo) await getDB().run(`UPDATE li_people SET skipped_at = NULL, skip_reason = NULL, updated_at = NOW() WHERE id = $1`, [id]);
  else await getDB().run(`UPDATE li_people SET skipped_at = NOW(), skip_reason = $2, updated_at = NOW() WHERE id = $1`,
    [id, String(req.body.reason || '').trim().slice(0, 300) || null]);
  res.json({ message: req.body.undo ? 'Back in the list' : 'Skipped' });
});

router.post('/groups/:key/status', authenticate, authorize(...SALES), async (req, res) => {
  const status = String(req.body.status || '');
  if (!KEY.test(req.params.key) || !GROUP_STATUSES.includes(status)) return res.status(400).json({ error: 'Bad group or status' });
  await getDB().run(`UPDATE li_groups SET status = $2, status_at = NOW() WHERE group_key = $1`, [req.params.key, status]);
  res.json({ message: 'Saved' });
});

router.post('/posts/:key/status', authenticate, authorize(...SALES), async (req, res) => {
  const status = String(req.body.status || '');
  if (!KEY.test(req.params.key) || !POST_STATUSES.includes(status)) return res.status(400).json({ error: 'Bad post or status' });
  const where = req.body.posted_in ? String(req.body.posted_in).slice(0, 300) : null;
  if (status === 'posted') {
    await getDB().run(`UPDATE li_group_posts SET status = 'posted', posted_at = NOW(), posted_by = $2,
        posted_in = COALESCE($3, posted_in) WHERE post_key = $1`, [req.params.key, req.user.id, where]);
  } else {
    await getDB().run(`UPDATE li_group_posts SET status = $2, posted_at = NULL, posted_by = NULL WHERE post_key = $1`, [req.params.key, status]);
  }
  res.json({ message: 'Saved' });
});

router.post('/ideas/:key/done', authenticate, authorize(...SALES), async (req, res) => {
  if (!KEY.test(req.params.key)) return res.status(400).json({ error: 'Bad idea' });
  if (req.body.undo) await getDB().run(`UPDATE li_ideas SET done_at = NULL, done_by = NULL WHERE idea_key = $1`, [req.params.key]);
  else await getDB().run(`UPDATE li_ideas SET done_at = NOW(), done_by = $2 WHERE idea_key = $1 AND done_at IS NULL`, [req.params.key, req.user.id]);
  res.json({ message: req.body.undo ? 'Undone' : 'Done' });
});

module.exports = router;
