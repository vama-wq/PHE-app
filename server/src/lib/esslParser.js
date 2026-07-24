const pdfParse = require('pdf-parse');

// ── ESSL "Daily Attendance Report (Detailed Report)" parser ───────────────────
// The report is one page-section per attendance date. Extracted text rows look
// like (fields concatenated, no separators):
//   1414ReenaGS09:0017:3009:0419:018:261:319:5700:0000:00Present09:04:in(TD),19:01:out(TD),
//   [SNo+ECode][Name][Shift][S.In][S.Out][A.In][A.Out][Work][OT][Tot][Late][Early][Status][Punches]
// Absent rows carry fewer time tokens; "Absent (No OutPunch)" has an in-punch
// only. Each section ends with "Attendance Date :DD-Mon-YYYY".
//
// OT policy (owner's): OT = time worked beyond the shift's scheduled out-time.
// The device's own OT column matches this for GS / fixed-labour shifts, but the
// Admin shift is misconfigured on the device (12-hour "05:30" out-time, OT
// always 00:00) — so OT is recomputed from the actual out-punch vs the
// normalized schedule for every row, falling back to the device OT column.

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
};
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The Admin shift's scheduled out shows as "05:30" (12h format). Normalize any
// scheduled out that lands before the scheduled in by adding 12 hours.
function normalizeSchedOut(inMin, outMin) {
  if (inMin == null || outMin == null) return outMin;
  return outMin <= inMin ? outMin + 12 * 60 : outMin;
}

