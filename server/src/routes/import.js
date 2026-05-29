const router = require('express').Router();
const multer = require('multer');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const path = require('path');
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadToStorage, deleteFromStorage } = require('../middleware/upload');

/**
 * Extract images embedded in an xlsx file, keyed by 0-based data-row index.
 *
 * `headerRowIndex` is the 0-based sheet row that contains the column headers
 * (default 0). Drawing rows are also 0-based, so a photo anchored to drawing
 * row `R` maps to data row `R - headerRowIndex - 1`.
 *
 * Returns Map<dataRowIndex, { data: Buffer, ext: string }>
 */
function extractXlsxImages(buffer, headerRowIndex = 0) {
  const imageMap = new Map();
  try {
    const zip = new AdmZip(buffer);

    // Resolve a zip-relative path safely (handles ".." segments)
    const resolvePath = (base, rel) =>
      (base + '/' + rel).split('/').filter(Boolean)
        .reduce((acc, p) => { if (p === '..') acc.pop(); else acc.push(p); return acc; }, [])
        .join('/');

    // Find the drawing reference in the first sheet's rels file
    const sheetRelsEntry = zip.getEntry('xl/worksheets/_rels/sheet1.xml.rels');
    if (!sheetRelsEntry) return imageMap;

    const sheetRelsXml = sheetRelsEntry.getData().toString('utf8');
    const drawingRef = sheetRelsXml.match(/Type="[^"]*\/drawing"[^>]*Target="([^"]+)"/);
    if (!drawingRef) return imageMap;

    // e.g. "../drawings/drawing1.xml" resolved from "xl/worksheets" → "xl/drawings/drawing1.xml"
    const drawingZipPath = resolvePath('xl/worksheets', drawingRef[1]);
    const drawingEntry = zip.getEntry(drawingZipPath);
    if (!drawingEntry) return imageMap;
    const drawingXml = drawingEntry.getData().toString('utf8');

    // Drawing rels: xl/drawings/_rels/drawing1.xml.rels
    const drawingDir  = drawingZipPath.substring(0, drawingZipPath.lastIndexOf('/'));
    const drawingFile = drawingZipPath.substring(drawingZipPath.lastIndexOf('/') + 1);
    const drawingRelsEntry = zip.getEntry(`${drawingDir}/_rels/${drawingFile}.rels`);
    if (!drawingRelsEntry) return imageMap;
    const drawingRelsXml = drawingRelsEntry.getData().toString('utf8');

    // Build rId → zip media path map
    const rIdToMedia = {};
    for (const m of drawingRelsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      rIdToMedia[m[1]] = resolvePath(drawingDir, m[2]);
    }

    // Parse each drawing anchor for row position + image rId
    // Works for both <xdr:twoCellAnchor> and <xdr:oneCellAnchor>
    const anchorRe = /<xdr:(?:twoCellAnchor|oneCellAnchor)[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g;
    for (const [block] of drawingXml.matchAll(anchorRe)) {
      const rowMatch = block.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
      const rIdMatch = block.match(/r:embed="([^"]+)"/);
      if (!rowMatch || !rIdMatch) continue;

      const drawingRow = parseInt(rowMatch[1], 10); // 0 = header row
      const mediaPath  = rIdToMedia[rIdMatch[1]];
      if (!mediaPath) continue;

      const mediaEntry = zip.getEntry(mediaPath);
      if (!mediaEntry) continue;

      const ext          = path.extname(mediaPath).replace('.', '').toLowerCase() || 'png';
      const dataRowIndex = drawingRow - headerRowIndex - 1; // offset past empty rows + header
      if (dataRowIndex >= 0) {
        imageMap.set(dataRowIndex, { data: mediaEntry.getData(), ext });
      }
    }
  } catch (e) {
    console.error('[import] image extraction error:', e.message);
  }
  return imageMap;
}

// Memory storage — we only need to parse the buffer, not save the file.
// 20 MB limit to accommodate xlsx files that embed product images.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function sendTemplate(res, columns, filename) {
  const ws = XLSX.utils.aoa_to_sheet([columns]);
  ws['!cols'] = columns.map(c => ({ wch: Math.max(c.length + 4, 18) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

/**
 * Parse the first sheet of an xlsx buffer into an array of row objects.
 * Automatically skips leading empty rows so the header can be anywhere.
 * All column names are trimmed so trailing spaces are normalised.
 *
 * Also returns `headerRowIndex` (0-based in the sheet) so the image
 * extractor can compute the correct row offsets.
 */
function parseRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];

  // Read every row as a plain array first
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Find the first row that has at least one non-empty cell — that is the header
  let headerRowIndex = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].some(c => c !== null && String(c).trim() !== '')) {
      headerRowIndex = i;
      break;
    }
  }

  // Build trimmed header names
  const headers = (raw[headerRowIndex] || []).map(h =>
    h !== null && h !== undefined ? String(h).trim() : ''
  );

  // Build row objects from all subsequent non-empty rows
  const rows = [];
  for (let i = headerRowIndex + 1; i < raw.length; i++) {
    const cells = raw[i] || [];
    // Skip rows that are completely blank
    if (!cells.some(c => c !== null && String(c).trim() !== '')) continue;
    const obj = {};
    headers.forEach((key, ci) => {
      if (key) obj[key] = cells[ci] != null ? String(cells[ci]).trim() : '';
    });
    rows.push(obj);
  }

  return { rows, headerRowIndex };
}

