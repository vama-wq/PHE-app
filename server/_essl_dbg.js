const fs = require('fs');
const pdfParse = require('pdf-parse');
(async () => {
  const data = await pdfParse(fs.readFileSync('/Users/vamashah/Desktop/Daily Attendance Report.pdf'));
  const parts = data.text.split(/Attendance Date\s*:/);
  // Find sections whose text contains a row starting with digits then "Admin09:30" (bare Admin rows)
  let shown = 0;
  for (let i = 0; i < parts.length - 1 && shown < 2; i++) {
    const flat = parts[i].replace(/\s*\n\s*/g, ' ');
    // a row like "22Admin09:30..." (no name between code and shift)
    const m = /(\d{2,6})Admin09:30/.exec(flat);
    if (m) {
      const idx = flat.indexOf(m[0]);
      console.log('=== section', i, 'context around bare-Admin row ===');
      console.log(flat.slice(Math.max(0, idx - 300), idx + 200));
      console.log();
      shown++;
    }
  }
  // Also: what does the START of a section look like (page-continuation rows)?
  console.log('=== section 3 head ===');
  console.log(parts[3].replace(/\s*\n\s*/g, ' ').slice(0, 600));
})().catch(e => { console.error(e); process.exit(1); });