function parseDate(str) {
  const m = /(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(str);
  if (!m) return null;
  return new Date(Date.UTC(parseInt(m[3], 10), MONTHS[m[2]] ?? 0, parseInt(m[1], 10)));
}

// Split one date-section's text into employee rows and parse each.
function parseSection(text) {
  const rows = [];
  // Collapse the wrapped-shift newlines ("fixed \nlabour", "Absent (No \nOutPunch)")
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const rowRe = /(\d{1,6})([A-Za-z][A-Za-z .'()-]*?)((?:\s*\d{1,2}:\d{2})+)\s*(Present|Absent\s*\(No\s*OutPunch\)|Absent|Week\s*Off|WO|Holiday|Half\s*Day|Leave)((?:[^A-Za-z]*\d{1,2}:\d{2}:[a-z()TDA,]*)*)/g;
  let m;
  while ((m = rowRe.exec(flat)) !== null) {
    const nameShift = m[2].trim();
    const times = (m[3].match(/\d{1,2}:\d{2}/g) || []).map(toMin);
    const status = m[4].replace(/\s+/g, ' ');
    const punches = m[5] || '';
    const inPunch = /(\d{1,2}:\d{2}):in/.exec(punches);
    const outMatches = [...punches.matchAll(/(\d{1,2}:\d{2}):out/g)];
    const outPunch = outMatches.length ? outMatches[outMatches.length - 1][1] : null;
    rows.push({
      codeBlob: m[1],
      nameShift,
      times,
      status,
      inPunch: inPunch ? toMin(inPunch[1]) : null,
      outPunch: outPunch ? toMin(outPunch) : null,
    });
  }
  return rows;
}

// Interpret a row's time tokens. Layouts observed:
//  9 tokens: S.In S.Out A.In A.Out Work OT Tot Late Early   (present)
//  8 tokens: S.In S.Out A.In 0 0 0 0 0                      (absent, no out-punch)
//  7 tokens: 0 0 0 0 0 0 0                                  (absent, NS shift)
function interpretTimes(row) {
  const t = row.times;
  let schedIn = null, schedOut = null, deviceOt = 0;
  if (t.length >= 9) {
    schedIn = t[0]; schedOut = t[1];
    deviceOt = t[5] || 0;
  } else if (t.length === 8) {
    schedIn = t[0]; schedOut = t[1];
  }
  return { schedIn, schedOut: normalizeSchedOut(schedIn, schedOut), deviceOt };
}

async function parseEssl(buffer) {
  const data = await pdfParse(buffer);
  // Section per date: text streams rows first, then the header + date line.
  const parts = data.text.split(/Attendance Date\s*:/);
  const days = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const dateMatch = /^\s*(\d{2}-[A-Za-z]{3}-\d{4})/.exec(parts[i + 1]);
    if (!dateMatch) continue;
    const date = parseDate(dateMatch[1]);
    if (!date) continue;
    days.push({ date, rows: parseSection(parts[i]) });
  }
  days.sort((a, b) => a.date - b.date);

  // Aggregate per PERSON (matched later against the employees table by name).
  // The shift suffix changes day to day (GS/Admin on present days, NS when
  // absent), so it must be stripped before grouping. Unnamed device employees
  // (name is just the code) are kept as '#<digits>' so nothing silently drops.
  const SHIFT_TOKENS = /(fixed\s*labour|admin|gs|ns|wo|os|s\d*)$/i;
  const personName = (row) => {
    const stripped = row.nameShift.replace(SHIFT_TOKENS, '').trim();
    return stripped || `#${row.codeBlob}`;
  };
  const workers = new Map(); // normName key → aggregate
  const seenDayKeys = new Set(); // `${key}|${date}` — a date's roster can span pages
  for (const day of days) {
    const dayIso = day.date.toISOString().slice(0, 10);
    for (const row of day.rows) {
      const display = personName(row);
      const key = normName(display);
      if (!key) continue;
      if (seenDayKeys.has(`${key}|${dayIso}`)) continue;
      seenDayKeys.add(`${key}|${dayIso}`);
      if (!workers.has(key)) {
        workers.set(key, {
          nameShift: display, present: 0, absent: 0, noOutPunch: 0,
          otMinutes: 0, lateStayDates: [], days: 0,
        });
      }
      const w = workers.get(key);
      w.days += 1;
      const { schedOut, deviceOt } = interpretTimes(row);

      if (row.status === 'Present' || row.status === 'Half Day') {
        w.present += row.status === 'Half Day' ? 0.5 : 1;
        // OT beyond the scheduled out-time, from the real out-punch when
        // available (fixes the misconfigured Admin shift), else device OT.
        if (row.outPunch != null && schedOut != null) {
          w.otMinutes += Math.max(row.outPunch - schedOut, 0);
        } else {
          w.otMinutes += deviceOt || 0;
        }
        // 6:30pm stays (admin sick-credit rule) — from the real out-punch
        if (row.outPunch != null && row.outPunch >= 18 * 60 + 30) {
          w.lateStayDates.push(day.date.toISOString().slice(0, 10));
        }
      } else if (/^Absent/.test(row.status)) {
        w.absent += 1;
        if (/No OutPunch/.test(row.status)) w.noOutPunch += 1;
      }
      // Week Off / Holiday / Leave: neither present nor absent
    }
  }

  // Weekly 6:30 rule: a Mon–Sun week with 4+ late stays earns +1 sick credit
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
    w.otHours = Math.round((w.otMinutes / 60) * 100) / 100;
  }

  return {
    period: { from: days[0]?.date?.toISOString().slice(0, 10) || null, to: days[days.length - 1]?.date?.toISOString().slice(0, 10) || null },
    dayCount: days.length,
    workers,
  };
}

// Match a parsed worker key against an employee name: the row text is
// "<Name><Shift>" concatenated, so the normalized row must START WITH the
// normalized employee name (longest match wins across employees).
function matchEmployees(workers, employees) {
  const matched = new Map();   // employee_id → aggregate
  const usedKeys = new Set();
  const sorted = [...employees].sort((a, b) => normName(b.name).length - normName(a.name).length);
  for (const emp of sorted) {
    const en = normName(emp.name);
    if (!en) continue;
    for (const [key, agg] of workers) {
      if (usedKeys.has(key)) continue;
      if (key.startsWith(en)) {
        matched.set(emp.id, agg);
        usedKeys.add(key);
        break;
      }
    }
  }
  const unmatched = [...workers.entries()].filter(([k]) => !usedKeys.has(k)).map(([, a]) => a.nameShift);
  return { matched, unmatched };
}

module.exports = { parseEssl, matchEmployees, normName };
