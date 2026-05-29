const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB } = require('../db');
const { authenticate } = require('../middleware/auth');

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

  const payload = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    permitted_modules: user.permitted_modules || null,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });

  res.cookie('phe_token', token, COOKIE_OPTS);
  res.json({ user: payload, forcePasswordChange: user.force_password_change === 1 });
});

router.post('/logout', (req, res) => {
  res.clearCookie('phe_token');
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
  if (!['owner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
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
