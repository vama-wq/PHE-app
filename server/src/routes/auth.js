const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB } = require('../db');
const { authenticate } = require('../middleware/auth');
const sessions = require('../lib/sessions');

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 8 * 60 * 60 * 1000,
  secure: process.env.NODE_ENV === 'production'
};

const ROLES = ['owner', 'admin', 'accounts', 'design', 'production'];

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const db = getDB();
  const user = await db.get('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  // New-device approval (owner, 11 Nov 2026): a device this account has not
  // used before waits for the owner — see lib/sessions.js.
  try {
    const deviceId = sessions.deviceIdFrom(req) || sessions.newDeviceId();
    sessions.setDeviceCookie(res, deviceId);
    const gate = await sessions.admit(db, user, deviceId, req);
    if (gate.held) {
      return res.status(202).json({
        pending: true, request: gate.request, device: gate.label, wait_minutes: sessions.REQUEST_MINUTES,
        message: `This is a new device for ${user.name}. The owner has been asked to allow it — keep this page open and you will be let in as soon as they do.`,
      });
    }
    return await signIn(res, db, user, gate.device, req);
  } catch (e) {
    console.error('[login] could not start the session:', e.message);
    return res.status(500).json({ error: 'Could not sign in just now — please try again.' });
  }
});

// Start a session for an allowed device and hand over the pass, which names it.
async function signIn(res, db, user, device, req) {
  const sid = await sessions.start(db, user, device, req);
  const payload = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    permitted_modules: user.permitted_modules || null,
  };
  const token = jwt.sign({ ...payload, sid }, process.env.JWT_SECRET, { expiresIn: `${sessions.SESSION_HOURS}h` });

  res.cookie('phe_token', token, COOKIE_OPTS);
  return res.json({ user: payload, forcePasswordChange: user.force_password_change === 1 });
}

// A held login asks here every few seconds until the owner answers. The device
// cookie and the request code together identify the browser that asked, and an
// approval lets that browser in once.
router.post('/login/wait', async (req, res) => {
  const gone = () => res.status(404).json({ code: 'REQUEST_GONE', error: 'This sign-in has ended — please sign in again.' });
  const deviceId = sessions.deviceIdFrom(req);
  const request = String(req.body?.request || '');
  if (!deviceId || !/^[a-f0-9]{48}$/.test(request)) return gone();
  try {
    return await waitAnswer(req, res, deviceId, request, gone);
  } catch (e) {
    console.error('[login/wait] failed:', e.message);
    return res.status(500).json({ error: 'Could not check just now — still waiting.' });
  }
});

async function waitAnswer(req, res, deviceId, request, gone) {
  const db = getDB();
  const dev = await db.get('SELECT * FROM user_devices WHERE device_id=$1 AND request_token=$2', [deviceId, request]);
  if (!dev) return gone();
  if (dev.status === 'pending') {
    if (Date.now() - new Date(dev.requested_at).getTime() > sessions.REQUEST_MINUTES * 60 * 1000) {
      return res.status(410).json({ code: 'REQUEST_EXPIRED', error: `The owner did not answer within ${sessions.REQUEST_MINUTES} minutes — please sign in again.` });
    }
    return res.status(202).json({ pending: true });
  }
  if (dev.status === 'refused') return res.status(403).json({ code: 'DEVICE_REFUSED', error: 'The owner did not allow this device.' });
  if (dev.status !== 'approved') return gone();
  const user = await db.get('SELECT * FROM users WHERE id=$1', [dev.user_id]);
  if (!user) return gone();
  const used = await db.get('UPDATE user_devices SET request_token=NULL WHERE id=$1 AND request_token=$2 RETURNING id', [dev.id, request]);
  if (!used) return gone();
  return signIn(res, db, user, dev, req);
}

router.post('/logout', async (req, res) => {
  // Ends this device's session, so it leaves the owner's list at once.
  const token = req.cookies?.phe_token;
  if (token) {
    try {
      const p = jwt.verify(token, process.env.JWT_SECRET);
      if (p.sid) await sessions.end(getDB(), { sessionId: p.sid }, 'logged_out', p.id);
    } catch { /* an expired or older pass has no session to end */ }
  }
  res.clearCookie('phe_token');
  res.json({ message: 'Logged out' });
});

// ── Logged-in devices (owner only, 11 Nov 2026) ──────────────────────────────
const ownerOnly = (req, res, next) => (req.user?.role === 'owner'
  ? next() : res.status(403).json({ error: 'Only the owner can see and manage devices' }));

router.get('/devices', authenticate, ownerOnly, async (req, res) => {
  const db = getDB();
  const pending = await db.all(
    `SELECT d.id, d.user_id, u.name AS user_name, u.role, d.label, d.last_ip AS ip, d.requested_at
       FROM user_devices d JOIN users u ON u.id = d.user_id
      WHERE d.status = 'pending' AND d.requested_at > NOW() - ($1 || ' minutes')::interval
      ORDER BY d.requested_at DESC`, [String(sessions.REQUEST_MINUTES)]);
  const open = await db.all(
    `SELECT s.id, s.user_id, u.name AS user_name, u.role, s.label, COALESCE(s.last_ip, s.ip) AS ip,
            s.created_at, s.last_seen_at, s.expires_at, s.device_row_id
       FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.ended_at IS NULL AND s.expires_at > NOW()
      ORDER BY s.last_seen_at DESC`);
  const devices = await db.all(
    `SELECT d.id, d.user_id, u.name AS user_name, u.role, d.label, d.last_ip AS ip, d.first_seen_at,
            d.decided_at, d.last_login_at, (SELECT name FROM users WHERE id = d.decided_by) AS allowed_by
       FROM user_devices d JOIN users u ON u.id = d.user_id
      WHERE d.status = 'approved'
      ORDER BY u.name, d.last_login_at DESC NULLS LAST`);
  res.json({
    pending,
    sessions: open.map(s => ({ ...s, current: s.id === req.user.sid })),
    devices,
    wait_minutes: sessions.REQUEST_MINUTES,
  });
});

