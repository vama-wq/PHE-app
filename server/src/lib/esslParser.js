const pdfParse = require('pdf-parse');

// ── ESSL "Daily Attendance Report" parser (Basic + Detailed formats) ──────────
// The device exports two layouts and this parser handles both:
//
//  Detailed Report — columns: SNo E.Code Name Shift S.In S.Out A.In A.Out
//    Work OT Tot Late Early Status [Punch Records]. Section marker:
//    "Attendance Date :DD-Mon-YYYY".
//  Basic Report — columns: SNo E.Code Name Shift InTime OutTime Work OT Tot
//    Status Remarks. Section marker: "Attendance DateDD-Mon-YYYY" (no colon,
//    no scheduled times, no punch records).
//
// Each section is one attendance date; rows stream first, then the header and
// the "Attendance Date…" line. Rows look like (fields concatenated, no gaps):
//   33GayaAdmin10:1818:288:1000:00 8:10 Present        (basic, present)
//   11Vama ShahNS00:0000:00 00:00 Absent               (basic, absent)
//   77RajuGS09:2112:092:4800:00 2:48 ½Present           (basic, half day)
//
// OT policy: the device's OT column is correct for GS / fixed-labour shifts but
// the Admin shift is misconfigured (OT always 00:00), so Admin OT is recomputed
// as actual-out minus the 17:30 scheduled out; other shifts use the device OT.

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const LATE_STAY_MIN = 18 * 60 + 30;     // 18:30 — admin 6:30 sick-credit threshold

// Standard working day (minutes) by payroll worker_group — OT accrues beyond it
const STD_DAY_MIN = { fixed_production: 600, fixed_production_nl: 600, fixed_admin: 480, labour: 480 };

// OT hours from a list of per-present-day total-worked minutes vs the standard day
function otHoursFor(totMinsList, stdMin) {
  const ot = (totMinsList || []).reduce((s, m) => s + Math.max(Number(m) - stdMin, 0), 0);
  return Math.round((ot / 60) * 100) / 100;
}

const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
};
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Drop trailing honorifics (Ben / Bhai / Behn / ji) the ESSL device omits, so
// "Chanchal Ben" ↔ "chanchal" and "Gayaji" ↔ "Gaya" match.
const matchKey = (s) => {
  const n = normName(s);
  return n.replace(/(ben|bhai|bhen|behn|ji)$/i, '') || n;
};
const SHIFT_RE = /(fixed\s*labour|admin|gs|ns|os|wo)$/i;

