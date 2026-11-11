// ── Logged-in devices and new-device approval (owner, 11 Nov 2026) ───────────
// "tell me how many devices and which are currently logged into the app" →
// "yes build it", and "whenever there is new log in of any user in a different
// device it should ask me for permission to get in".
//
// Every browser carries a long-lived device cookie (phe_device). A login from a
// device the account has not used before is HELD: the owner is asked, and the
// browser waits on the login page until they allow it (or refuse). Once allowed,
// that device logs in to that account straight away from then on.
//
// Each login is a row in user_sessions and the pass (JWT) names it (sid), so
// the owner sees every device logged in right now and can log one out — its
// next request is refused. A pass without a sid (from before this) is refused,
// so every device signs in once more and is counted.
//
// The owner's own account is never held — nobody else could allow it, and a
// lost phone would lock the owner out — but its devices are listed like any
// other and can be logged out the same way.
const crypto = require('crypto');

const DEVICE_COOKIE = 'phe_device';
const SESSION_HOURS = 8;                    // the pass and the cookie both last this long
const DEVICE_COOKIE_DAYS = 400;             // browsers cap a cookie's life at 400 days
const REQUEST_MINUTES = 30;                 // a held login waits this long on the login page
const CACHE_MS = 30 * 1000;                 // a session's state is re-read at most this often
const SEEN_EVERY_MS = 2 * 60 * 1000;        // "last used" is written at most this often

const getDB = () => require('../db').getDB();