router.put('/devices/:id/allow', authenticate, ownerOnly, async (req, res) => {
  const d = await getDB().get(
    `UPDATE user_devices SET status='approved', decided_at=NOW(), decided_by=$2
      WHERE id=$1 AND status='pending' RETURNING id`, [req.params.id, req.user.id]);
  if (!d) return res.status(404).json({ error: 'That request is no longer waiting.' });
  res.json({ message: 'Allowed' });
});

router.put('/devices/:id/refuse', authenticate, ownerOnly, async (req, res) => {
  const d = await getDB().get(
    `UPDATE user_devices SET status='refused', decided_at=NOW(), decided_by=$2
      WHERE id=$1 AND status='pending' RETURNING id`, [req.params.id, req.user.id]);
  if (!d) return res.status(404).json({ error: 'That request is no longer waiting.' });
  res.json({ message: 'Refused' });
});

// Forget an allowed device: it is logged out now, and must be allowed again
// before it can log in to that account.
router.put('/devices/:id/remove', authenticate, ownerOnly, async (req, res) => {
  const db = getDB();
  const d = await db.get(
    `UPDATE user_devices SET status='removed', decided_at=NOW(), decided_by=$2, request_token=NULL
      WHERE id=$1 AND status='approved' RETURNING id`, [req.params.id, req.user.id]);
  if (!d) return res.status(404).json({ error: 'That device is not on the allowed list.' });
  const ended = await sessions.end(db, { deviceRowId: d.id }, 'removed_by_owner', req.user.id);
  res.json({ message: 'Removed', logged_out: ended.length });
});

router.put('/sessions/:id/end', authenticate, ownerOnly, async (req, res) => {
  const ended = await sessions.end(getDB(), { sessionId: Number(req.params.id) }, 'logged_out_by_owner', req.user.id);
  if (!ended.length) return res.status(404).json({ error: 'That device is not logged in any more.' });
  res.json({ message: 'Logged out' });
});

router.get('/me', authenticate, async (req, res) => {
  const db = getDB();
  const user = await db.get(
    'SELECT id, name, username, role, force_password_change, permitted_modules FROM users WHERE id = $1',
    [req.user.id]
  );
  res.json(user);
});

router.put('/profile', authenticate, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  await getDB().run('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), req.user.id]);
  res.json({ message: 'Profile updated' });
});

router.put('/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const db = getDB();
  const user = await db.get('SELECT * FROM users WHERE id = $1', [req.user.id]);

  const valid = bcrypt.compareSync(currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const hash = bcrypt.hashSync(newPassword, 10);
  await db.run('UPDATE users SET password_hash = $1, force_password_change = 0 WHERE id = $2', [hash, req.user.id]);
  res.json({ message: 'Password changed successfully' });
});

router.get('/users', authenticate, async (req, res) => {
  if (!['owner', 'admin'].includes(req.user.role)) {
    const users = await getDB().all('SELECT id, name, role FROM users ORDER BY role, name');
    return res.json(users);
  }
  const users = await getDB().all(
    'SELECT id, name, username, role, created_at, permitted_modules FROM users ORDER BY role, name'
  );
  res.json(users);
});

router.post('/users', authenticate, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owners can create users' });
  const { username, name, role, password, permitted_modules } = req.body;
  if (!username || !name || !role || !password) return res.status(400).json({ error: 'username, name, role and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const db = getDB();
  const exists = await db.get('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  const hash = bcrypt.hashSync(password, 10);
  const mods = role === 'owner' ? null : (permitted_modules || null);
  const result = await db.insert(
    'INSERT INTO users (username, password_hash, name, role, force_password_change, permitted_modules) VALUES ($1,$2,$3,$4,0,$5)',
    [username.toLowerCase(), hash, name.trim(), role, mods]
  );
  res.json({ id: result.lastInsertRowid, message: 'User created' });
});

router.put('/users/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owners can edit users' });
  const { name, role, permitted_modules } = req.body;
  const db = getDB();
  const user = await db.get('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const newRole = role || user.role;
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const mods = newRole === 'owner' ? null : (permitted_modules !== undefined ? permitted_modules : undefined);

  if (name) await db.run('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
  if (role) await db.run('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.id]);
  if (mods !== undefined) await db.run('UPDATE users SET permitted_modules = $1 WHERE id = $2', [mods, req.params.id]);

  res.json({ message: 'Updated' });
});

router.put('/users/:id/reset-password', authenticate, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owners can reset passwords' });
  const hash = bcrypt.hashSync('PHE@2024', 10);
  await getDB().run('UPDATE users SET password_hash = $1, force_password_change = 1 WHERE id = $2', [hash, req.params.id]);
  res.json({ message: 'Password reset to PHE@2024' });
});

router.delete('/users/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owners can delete users' });
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  await getDB().run('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ message: 'User deleted' });
});

module.exports = router;