function parseDate(str) {
  const m = /(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(str);
  if (!m) return null;
  return new Date(Date.UTC(parseInt(m[3], 10), MONTHS[m[2]] ?? 0, parseInt(m[1], 10)));
}

// Split a name+shift blob (e.g. "SITA BENNS", "mukeshfixed labour") into parts.
function splitNameShift(blob) {
  const s = blob.trim();
  const m = SHIFT_RE.exec(s);
  if (m) return { name: s.slice(0, m.index).trim(), shift: m[1].toLowerCase().replace(/\s+/g, '') };
  return { name: s, shift: '' };
}

const STATUS_ALT = '(?:Absent\\s*\\(No\\s*OutPunch\\)|Absent|Present|Week\\s*Off|WO|Holiday|Half\\s*Day|Leave)';
const ROW_RE = new RegExp(
  '(\\d{1,6})' +                    // SNo + E.Code blob
  "([A-Za-z][A-Za-z .'()\\-]*?)" +  // name + shift (lazy)
  '((?:\\s*\\d{1,2}:\\d{2})+)' +    // time tokens
  '\\s*(½\\s*)?(' + STATUS_ALT + ')', 'g');

// Parse one date-section's text into per-row records.
function parseSection(text) {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const rows = [];
  let m;
  ROW_RE.lastIndex = 0;
  while ((m = ROW_RE.exec(flat)) !== null) {
    const { name, shift } = splitNameShift(m[2]);
    const times = (m[3].match(/\d{1,2}:\d{2}/g) || []).map(toMin);
    const half = !!m[4];
    let status = m[5].replace(/\s+/g, ' ');
    if (half) status = 'Half Day';
    rows.push({ codeBlob: m[1], name, shift, times, status });
  }
  return rows;
}

// Interpret a present row's time tokens for the given format → { outMin, totMin }.
// totMin is total worked duration; OT is derived later from the worker's payroll
// standard day, not here (the ESSL "shift" label doesn't map to worker_group).
//  detailed present: S.In S.Out A.In A.Out Work OT Tot Late Early  (out=t[3], tot=t[6])
//  basic present:    In Out Work OT Tot                            (out=t[1], tot=t[4])
function readTimes(row, format) {
  const t = row.times;
  if (format === 'detailed') {
    return { outMin: t.length >= 9 ? t[3] : null, totMin: t.length >= 9 ? (t[6] || 0) : 0 };
  }
  return { outMin: t.length >= 5 ? t[1] : (t.length >= 2 ? t[1] : null), totMin: t.length >= 5 ? (t[4] || 0) : 0 };
}

async function parseEssl(buffer) {
  const data = await pdfParse(buffer);
  const format = /\(Basic Report\)/i.test(data.text) ? 'basic' : 'detailed';

  // Section per date — the marker is "Attendance Date" then an optional colon
  // then the DD-Mon-YYYY date (colon present in Detailed, absent in Basic).
  const parts = data.text.split(/Attendance Date\s*:?\s*/);
  const days = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const dm = /^\s*(\d{2}-[A-Za-z]{3}-\d{4})/.exec(parts[i + 1]);
    if (!dm) continue;
    const date = parseDate(dm[1]);
    if (!date) continue;
    days.push({ date, rows: parseSection(parts[i]) });
  }
  days.sort((a, b) => a.date - b.date);

  // Aggregate per person (shift + honorific stripped so names collapse across
  // the day-varying shift labels and match the payroll list later).
  const workers = new Map();
  const seenDayKeys = new Set(); // `${key}|${dateIso}` — roster can span pages
  for (const day of days) {
    const dayIso = day.date.toISOString().slice(0, 10);
    for (const row of day.rows) {
      const display = row.name || `#${row.codeBlob}`;
      const key = matchKey(display);
      if (!key) continue;
      if (seenDayKeys.has(`${key}|${dayIso}`)) continue;
      seenDayKeys.add(`${key}|${dayIso}`);
      if (!workers.has(key)) {
        workers.set(key, { display, present: 0, absent: 0, noOutPunch: 0, totMinsList: [], lateStayDates: [], days: 0 });
      }
      const w = workers.get(key);
      w.days += 1;
      const { outMin, totMin } = readTimes(row, format);

      if (row.status === 'Present' || row.status === 'Half Day') {
        w.present += row.status === 'Half Day' ? 0.5 : 1;
        w.totMinsList.push(totMin || 0);            // for OT vs standard day
        if (outMin != null && outMin >= LATE_STAY_MIN) w.lateStayDates.push(dayIso);
      } else if (/^Absent/.test(row.status)) {
        w.absent += 1;
        if (/No\s*OutPunch/i.test(row.status)) w.noOutPunch += 1;
      }
      // Week Off / Holiday / Leave: neither present nor absent
    }
  }

  // Weekly 6:30 rule: a Mon–Sun week with 4+ late stays earns +1 sick credit.
  // otHours here is a default (8h standard) — esslToAttendance recomputes it
  // against each worker's payroll standard day (8h admin/labour, 10h production).
  for (const w of workers.values()) {
    const weeks = new Map();
    for (const d of w.lateStayDates) {
      const dt = new Date(d + 'T00:00:00Z');
      const monday = new Date(dt);
      monday.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
      const wk = monday.toISOString().slice(0, 10);
      weeks.set(wk, (weeks.get(wk) || 0) + 1);
    }
    w.lateStays = w.lateStayDates.length;
    w.sickCreditWeeks = [...weeks.values()].filter(n => n >= 4).length;
    w.otHours = otHoursFor(w.totMinsList, 8 * 60);
    w.nameShift = w.display; // back-compat with callers/logs
  }

  return {
    format,
    period: { from: days[0]?.date?.toISOString().slice(0, 10) || null, to: days[days.length - 1]?.date?.toISOString().slice(0, 10) || null },
    dayCount: days.length,
    workers,
  };
}

// Match parsed workers to payroll employees: the honorific/shift-stripped
// employee key must be a prefix of the report key (e.g. "nayan" ⊂ "nayanlakhani"),
// longest employee name first so the most specific wins.
function matchEmployees(workers, employees) {
  const matched = new Map();
  const usedKeys = new Set();
  const sorted = [...employees].sort((a, b) => matchKey(b.name).length - matchKey(a.name).length);
  for (const emp of sorted) {
    const en = matchKey(emp.name);
    if (!en) continue;
    for (const [key, agg] of workers) {
      if (usedKeys.has(key)) continue;
      if (key === en || key.startsWith(en) || en.startsWith(key)) {
        matched.set(emp.id, agg);
        usedKeys.add(key);
        break;
      }
    }
  }
  const unmatched = [...workers.entries()].filter(([k]) => !usedKeys.has(k)).map(([, a]) => a.display);
  return { matched, unmatched };
}

module.exports = { parseEssl, matchEmployees, normName, matchKey, otHoursFor, STD_DAY_MIN };
