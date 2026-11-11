// Test: files under /uploads need a login (11 Nov 2026). Loads the real server
// (index.js) in-process — database, storage bucket and WhatsApp worker are
// stubbed, so nothing live is touched — and asks for files the ways the app
// does: links and new tabs, <img> thumbnails, in-page downloads, the job card
// View / Print redirect and the drawing redirect, with and without a login.
//   node scripts/test_uploads_login.cjs
const path = require('path');
const http = require('http');
const S = path.join(__dirname, '..');
process.env.NODE_ENV = 'production';   // as on Render: the login page comes from the same app
require(S + '/node_modules/dotenv').config({ path: S + '/.env' });
(async () => {
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });

  // Database: only the rows these routes read. user_sessions answers the login
  // check inside authenticate; job_cards and drawings feed the two redirects.
  const sessionRows = new Map();
  let dbDown = false;
  const fakeDb = {
    get: async (q, p = []) => {
      if (/FROM user_sessions/.test(q)) { if (dbDown) throw new Error('connect ETIMEDOUT'); return sessionRows.get(Number(p[0])) || null; }
      if (/FROM job_cards/.test(q)) return String(p[0]) === '7' ? { id: 7, job_card_no: 'JC-ZZ-7', file_path: 'job-cards/111_card.pdf', generated_spec: null } : null;
      if (/FROM drawings/.test(q)) return p[0] === '222_dwg.pdf' ? { id: 3, file_name: '222_dwg.pdf', file_path: 'drawings/222_dwg.pdf' } : null;
      throw new Error('unexpected query in test: ' + q.slice(0, 80));
    },
    all: async () => [],
    run: async () => ({ rows: [], rowCount: 0 }),
  };
  const dbmod = require(S + '/src/db/index.js');
  dbmod.getDB = () => fakeDb;
  dbmod.initDB = async () => {};
  dbmod.logActivity = async () => {};

  // Storage bucket: a few files; `asked` records every download the server makes.
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const PDF = Buffer.from('%PDF-1.4 zz test file\n');
  const bucket = { 'product-photos/1_photo.png': PNG, 'job-cards/111_card.pdf': PDF, 'drawings/222_dwg.pdf': PDF, 'qc/5_report.pdf': PDF };
  const asked = [];
  const supa = require(S + '/node_modules/@supabase/supabase-js');
  supa.createClient = () => ({ storage: { from: () => ({
    download: async (p) => { asked.push(p); return bucket[p] ? { data: new Blob([bucket[p]]), error: null } : { data: null, error: { message: 'Object not found' } }; },
  }) } });
  require(S + '/src/lib/whatsapp.js').startWhatsAppWorker = () => {};

  // The real server, on a free port of this machine only.
  const express = require(S + '/node_modules/express');
  let server;
  const listen = express.application.listen;
  express.application.listen = function () { server = listen.call(this, 0, '127.0.0.1'); return server; };
  require(S + '/src/index.js');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;

  // What each kind of browser request sends (node:http sends exactly these).
  const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  const KIND = {
    tab:    { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: HTML },   // a link, a new tab, window.open
    oldTab: { accept: HTML },                                                              // Safari before 16.4: no sec-fetch headers
    img:    { 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors', accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
    oldImg: { accept: 'image/webp,image/avif,video/*;q=0.8,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5' },
    fetch:  { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', accept: '*/*' },        // downloadFile() in JobCardDetail
  };
  const get = (url, kind, cookie) => new Promise((resolve, reject) => {
    const headers = { ...KIND[kind] };
    if (cookie) headers.cookie = cookie;
    http.get({ host: '127.0.0.1', port, path: url, headers, timeout: 15000 }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, loc: r.headers.location, cc: r.headers['cache-control'], type: r.headers['content-type'], body: Buffer.concat(chunks) }));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
  const same = (a, b) => Buffer.compare(a, b) === 0;
  // A body as text for the report; a file's bytes would garble the terminal.
  const show = (r) => (/json|text/.test(r.type || '') ? r.body.toString().slice(0, 120) : `<${r.body.length} bytes ${r.type}>`);

  // Passes: an open login, one the owner logged out, one past its 8 hours.
  const jwt = require(S + '/node_modules/jsonwebtoken');
  const pass = (claims, secret = process.env.JWT_SECRET) => 'phe_token=' + jwt.sign({ id: 9001, username: 'zz-floor', role: 'production', ...claims }, secret);
  const HOUR = 3600 * 1000;
  sessionRows.set(901, { ended_at: null, expires_at: new Date(Date.now() + HOUR), last_seen_at: new Date() });
  sessionRows.set(902, { ended_at: new Date(), expires_at: new Date(Date.now() + HOUR), last_seen_at: new Date() });
  sessionRows.set(903, { ended_at: null, expires_at: new Date(Date.now() - 1000), last_seen_at: new Date() });
  const IN = pass({ sid: 901 });
  const PHOTO = '/uploads/product-photos/1_photo.png';
  const CARD = '/uploads/job-cards/111_card.pdf';

  try {
    // ── No login: nothing is served, and the bucket is never asked ──
    let r = await get(PHOTO, 'tab');
    ok('1. link / new tab, no login → sent to the login page', r.status === 302 && r.loc === '/login', `${r.status} ${r.loc}`);
    r = await get(PHOTO, 'oldTab');
    ok('2. same on an older Safari (no sec-fetch headers)', r.status === 302 && r.loc === '/login', `${r.status} ${r.loc}`);
    r = await get(PHOTO, 'img');
    ok('3. <img> thumbnail, no login → 401, not a redirect', r.status === 401 && !r.loc, `${r.status} ${r.loc}`);
    r = await get(PHOTO, 'oldImg');
    ok('4. <img> on an older Safari → 401', r.status === 401 && !r.loc, `${r.status} ${r.loc}`);
    r = await get(CARD, 'fetch');
    ok('5. in-page download, no login → 401 (the page then opens it in a tab)', r.status === 401 && !r.loc, r.status);
    ok('6. none of those reached the storage bucket', asked.length === 0, asked.join(', '));

    // ── Passes that must not work ──
    r = await get(PHOTO, 'img', 'phe_token=not-a-real-pass');
    ok('7. forged pass → 401', r.status === 401, r.status);
    r = await get(PHOTO, 'img', pass({ sid: 901 }, 'some-other-secret'));
    ok('8. pass signed with another secret → 401', r.status === 401, r.status);
    r = await get(PHOTO, 'img', pass({ sid: 901, exp: Math.floor(Date.now() / 1000) - 60 }));
    ok('9. expired pass → 401', r.status === 401, r.status);
    r = await get(PHOTO, 'img', pass({}));
    ok('10. pass from before device sessions (no sid) → 401 SESSION_REQUIRED', r.status === 401 && /SESSION_REQUIRED/.test(r.body), `${r.status} ${show(r)}`);
    r = await get(PHOTO, 'img', pass({ sid: 902 }));
    ok('11. device the owner logged out → 401 SESSION_ENDED', r.status === 401 && /SESSION_ENDED/.test(r.body), `${r.status} ${show(r)}`);
    r = await get(PHOTO, 'tab', pass({ sid: 902 }));
    ok('12. …and the same file opened in a tab → login page', r.status === 302 && r.loc === '/login', `${r.status} ${r.loc}`);
    r = await get(PHOTO, 'img', pass({ sid: 903 }));
    ok('13. login past its 8 hours → 401', r.status === 401, r.status);
    dbDown = true;
    r = await get(PHOTO, 'tab', pass({ sid: 904 }));
    dbDown = false;
    ok('14. login check cannot reach the database → 503, not the file, not a redirect', r.status === 503 && !r.loc, `${r.status} ${r.loc}`);
    ok('15. still nothing fetched from the bucket', asked.length === 0, asked.join(', '));

    // ── Logged in: every way the app opens a file ──
    r = await get(PHOTO, 'img', IN);
    ok('16. <img> thumbnail, logged in → the photo', r.status === 200 && same(r.body, PNG) && r.type === 'image/png', `${r.status} ${r.type}`);
    ok('17. cached privately — this browser only, never Cloudflare', r.cc === 'private, max-age=86400', r.cc);
    r = await get(CARD, 'tab', IN);
    ok('18. link / new tab, logged in → the PDF, shown as a PDF', r.status === 200 && same(r.body, PDF) && r.type === 'application/pdf', `${r.status} ${r.type}`);
    r = await get(PHOTO, 'oldTab', IN);
    ok('19. older Safari, logged in → the photo', r.status === 200 && same(r.body, PNG), r.status);
    r = await get('/uploads/qc/5_report.pdf', 'fetch', IN);
    ok('20. in-page download, logged in → the file', r.status === 200 && same(r.body, PDF), r.status);
    r = await get('/uploads/qc/missing.pdf', 'fetch', IN);
    ok('21. missing file, logged in → 404 as before', r.status === 404 && r.body.toString() === 'File not found', `${r.status} ${show(r)}`);

    // ── Job card View, and Print (printJobCardSlip opens the same route) ──
    r = await get('/api/job-cards/7/view', 'tab', IN);
    ok('22. View on an uploaded card → redirect to its file', r.status === 302 && r.loc === CARD, `${r.status} ${r.loc}`);
    const card = await get(r.loc, 'tab', IN);   // the browser follows it with the same cookie
    ok('23. …which opens with the login cookie', card.status === 200 && same(card.body, PDF) && card.type === 'application/pdf', `${card.status} ${card.type}`);
    r = await get('/api/job-cards/7/view', 'tab');
    ok('24. View with no login is refused before any redirect (unchanged)', r.status === 401 && !r.loc, `${r.status} ${r.loc}`);

    // ── Drawing link (routes/drawings.js redirects the same way) ──
    r = await get('/api/drawings/file/222_dwg.pdf', 'tab', IN);
    ok('25. drawing link → redirect to its file', r.status === 302 && r.loc === '/uploads/drawings/222_dwg.pdf', `${r.status} ${r.loc}`);
    const dwg = await get(r.loc, 'tab', IN);
    ok('26. …which opens with the login cookie', dwg.status === 200 && same(dwg.body, PDF), dwg.status);

    // ── What must stay open ──
    r = await get('/healthz', 'fetch');
    ok('27. keep-alive /healthz needs no login', r.status === 200, r.status);
    r = await get('/login', 'tab');
    ok('28. the redirect lands on the app\'s login page', r.status === 200 && /text\/html/.test(r.type || '') && r.body.includes('<div id="root"></div>'), `${r.status} ${r.type}`);
    r = await get('/phe-oman-flyer.jpg', 'img');
    ok('29. campaign flyers (site root, used in emails) still open without a login', r.status === 200 && /image\/jpeg/.test(r.type || ''), `${r.status} ${r.type}`);
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    server.close();
    console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL PASS (stubbed — nothing live touched)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