function str(v) { return String(v == null ? '' : v).trim(); }
function strOrNull(v) { const s = str(v); return s || null; }
function numOrDefault(v, d = 0) { const n = parseFloat(v); return isNaN(n) ? d : n; }

// ─── CUSTOMERS ────────────────────────────────────────────────────────────────

router.get('/customers/template', authenticate, (req, res) => {
  sendTemplate(res,
    ['customer_code', 'name', 'contact_person', 'phone', 'email', 'billing_address', 'shipping_address', 'gst_no', 'notes',
     'country_of_destination', 'port_of_loading', 'port_of_discharge', 'final_destination'],
    'customers_template.xlsx');
});

router.post('/customers', authenticate, authorize('admin', 'owner'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const db = getDB();
  let rows;
  try { ({ rows } = parseRows(req.file.buffer)); } catch { return res.status(400).json({ error: 'Invalid Excel file' }); }
  if (!rows.length) return res.json({ imported: 0, skipped: 0, errors: [], total: 0 });

  let imported = 0, skipped = 0;
  const errors = [];

  for (const [i, row] of rows.entries()) {
    const rowNum = i + 2;
    if (!str(row.customer_code)) { errors.push(`Row ${rowNum}: customer_code is required`); skipped++; continue; }
    if (!str(row.name))          { errors.push(`Row ${rowNum}: name is required`); skipped++; continue; }
    try {
      await db.run(`
        INSERT INTO customers (customer_code, name, contact_person, phone, email, billing_address, shipping_address, gst_no, notes,
          country_of_destination, port_of_loading, port_of_discharge, final_destination)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(customer_code) DO UPDATE SET
          name                   = EXCLUDED.name,
          contact_person         = EXCLUDED.contact_person,
          phone                  = EXCLUDED.phone,
          email                  = EXCLUDED.email,
          billing_address        = EXCLUDED.billing_address,
          shipping_address       = EXCLUDED.shipping_address,
          gst_no                 = EXCLUDED.gst_no,
          notes                  = EXCLUDED.notes,
          country_of_destination = EXCLUDED.country_of_destination,
          port_of_loading        = EXCLUDED.port_of_loading,
          port_of_discharge      = EXCLUDED.port_of_discharge,
          final_destination      = EXCLUDED.final_destination
      `, [
        str(row.customer_code), str(row.name),
        strOrNull(row.contact_person), strOrNull(row.phone), strOrNull(row.email),
        strOrNull(row.billing_address), strOrNull(row.shipping_address), strOrNull(row.gst_no),
        strOrNull(row.notes), strOrNull(row.country_of_destination), strOrNull(row.port_of_loading),
        strOrNull(row.port_of_discharge), strOrNull(row.final_destination),
      ]);
      imported++;
    } catch (e) {
      errors.push(`Row ${rowNum}: ${e.message}`);
      skipped++;
    }
  }

  res.json({ imported, skipped, errors, total: rows.length });
});

