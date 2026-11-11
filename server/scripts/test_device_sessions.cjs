// Test: logged-in devices and new-device approval (owner, 11 Nov 2026: "tell me
// how many devices and which are currently logged into the app" / "whenever there
// is new log in of any user in a different device it should ask me for
// permission to get in"). Runs the real login, wait, logout, device-list and
// authenticate code against throwaway users. Rolled back — nothing kept.
//   node scripts/test_device_sessions.cjs
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
  dbmod.getDB = () => txDb;
  dbmod.logActivity = async () => {};
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });
  const notes = [];
  const notif = require(S + '/src/routes/notifications.js');
  notif.createNotification = async (_db, n) => { notes.push(n); };

  const express = require(S + '/node_modules/express');
  const cookieParser = require(S + '/node_modules/cookie-parser');
  const { authenticate } = require(S + '/src/middleware/auth.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', require(S + '/src/routes/auth.js'));
  app.get('/api/protected', authenticate, (req, res) => res.json({ ok: true, who: req.user.username }));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;

  // A browser: its own cookie jar and user agent.
  const browser = (ua) => {
    const jar = new Map();
    return {
      jar,
      async call(method, url, body) {
        const headers = { 'content-type': 'application/json', 'user-agent': ua };
        if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
        for (const c of r.headers.getSetCookie()) {
          const [kv] = c.split(';'); const i = kv.indexOf('=');
          const k = kv.slice(0, i), v = kv.slice(i + 1);
          if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
        }
        return { status: r.status, body: await r.json().catch(() => ({})) };
      },
    };
  };
  const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
  const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  try {
    const sessions = require(S + '/src/lib/sessions.js');
    const L = sessions.deviceLabel;
    ok('1. device names read from the browser',
      L(ANDROID) === 'Chrome on Android phone' && L(WINDOWS) === 'Chrome on Windows computer' && L(IPHONE) === 'Safari on iPhone'
      && L('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15') === 'Safari on Mac'
      && L(WINDOWS + ' Edg/130.0.0.0') === 'Edge on Windows computer'
      && L('Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36') === 'Samsung Internet on Android phone'
      && L('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1') === 'Chrome on iPhone'
      && L('') === 'Unknown device', [L(ANDROID), L(WINDOWS), L(IPHONE)].join(' | '));

    const bcrypt = require(S + '/node_modules/bcryptjs');
    const hash = bcrypt.hashSync('zz-test-pass-1', 4);
    const mkUser = async (u, role) => (await client.query(
      `INSERT INTO users (username, password_hash, name, role, force_password_change) VALUES ($1,$2,$3,$4,0) RETURNING id`, [u, hash, 'ZZ ' + u, role])).rows[0].id;
    const prodId = await mkUser('zztest_prod', 'production');
    const ownerId = await mkUser('zztest_owner', 'owner');
    await mkUser('zztest_admin', 'admin');
    const creds = (u) => ({ username: u, password: 'zz-test-pass-1' });

    // A worker signs in on a phone the account has never used.
    const phone = browser(ANDROID);
    let r = await phone.call('POST', '/api/auth/login', creds('zztest_prod'));
    const req1 = r.body.request;
    ok('2. a new device is held: 202, waiting, a device cookie but no pass, named for the owner',
      r.status === 202 && r.body.pending === true && /^[a-f0-9]{48}$/.test(req1 || '') && /^[a-f0-9]{48}$/.test(phone.jar.get('phe_device') || '')
      && !phone.jar.has('phe_token') && r.body.device === 'Chrome on Android phone', JSON.stringify({ s: r.status, b: r.body }));
    const asked = notes.filter(n => n.type === 'device_login');
    ok('3. every owner is told, with a link to the device list',
      asked.length >= 2 && asked.some(n => n.userId === ownerId) && asked.every(n => n.link === '/users#devices' && /ZZ zztest_prod/.test(n.title) && /Chrome on Android phone/.test(n.body)),
      JSON.stringify(asked.map(n => [n.userId, n.title])));
    const before = notes.length;
    r = await phone.call('POST', '/api/auth/login', creds('zztest_prod'));
    ok('4. signing in again while it waits keeps the same request and does not ask the owner twice',
      r.status === 202 && r.body.request === req1 && notes.length === before);
    r = await phone.call('POST', '/api/auth/login/wait', { request: req1 });
    ok('5. the waiting page hears "still waiting"', r.status === 202 && r.body.pending === true, JSON.stringify(r));
    r = await phone.call('GET', '/api/protected');
    ok('6. …and it cannot reach the app meanwhile', r.status === 401);

    // The owner signs in on a computer: never held.
    const pc = browser(WINDOWS);
    r = await pc.call('POST', '/api/auth/login', creds('zztest_owner'));
    ok('7. the owner\'s own account is never held: straight in on a new computer',
      r.status === 200 && r.body.user?.username === 'zztest_owner' && !('sid' in (r.body.user || {})) && pc.jar.has('phe_token'), JSON.stringify(r.body));
    r = await pc.call('GET', '/api/auth/devices');
    const pend = (r.body.pending || []).find(p => p.user_id === prodId);
    const mine = (r.body.sessions || []).find(s => s.user_id === ownerId);
    ok('8. the owner\'s list: the phone waiting for approval, and the owner\'s own login marked "this device"',
      r.status === 200 && pend?.label === 'Chrome on Android phone' && pend?.ip === '127.0.0.1' && mine?.current === true && mine?.label === 'Chrome on Windows computer',
      JSON.stringify({ s: r.status, pend, mine }));

    r = await pc.call('PUT', `/api/auth/devices/${pend.id}/allow`);
    ok('9. the owner allows it', r.status === 200, JSON.stringify(r.body));
    r = await phone.call('POST', '/api/auth/login/wait', { request: req1 });
    ok('10. the waiting phone is let in: the worker, and a pass', r.status === 200 && r.body.user?.username === 'zztest_prod' && phone.jar.has('phe_token'), JSON.stringify(r.body));
    r = await phone.call('GET', '/api/protected');
    ok('11. …and it reaches the app', r.status === 200 && r.body.who === 'zztest_prod');
    const thief = browser(ANDROID);
    thief.jar.set('phe_device', 'f'.repeat(48));
    r = await thief.call('POST', '/api/auth/login/wait', { request: req1 });
    ok('12. the approval lets in only the browser that asked — another device with the request code gets nothing', r.status === 404 && !thief.jar.has('phe_token'));
    r = await phone.call('POST', '/api/auth/login/wait', { request: req1 });
    ok('13. …and only once', r.status === 404 && r.body.code === 'REQUEST_GONE');

    r = await phone.call('POST', '/api/auth/logout');
    r = await phone.call('POST', '/api/auth/login', creds('zztest_prod'));
    ok('14. an allowed device signs in straight away next time', r.status === 200 && phone.jar.has('phe_token'), JSON.stringify(r.body));
    const ended = (await client.query(`SELECT ended_reason FROM user_sessions WHERE user_id=$1 AND ended_at IS NOT NULL`, [prodId])).rows;
    ok('15. logging out ended that login', ended.length === 1 && ended[0].ended_reason === 'logged_out', JSON.stringify(ended));

    // The owner logs the phone out.
    r = await pc.call('GET', '/api/auth/devices');
    const sess = (r.body.sessions || []).find(s => s.user_id === prodId);
    r = await pc.call('PUT', `/api/auth/sessions/${sess.id}/end`);
    const after = await phone.call('GET', '/api/protected');
    ok('16. the owner logs the phone out: its very next request is refused', r.status === 200 && after.status === 401 && after.body.code === 'SESSION_ENDED', JSON.stringify(after));
    r = await phone.call('POST', '/api/auth/login', creds('zztest_prod'));
    ok('17. …it can sign in again without asking (the device is still allowed)', r.status === 200);

    // The owner removes the device: logged out and must be allowed again.
    r = await pc.call('GET', '/api/auth/devices');
    const dev = (r.body.devices || []).find(d => d.user_id === prodId);
    ok('18. the allowed list shows the phone, allowed by the owner', dev?.label === 'Chrome on Android phone' && dev?.allowed_by === 'ZZ zztest_owner', JSON.stringify(dev));
    r = await pc.call('PUT', `/api/auth/devices/${dev.id}/remove`);
    const gone = await phone.call('GET', '/api/protected');
    ok('19. removing it logs it out at once', r.status === 200 && r.body.logged_out === 1 && gone.status === 401, JSON.stringify(r.body));
    r = await phone.call('POST', '/api/auth/login', creds('zztest_prod'));
    const req2 = r.body.request;
    ok('20. …and the next sign-in is held again', r.status === 202 && req2 && req2 !== req1);
    r = await pc.call('GET', '/api/auth/devices');
    const pend2 = (r.body.pending || []).find(p => p.user_id === prodId);
    r = await pc.call('PUT', `/api/auth/devices/${pend2.id}/refuse`);
    const deadPass = phone.jar.get('phe_token');   // the pass from before it was removed — ended
    const no = await phone.call('POST', '/api/auth/login/wait', { request: req2 });
    const still = await phone.call('GET', '/api/protected');
    ok('21. the owner refuses: the waiting page is told, no new pass, and it still cannot reach the app',
      r.status === 200 && no.status === 403 && no.body.code === 'DEVICE_REFUSED' && phone.jar.get('phe_token') === deadPass && still.status === 401, JSON.stringify({ no, still: still.status }));

    // Approval is per account: the same phone signing in to another account asks again.
    r = await phone.call('POST', '/api/auth/login', creds('zztest_admin'));
    ok('22. the same phone on another account is a new device for that account: held', r.status === 202);

    const jwt = require(S + '/node_modules/jsonwebtoken');
    const old = browser(WINDOWS);
    old.jar.set('phe_token', jwt.sign({ id: prodId, username: 'zztest_prod', role: 'production' }, process.env.JWT_SECRET, { expiresIn: '8h' }));
    r = await old.call('GET', '/api/protected');
    ok('23. a pass from before this (no session) is refused — sign in again', r.status === 401 && r.body.code === 'SESSION_REQUIRED', JSON.stringify(r.body));

    const adminPc = browser(WINDOWS);
    r = await adminPc.call('POST', '/api/auth/login', creds('zztest_admin'));
    const reqA = r.body.request;
    const list = await pc.call('GET', '/api/auth/devices');
    const pa = (list.body.pending || []).find(p => p.user_name === 'ZZ zztest_admin' && p.label === 'Chrome on Windows computer');
    await pc.call('PUT', `/api/auth/devices/${pa?.id}/allow`);
    r = await adminPc.call('POST', '/api/auth/login/wait', { request: reqA });
    const r2 = await adminPc.call('GET', '/api/auth/devices');
    ok('24. only the owner sees and manages devices: the admin, signed in, gets 403', r.status === 200 && r2.status === 403, JSON.stringify({ s: r.status, s2: r2.status }));
    r = await phone.call('PUT', `/api/auth/devices/${dev.id}/allow`);
    ok('25. …a device without a pass cannot allow anything', r.status === 401);

    r = await pc.call('POST', '/api/auth/logout');
    const ownerEnd = (await client.query(`SELECT ended_reason FROM user_sessions WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [ownerId])).rows[0];
    r = await pc.call('GET', '/api/protected');
    ok('26. the owner\'s logout ends the owner\'s login too', ownerEnd?.ended_reason === 'logged_out' && r.status === 401);
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await new Promise(r => setTimeout(r, 300));
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
