const jwt = require('jsonwebtoken');

// A pass is good only while its login (user_sessions, lib/sessions.js) is
// open: the owner can log a device out, and a pass from before device
// sessions (no sid) means signing in again (owner, 11 Nov 2026).
async function authenticate(req, res, next) {
  const token = req.cookies?.phe_token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  if (!payload.sid) return res.status(401).json({ error: 'Please sign in again', code: 'SESSION_REQUIRED' });
  let open;
  try {
    open = await require('../lib/sessions').check(payload.sid, req);
  } catch (e) {
    console.error('[auth] session check failed:', e.message);
    return res.status(503).json({ error: 'Could not check your login just now — please try again' });
  }
  if (!open) return res.status(401).json({ error: 'This device has been logged out', code: 'SESSION_ENDED' });
  req.user = payload;
  next();
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  };
}

// Attaches customer name to response only for admin/owner
function withCustomerVisibility(req) {
  return ['admin', 'owner'].includes(req.user?.role);
}

module.exports = { authenticate, authorize, withCustomerVisibility };
