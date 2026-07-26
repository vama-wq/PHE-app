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

// OT is clock-out based and earned only by per-day labour (OT from 5:30 PM) and
// Production-no-leave (OT from 7:00 PM). Admin and Production-with-leave earn no
// OT. OT minutes round to the nearest ½ hour with a 20-minute threshold: 0–19
// min into a half-hour drop, 20+ rounds up (out 7:15 → 1:30, out 7:20 → 2:00).
const OT_START = { labour: 17 * 60 + 30, fixed_production_nl: 19 * 60 }; // 5:30 PM / 7:00 PM

function roundOtBlock(min) {
  if (min <= 0) return 0;
  const blocks = Math.floor(min / 30), rem = min % 30;
  return (rem >= 20 ? blocks + 1 : blocks) * 30;
}

function otHoursFromClockOut(outMinsList, startMin) {
  const mins = (outMinsList || []).reduce((s, o) => s + roundOtBlock(Math.max((Number(o) || 0) - startMin, 0)), 0);
  return Math.round((mins / 60) * 100) / 100;
}

// OT hours for a worker by group — 0 for groups that don't earn OT
function esslOtHours(group, outMinsList) {
  const start = OT_START[group];
  return start == null ? 0 : otHoursFromClockOut(outMinsList, start);
}

// Late-arrival: a present day is "late" when the arrival punch is strictly after
// the group's threshold. The salary cut is graduated — a base cut at the
// threshold, then +15 minutes of cut for each further 10 minutes late:
//   labour / production-no-leave (after 9:10): 30 → 45 → 60 …  (base 30)
//   production-with-leave (after 9:20):        60 → 75 → 90 …  (base 60)
//   admin (after 10:20):                       60 → 75 → 90 …  (base 60)
const LATE_THRESHOLD = { labour: 9 * 60 + 10, fixed_production_nl: 9 * 60 + 10, fixed_production: 9 * 60 + 20, fixed_admin: 10 * 60 + 20 };
const LATE_BASE_MIN  = { labour: 30, fixed_production_nl: 30, fixed_production: 60, fixed_admin: 60 };
const LATE_STEP_MIN = 15;   // extra cut per additional 10-minute bracket
const LATE_BRACKET  = 10;   // bracket width

// Cut minutes for a single arrival (0 if on time)
function lateCutForArrival(group, inMin) {
  const th = LATE_THRESHOLD[group];
  if (th == null || !(Number(inMin) > th)) return 0;
  const tier = Math.floor((Number(inMin) - th) / LATE_BRACKET);
  return (LATE_BASE_MIN[group] || 0) + LATE_STEP_MIN * tier;
}

// Aggregate a worker's late days (count) and total graduated cut minutes
function lateInfo(group, inMinsList) {
  let lateDays = 0, cutMinutes = 0;
  for (const i of (inMinsList || [])) {
    const c = lateCutForArrival(group, i);
    if (c > 0) { lateDays += 1; cutMinutes += c; }
  }
  return { lateDays, cutMinutes };
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

// Saturday is a full working day but the device has it configured as a weekly
// off, so a worked Saturday shows as "WeeklyOff Present" (and an off Sunday as
// bare "WeeklyOff"). The status matcher must capture the optional WeeklyOff
// prefix, else those rows are silently dropped.
const STATUS_ALT =
  '(?:Week(?:ly)?\\s*Off\\s+)?½?\\s*(?:Absent\\s*\\(No\\s*OutPunch\\)|Absent|Present|Half\\s*Day)' +
  '|Week(?:ly)?\\s*Off|Holiday|Leave|WO';
const ROW_RE = new RegExp(
  '(\\d{1,6})' +                    // SNo + E.Code blob
  "([A-Za-z][A-Za-z .'()\\-]*?)" +  // name + shift (lazy)
  '((?:\\s*\\d{1,2}:\\d{2})+)' +    // time tokens
  '\\s*(' + STATUS_ALT + ')', 'g');

// Parse one date-section's text into per-row records.
function parseSection(text) {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const rows = [];
  let m;
  ROW_RE.lastIndex = 0;
  while ((m = ROW_RE.exec(flat)) !== null) {
    const { name, shift } = splitNameShift(m[2]);
    const times = (m[3].match(/\d{1,2}:\d{2}/g) || []).map(toMin);
    const raw = m[4];
    // "WeeklyOff Present" (worked Saturday) counts present; bare "WeeklyOff"/
    // "Holiday"/"Leave" is an off day (neither present nor absent).
    let status;
    if (/Present/i.test(raw)) status = /½|Half/i.test(raw) ? 'Half Day' : 'Present';
    else if (/Absent/i.test(raw)) status = /No\s*OutPunch/i.test(raw) ? 'Absent (No OutPunch)' : 'Absent';
    else status = 'Off';
    rows.push({ codeBlob: m[1], name, shift, times, status });
  }
  return rows;
}

// Interpret a present row's time tokens for the given format → { inMin, outMin }.
// inMin is the actual arrival (for late-day counting), outMin the clock-out (OT).
//  detailed present: S.In S.Out A.In A.Out Work OT Tot Late Early  (in=t[2], out=t[3])
//  basic present:    In Out Work OT Tot                            (in=t[0], out=t[1])
function readTimes(row, format) {
  const t = row.times;
  if (format === 'detailed') {
    return { inMin: t.length >= 9 ? t[2] : null, outMin: t.length >= 9 ? t[3] : null };
  }
  return { inMin: t.length >= 2 ? t[0] : null, outMin: t.length >= 2 ? t[1] : null };
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
      // Sunday is the weekly off — a non-attendance there isn't an absence
      // (the device inconsistently marks Sundays "WeeklyOff" or "Absent").
      // Saturday IS a working day, so its absences DO count.
      if (day.date.getUTCDay() === 0 && row.status !== 'Present' && row.status !== 'Half Day') continue;
      if (!workers.has(key)) {
        workers.set(key, { display, present: 0, absent: 0, noOutPunch: 0, inMinsList: [], outMinsList: [], lateStayDates: [], days: 0 });
      }
      const w = workers.get(key);
      w.days += 1;
      const { inMin, outMin } = readTimes(row, format);

      if (row.status === 'Present' || row.status === 'Half Day') {
        w.present += row.status === 'Half Day' ? 0.5 : 1;
        w.outMinsList.push(outMin || 0);            // clock-out for OT
        if (inMin) w.inMinsList.push(inMin);        // arrival for late-day counting
        if (outMin != null && outMin >= LATE_STAY_MIN) w.lateStayDates.push(dayIso);
      } else if (/^Absent/.test(row.status)) {
        w.absent += 1;
        if (/No\s*OutPunch/i.test(row.status)) w.noOutPunch += 1;
      }
      // Week Off / Holiday / Leave: neither present nor absent
    }
  }

  // Weekly 6:30 rule: a Mon–Sun week with 4+ late stays earns +1 sick credit.
  // otHours here is a labour-basis default; esslToAttendance recomputes it per
  // worker_group (labour 5:30, production-no-leave 7:30, others 0).
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
    w.otHours = esslOtHours('labour', w.outMinsList);
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

module.exports = { parseEssl, matchEmployees, normName, matchKey, esslOtHours, lateInfo };