// "Chrome on Android phone", "Safari on iPhone", "Edge on Windows computer".
// Read from the browser's user-agent string; nothing on the device is asked.
function deviceLabel(ua) {
  const s = String(ua || '');
  if (!s.trim()) return 'Unknown device';
  let os = null, kind = 'computer';
  if (/iPhone/i.test(s)) { os = 'iPhone'; kind = null; }
  else if (/iPad/i.test(s)) { os = 'iPad'; kind = null; }
  else if (/Android/i.test(s)) { os = 'Android'; kind = /Mobile/i.test(s) ? 'phone' : 'tablet'; }
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/CrOS/.test(s)) { os = 'Chromebook'; kind = null; }
  else if (/Macintosh|Mac OS X/i.test(s)) { os = 'Mac'; kind = null; }
  else if (/Linux/i.test(s)) os = 'Linux';
  let browser = 'Browser';
  if (/Edg(e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/SamsungBrowser\//.test(s)) browser = 'Samsung Internet';
  else if (/CriOS\//.test(s)) browser = 'Chrome';
  else if (/FxiOS\/|Firefox\//.test(s)) browser = 'Firefox';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = 'Safari';
  return `${browser} on ${os ? (kind ? `${os} ${kind}` : os) : 'an unknown system'}`;
}

// The caller's address as Render passes it on (the first hop of X-Forwarded-For).
function clientIp(req) {
  const fwd = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || null;
}

const DEVICE_ID_RE = /^[a-f0-9]{48}$/;
const deviceIdFrom = (req) => {
  const v = String(req.cookies?.[DEVICE_COOKIE] || '');
  return DEVICE_ID_RE.test(v) ? v : null;
};
const newDeviceId = () => crypto.randomBytes(24).toString('hex');
function setDeviceCookie(res, deviceId) {
  res.cookie(DEVICE_COOKIE, deviceId, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: DEVICE_COOKIE_DAYS * 24 * 60 * 60 * 1000,
  });
}

// ── Logging in ───────────────────────────────────────────────────────────────
// Whether this device may log in to this account now. Returns
//   { allowed: true, device }                  — go ahead and start a session
//   { held: true, request, label, asked }      — wait for the owner
// `asked` is false when the device was already waiting (logging in again while
// it waits does not ask the owner twice).
async function admit(db, user, deviceId, req) {
  const ua = String(req.headers?.['user-agent'] || '').slice(0, 500);
  const label = deviceLabel(ua);
  const ip = clientIp(req);
  let dev = await db.get('SELECT * FROM user_devices WHERE user_id=$1 AND device_id=$2', [user.id, deviceId]);
  if (!dev) {
    dev = await db.get(
      `INSERT INTO user_devices (user_id, device_id, label, user_agent, last_ip, status)
       VALUES ($1,$2,$3,$4,$5,'new') RETURNING *`, [user.id, deviceId, label, ua, ip]);
  } else {
    await db.run('UPDATE user_devices SET label=$2, user_agent=$3, last_ip=$4 WHERE id=$1', [dev.id, label, ua, ip]);
  }
  if (dev.status !== 'approved' && user.role === 'owner') {
    // The owner's own devices are never held (see the top of this file).
    await db.run(`UPDATE user_devices SET status='approved', decided_at=NOW(), decided_by=NULL, request_token=NULL WHERE id=$1`, [dev.id]);
    dev.status = 'approved';
  }
  if (dev.status === 'approved') return { allowed: true, device: { ...dev, label, last_ip: ip } };

  const waiting = dev.status === 'pending' && dev.request_token && dev.requested_at
    && Date.now() - new Date(dev.requested_at).getTime() < REQUEST_MINUTES * 60 * 1000;
  if (waiting) return { held: true, request: dev.request_token, label, asked: false };

  const request = crypto.randomBytes(24).toString('hex');
  await db.run(
    `UPDATE user_devices SET status='pending', request_token=$2, requested_at=NOW(), decided_at=NULL, decided_by=NULL WHERE id=$1`,
    [dev.id, request]);
  const { createNotification } = require('../routes/notifications');
  const owners = await db.all("SELECT id FROM users WHERE role='owner'");
  for (const o of owners) {
    await createNotification(db, {
      userId: o.id, type: 'device_login', sourceUserId: user.id, link: '/users#devices',
      title: `${user.name} is asking to log in on a new device`,
      body: `${label}${ip ? ` · ${ip}` : ''}. They are waiting on the login page — allow or refuse it under Users → Logged-in devices.`,
    });
  }
  return { held: true, request, label, asked: true };
}

// A new session for an allowed device. Returns its id (the pass's sid).
async function start(db, user, device, req) {
  const ip = clientIp(req);
  const s = await db.get(
    `INSERT INTO user_sessions (user_id, device_row_id, label, ip, last_ip, expires_at)
     VALUES ($1,$2,$3,$4,$4, NOW() + ($5 || ' hours')::interval) RETURNING id`,
    [user.id, device.id, device.label || deviceLabel(req.headers?.['user-agent']), ip, String(SESSION_HOURS)]);
  await db.run('UPDATE user_devices SET last_login_at=NOW() WHERE id=$1', [device.id]);
  return s.id;
}

// ── Every request ────────────────────────────────────────────────────────────
// Is this session still open? Kept in memory for CACHE_MS so a page that makes
// ten calls reads the database once; ending a session clears it here at once.
const cache = new Map();   // sid → { at, ok, seen }
async function check(sid, req) {
  const key = Number(sid);
  if (!Number.isInteger(key) || key <= 0) return false;
  const now = Date.now();
  let hit = cache.get(key);
  if (!hit || now - hit.at >= CACHE_MS) {
    const s = await getDB().get('SELECT ended_at, expires_at, last_seen_at FROM user_sessions WHERE id=$1', [key]);
    hit = { at: now, ok: !!s && !s.ended_at && new Date(s.expires_at).getTime() > now,
            seen: s?.last_seen_at ? new Date(s.last_seen_at).getTime() : 0 };
    if (cache.size > 2000) cache.clear();
    cache.set(key, hit);
  }
  if (hit.ok && now - hit.seen >= SEEN_EVERY_MS) {
    // "Last used" for the owner's list — never awaited, never fails a request.
    hit.seen = now;
    getDB().run('UPDATE user_sessions SET last_seen_at=NOW(), last_ip=$2 WHERE id=$1', [key, clientIp(req)]).catch(() => {});
  }
  return hit.ok;
}
const forget = (sid) => cache.delete(Number(sid));

// End sessions: by id, or every open one on a device row. Returns the ids ended.
async function end(db, { sessionId, deviceRowId }, reason, byUserId) {
  const rows = await db.all(
    `UPDATE user_sessions SET ended_at=NOW(), ended_reason=$3, ended_by=$4
      WHERE ended_at IS NULL AND (id=$1 OR device_row_id=$2) RETURNING id`,
    [sessionId || 0, deviceRowId || 0, reason, byUserId || null]);
  rows.forEach(r => forget(r.id));
  return rows.map(r => r.id);
}

module.exports = {
  DEVICE_COOKIE, SESSION_HOURS, REQUEST_MINUTES, deviceLabel, clientIp,
  deviceIdFrom, newDeviceId, setDeviceCookie, admit, start, check, forget, end,
};