// ─── SUPPLIERS ────────────────────────────────────────────────────────────────

router.get('/suppliers/template', authenticate, (req, res) => {
  sendTemplate(res,
    ['supplier_code', 'name', 'contact_person', 'phone', 'email', 'address', 'notes'],
    'suppliers_template.xlsx');
});

router.post('/suppliers', authenticate, authorize('owner', 'admin', 'accounts'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const db = getDB();
  let rows;
  try { ({ rows } = parseRows(req.file.buffer)); } catch { return res.status(400).json({ error: 'Invalid Excel file' }); }
  if (!rows.length) return res.json({ imported: 0, skipped: 0, errors: [], total: 0 });

  let imported = 0, skipped = 0;
  const errors = [];

  for (const [i, row] of rows.entries()) {
    const rowNum = i + 2;
    if (!str(row.name)) { errors.push(`Row ${rowNum}: name is required`); skipped++; continue; }
    try {
      const sc = strOrNull(row.supplier_code);
      const data = {
        name:           str(row.name),
        contact_person: strOrNull(row.contact_person),
        phone:          strOrNull(row.phone),
        email:          strOrNull(row.email),
        address:        strOrNull(row.address),
        notes:          strOrNull(row.notes),
      };
      if (sc) {
        const existing = await db.get('SELECT id FROM suppliers WHERE supplier_code=$1', [sc]);
        if (existing) {
          await db.run(
            `UPDATE suppliers SET name=$1, contact_person=$2, phone=$3, email=$4, address=$5, notes=$6 WHERE id=$7`,
            [data.name, data.contact_person, data.phone, data.email, data.address, data.notes, existing.id]
          );
        } else {
          await db.run(
            `INSERT INTO suppliers (supplier_code, name, contact_person, phone, email, address, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [sc, data.name, data.contact_person, data.phone, data.email, data.address, data.notes]
          );
        }
      } else {
        await db.run(
          `INSERT INTO suppliers (supplier_code, name, contact_person, phone, email, address, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [null, data.name, data.contact_person, data.phone, data.email, data.address, data.notes]
        );
      }
      imported++;
    } catch (e) {
      errors.push(`Row ${rowNum}: ${e.message}`);
      skipped++;
    }
  }

  res.json({ imported, skipped, errors, total: rows.length });
});

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────

router.get('/products/template', authenticate, (req, res) => {
  sendTemplate(res,
    ['product_code', 'name', 'category', 'description'],
    'products_template.xlsx');
});

router.post('/products', authenticate, authorize('admin', 'owner'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const db = getDB();
    let rows, headerRowIndex;
    try { ({ rows, headerRowIndex } = parseRows(req.file.buffer)); } catch (parseErr) {
      return res.status(400).json({ error: `Invalid Excel file: ${parseErr.message}` });
    }
    if (!rows.length) return res.json({ imported: 0, skipped: 0, imagesImported: 0, errors: [], total: 0 });

    // Extract any images embedded in the xlsx (keyed by 0-based data row index)
    const imageMap = extractXlsxImages(req.file.buffer, headerRowIndex);
    console.log(`[import/products] rows=${rows.length} imagesFound=${imageMap.size}`);

    let imported = 0, skipped = 0, imagesImported = 0;
    const errors = [];

    for (const [i, row] of rows.entries()) {
      const rowNum = i + 2;
      if (!str(row.product_code)) { errors.push(`Row ${rowNum}: product_code is required`); skipped++; continue; }
      if (!str(row.name))         { errors.push(`Row ${rowNum}: name is required`); skipped++; continue; }

      // Upload photo to Supabase Storage if this row has an embedded image
      let storagePath = null, photoFilename = null;
      const img = imageMap.get(i);
      if (img) {
        const safeName = str(row.product_code).replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `${Date.now()}_import_${safeName}.${img.ext}`;
        try {
          storagePath = await uploadToStorage('product-photos', filename, img.data, `image/${img.ext}`);
          photoFilename = filename;
          imagesImported++;
        } catch (uploadErr) {
          errors.push(`Row ${rowNum}: image upload failed — ${uploadErr.message}`);
        }
      }

      try {
        await db.run(`
          INSERT INTO products (product_code, name, category, description, photo_file, photo_original_name)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT(product_code) DO UPDATE SET
            name                = EXCLUDED.name,
            category            = EXCLUDED.category,
            description         = EXCLUDED.description,
            photo_file          = CASE WHEN EXCLUDED.photo_file IS NOT NULL
                                       THEN EXCLUDED.photo_file
                                       ELSE products.photo_file END,
            photo_original_name = CASE WHEN EXCLUDED.photo_original_name IS NOT NULL
                                       THEN EXCLUDED.photo_original_name
                                       ELSE products.photo_original_name END
        `, [
          str(row.product_code), str(row.name),
          strOrNull(row.category), strOrNull(row.description),
          storagePath, photoFilename,
        ]);
        imported++;
      } catch (e) {
        errors.push(`Row ${rowNum}: ${e.message}`);
        skipped++;
        // Roll back the uploaded image if the DB insert failed
        if (storagePath) {
          try { await deleteFromStorage(storagePath); } catch {}
          imagesImported--;
        }
      }
    }

    console.log(`[import/products] done: imported=${imported} skipped=${skipped} images=${imagesImported} errors=${errors.length}`);
    res.json({ imported, skipped, imagesImported, errors, total: rows.length });
  } catch (err) {
    console.error('[import/products] unhandled error:', err);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  }
});

// ─── INVENTORY ────────────────────────────────────────────────────────────────

router.get('/inventory/template', authenticate, (req, res) => {
  sendTemplate(res,
    ['item_code', 'name', 'category', 'unit', 'reorder_level', 'unit_cost', 'notes'],
    'inventory_template.xlsx');
});

router.post('/inventory', authenticate, authorize('accounts', 'owner'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const db = getDB();
  let rows;
  try { ({ rows } = parseRows(req.file.buffer)); } catch { return res.status(400).json({ error: 'Invalid Excel file' }); }
  if (!rows.length) return res.json({ imported: 0, skipped: 0, errors: [], total: 0 });

  let imported = 0, skipped = 0;
  const errors = [];

  for (const [i, row] of rows.entries()) {
    const rowNum = i + 2;
    if (!str(row.item_code)) { errors.push(`Row ${rowNum}: item_code is required`); skipped++; continue; }
    if (!str(row.name))      { errors.push(`Row ${rowNum}: name is required`); skipped++; continue; }
    if (!str(row.unit))      { errors.push(`Row ${rowNum}: unit is required`); skipped++; continue; }
    try {
      await db.run(`
        INSERT INTO inventory_items (item_code, name, category, unit, reorder_level, unit_cost, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(item_code) DO UPDATE SET
          name          = EXCLUDED.name,
          category      = EXCLUDED.category,
          unit          = EXCLUDED.unit,
          reorder_level = EXCLUDED.reorder_level,
          unit_cost     = EXCLUDED.unit_cost,
          notes         = EXCLUDED.notes
      `, [
        str(row.item_code), str(row.name),
        strOrNull(row.category), str(row.unit),
        numOrDefault(row.reorder_level), numOrDefault(row.unit_cost),
        strOrNull(row.notes), req.user.id,
      ]);
      imported++;
    } catch (e) {
      errors.push(`Row ${rowNum}: ${e.message}`);
      skipped++;
    }
  }

  res.json({ imported, skipped, errors, total: rows.length });
});

module.exports = router;
