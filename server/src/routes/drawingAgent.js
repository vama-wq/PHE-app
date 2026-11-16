// ── Drawings to make (owner, 14 Nov 2026) ────────────────────────────────────
// The page where the app draws plain U type heaters itself (lib/drawings/
// agent.js): what needs a drawing, the sheet with its questions, and one
// approval that puts the drawing on the order item and makes the job card.
// Owner only — "only she answers the questions and approves".
const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const agent = require('../lib/drawings/agent');

// Answers arrive as an object (POST) or a JSON string (?answers= on GET).
function answersFrom(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string' || !v.trim()) return {};
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
const itemIdOf = (req) => { const id = parseInt(req.params.id, 10); return id > 0 ? id : null; };

// The proposal as the page reads it (status 404 when the item is gone).
async function sendProposal(req, res, answers) {
  const id = itemIdOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid order item' });
  try {
    const p = await agent.propose(getDB(), id, answersFrom(answers), { approver: req.user });
    if (!p.ok) return res.status(p.status || 400).json({ error: p.error });
    res.json(p);
  } catch (e) {
    console.error('[drawing-agent] proposal failed:', e);
    res.status(500).json({ error: 'Could not work out the drawing — please try again.' });
  }
}

router.get('/queue', authenticate, authorize('owner'), async (req, res) => {
  try {
    res.json(await agent.findDue(getDB()));
  } catch (e) {
    console.error('[drawing-agent] queue failed:', e);
    res.status(500).json({ error: 'Could not read the drawings to make — please try again.' });
  }
});

// Her rollers (owner, 14 Nov 2026: "a roller is basically a tool on which the
// heater is bend to a u"): the list the agent picks a roller from for the
// client's inside gap. Until she saves hers (Monday 16 Nov), the three on her drawings.
router.get('/rollers', authenticate, authorize('owner'), async (req, res) => {
  try {
    res.json(await agent.rollerList(getDB()));
  } catch (e) {
    console.error('[drawing-agent] rollers failed:', e);
    res.status(500).json({ error: 'Could not read the rollers — please try again.' });
  }
});

router.put('/rollers', authenticate, authorize('owner'), async (req, res) => {
  try {
    const r = await agent.saveRollers(getDB(), req.body?.mm, req.user);
    res.status(r.status).json(r.body);
  } catch (e) {
    console.error('[drawing-agent] saving rollers failed:', e);
    res.status(500).json({ error: 'Could not save the rollers — nothing was saved. Please try again.' });
  }
});

router.get('/items/:id', authenticate, authorize('owner'), (req, res) => sendProposal(req, res, req.query.answers));

router.post('/items/:id/preview', authenticate, authorize('owner'), (req, res) => sendProposal(req, res, req.body?.answers));

router.post('/items/:id/approve', authenticate, authorize('owner'), async (req, res) => {
  const id = itemIdOf(req);
  if (!id) return res.status(400).json({ error: 'Invalid order item' });
  try {
    const b = req.body || {};
    const r = await agent.approve(getDB(), id, {
      answers: answersFrom(b.answers), sheetCode: b.sheet_code,
      fittingConfirmed: b.fitting_confirmed === true || b.fitting_confirmed === 'true',
      // The set her tick was for: it confirms that set only.
      fittingConfirmedSet: typeof b.fitting_confirmed_set === 'string' ? b.fitting_confirmed_set : null,
      seenSnapshot: b.seen_snapshot && typeof b.seen_snapshot === 'object' ? b.seen_snapshot : null,
    }, req.user);
    res.status(r.status).json(r.body);
  } catch (e) {
    console.error('[drawing-agent] approve failed:', e);
    res.status(500).json({ error: 'Could not save the drawing — nothing was saved. Please try again.' });
  }
});

module.exports = router;
