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

  // Build normalised header names:
  // trim, lowercase, replace spaces/hyphens with underscores
  // e.g. "Customer Code" → "customer_code", "GST No." → "gst_no"
  const headers = (raw[headerRowIndex] || []).map(h =>
    h !== null && h !== undefined
      ? String(h).trim().toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^a-z0-9_]/g, '')
      : ''
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

// Return the first non-empty value among a list of possible header keys.
// Lets imports tolerate natural header variants, e.g. "minimum order qty"
// (normalised to minimum_order_qty) mapping to the expected min_order_qty.
function pick(row, aliases) {
  for (const a of aliases) {
    if (row[a] != null && String(row[a]).trim() !== '') return row[a];
  }
  return '';
}

// Extract cell hyperlinks for a column (matched by normalised header name),
// keyed by 0-based data-row index. Used to pull drawings that are stored as
// Google Drive links (chips) rather than embedded images.
function extractColumnHyperlinks(buffer, headerName, headerRowIndex = 0) {
  const map = new Map();
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws || !ws['!ref']) return map;
    const range = XLSX.utils.decode_range(ws['!ref']);
    let colIdx = -1;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ c, r: headerRowIndex })];
      if (!cell) continue;
      const norm = String(cell.v).trim().toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^a-z0-9_]/g, '');
      if (norm === headerName) { colIdx = c; break; }
    }
    if (colIdx === -1) return map;
    for (let r = headerRowIndex + 1; r <= range.e.r; r++) {
      const cell = ws[XLSX.utils.encode_cell({ c: colIdx, r })];
      if (cell && cell.l && cell.l.Target) map.set(r - headerRowIndex - 1, cell.l.Target);
    }
  } catch (e) {
    console.error('[import] hyperlink extraction error:', e.message);
  }
  return map;
}

// Pull the Drive file id out of a share/view URL.
function driveFileId(url) {
  if (!url) return null;
  const m = String(url).match(/\/d\/([^/]+)/) || String(url).match(/[?&]id=([^&]+)/);
  return m ? m[1] : null;
}

// Download a publicly-shared Google Drive file by id. Detects type from the
// file's magic bytes. Throws a clear error if the file isn't public.
async function fetchDriveFile(fileId) {
  const url = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.slice(0, 4).toString() === '%PDF')                 return { data, ext: 'pdf', mime: 'application/pdf' };
  if (data.slice(0, 3).toString('hex') === 'ffd8ff')          return { data, ext: 'jpg', mime: 'image/jpeg' };
  if (data.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return { data, ext: 'png', mime: 'image/png' };
  const head = data.slice(0, 64).toString().toLowerCase();
  if (head.includes('<!doctype') || head.includes('<html')) {
    throw new Error('file is not publicly shared (Drive returned a web page, not the file)');
  }
  return { data, ext: 'bin', mime: 'application/octet-stream' };
}

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

    // Upload all images in parallel first (much faster than sequential)
    const uploadedImages = new Map(); // rowIndex → { storagePath, photoFilename }
    const uploadTasks = [];
    for (const [i, row] of rows.entries()) {
      const img = imageMap.get(i);
      if (!img) continue;
      const safeName = str(row.product_code).replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `${Date.now()}_${i}_import_${safeName}.${img.ext}`;
      uploadTasks.push(
        uploadToStorage('product-photos', filename, img.data, `image/${img.ext}`)
          .then(storagePath => { uploadedImages.set(i, { storagePath, photoFilename: filename }); })
          .catch(uploadErr => { errors.push(`Row ${i + 2}: image upload failed — ${uploadErr.message}`); })
      );
    }
    await Promise.all(uploadTasks);
    imagesImported = uploadedImages.size;
    console.log(`[import/products] parallel image uploads done: ${imagesImported}/${imageMap.size}`);

    for (const [i, row] of rows.entries()) {
      const rowNum = i + 2;
      if (!str(row.product_code)) { errors.push(`Row ${rowNum}: product_code is required`); skipped++; continue; }
      if (!str(row.name))         { errors.push(`Row ${rowNum}: name is required`); skipped++; continue; }

      const { storagePath = null, photoFilename = null } = uploadedImages.get(i) || {};

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
    ['item_code', 'name', 'category', 'unit', 'reorder_level', 'min_order_qty', 'unit_cost', 'notes', 'drawing'],
    'inventory_template.xlsx');
});

router.post('/inventory', authenticate, authorize('accounts', 'owner'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const db = getDB();
    let rows, headerRowIndex;
    try { ({ rows, headerRowIndex } = parseRows(req.file.buffer)); } catch (parseErr) {
      return res.status(400).json({ error: `Invalid Excel file: ${parseErr.message}` });
    }
    if (!rows.length) return res.json({ imported: 0, skipped: 0, drawingsImported: 0, errors: [], total: 0 });

    const imageMap = extractXlsxImages(req.file.buffer, headerRowIndex);
    console.log(`[import/inventory] rows=${rows.length} drawingsFound=${imageMap.size}`);

    let imported = 0, skipped = 0, drawingsImported = 0;
    const errors = [];

    const uploadedDrawings = new Map();
    const uploadTasks = [];
    for (const [i, row] of rows.entries()) {
      const img = imageMap.get(i);
      if (!img) continue;
      const safeName = str(row.item_code).replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `${Date.now()}_${i}_import_${safeName}.${img.ext}`;
      uploadTasks.push(
        uploadToStorage('item-drawings', filename, img.data, `image/${img.ext}`)
          .then(storagePath => { uploadedDrawings.set(i, { storagePath, filename }); })
          .catch(uploadErr => { errors.push(`Row ${i + 2}: drawing upload failed — ${uploadErr.message}`); })
      );
    }
    await Promise.all(uploadTasks);

    // Drawings can also be supplied as Google Drive links (chips) in the
    // "drawing" column. Fetch each distinct file once (many items may share a
    // drawing), upload it, then assign to every row that references it.
    const linkMap = extractColumnHyperlinks(req.file.buffer, 'drawing', headerRowIndex);
    const distinctIds = new Map(); // fileId -> first row index (for naming)
    for (const [i, url] of linkMap) {
      if (uploadedDrawings.has(i)) continue; // embedded image wins
      const fid = driveFileId(url);
      if (fid && !distinctIds.has(fid)) distinctIds.set(fid, i);
    }
    const fetchedByFileId = new Map(); // fileId -> { storagePath, filename }
    const idEntries = [...distinctIds.entries()];
    const CONCURRENCY = 8;
    for (let start = 0; start < idEntries.length; start += CONCURRENCY) {
      await Promise.all(idEntries.slice(start, start + CONCURRENCY).map(async ([fid, i]) => {
        try {
          const f = await fetchDriveFile(fid);
          const safeName = str(rows[i].item_code).replace(/[^a-zA-Z0-9]/g, '_');
          const storeName = `${Date.now()}_drive_${safeName}_${fid.slice(0, 8)}.${f.ext}`;
          const storagePath = await uploadToStorage('item-drawings', storeName, f.data, f.mime);
          fetchedByFileId.set(fid, { storagePath, filename: `${str(rows[i].item_code)}.${f.ext}` });
        } catch (e) {
          errors.push(`Drawing for ${rows[i].item_code}: ${e.message}`);
        }
      }));
    }
    for (const [i, url] of linkMap) {
      if (uploadedDrawings.has(i)) continue;
      const got = fetchedByFileId.get(driveFileId(url));
      if (got) uploadedDrawings.set(i, got);
    }

    drawingsImported = uploadedDrawings.size;
    console.log(`[import/inventory] drawings: embedded=${imageMap.size} driveLinks=${linkMap.size} distinctDriveFiles=${distinctIds.size} totalAttached=${drawingsImported}`);

    for (const [i, row] of rows.entries()) {
      const rowNum = i + 2;
      if (!str(row.item_code)) { errors.push(`Row ${rowNum}: item_code is required`); skipped++; continue; }
      if (!str(row.name))      { errors.push(`Row ${rowNum}: name is required`); skipped++; continue; }
      if (!str(row.unit))      { errors.push(`Row ${rowNum}: unit is required`); skipped++; continue; }

      const { storagePath = null, filename: drawingFilename = null } = uploadedDrawings.get(i) || {};

      try {
        await db.run(`
          INSERT INTO inventory_items (item_code, name, category, unit, reorder_level, min_order_qty, unit_cost, notes, drawing_file, drawing_original_name, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT(item_code) DO UPDATE SET
            name                  = EXCLUDED.name,
            category              = EXCLUDED.category,
            unit                  = EXCLUDED.unit,
            reorder_level         = EXCLUDED.reorder_level,
            min_order_qty         = EXCLUDED.min_order_qty,
            unit_cost             = EXCLUDED.unit_cost,
            notes                 = EXCLUDED.notes,
            drawing_file          = CASE WHEN EXCLUDED.drawing_file IS NOT NULL
                                         THEN EXCLUDED.drawing_file
                                         ELSE inventory_items.drawing_file END,
            drawing_original_name = CASE WHEN EXCLUDED.drawing_original_name IS NOT NULL
                                         THEN EXCLUDED.drawing_original_name
                                         ELSE inventory_items.drawing_original_name END
        `, [
          str(row.item_code), str(row.name),
          strOrNull(row.category), str(row.unit),
          numOrDefault(pick(row, ['reorder_level', 'reorder', 're_order_level', 'reorder_qty'])),
          numOrDefault(pick(row, ['min_order_qty', 'minimum_order_qty', 'minimum_order_quantity', 'min_order_quantity', 'moq'])),
          numOrDefault(pick(row, ['unit_cost', 'unit__cost', 'unitcost', 'cost', 'rate', 'price'])),
          strOrNull(row.notes),
          storagePath, drawingFilename,
          req.user.id,
        ]);
        imported++;
      } catch (e) {
        errors.push(`Row ${rowNum}: ${e.message}`);
        skipped++;
        if (storagePath) {
          try { await deleteFromStorage(storagePath); } catch {}
          drawingsImported--;
        }
      }
    }

    console.log(`[import/inventory] done: imported=${imported} skipped=${skipped} drawings=${drawingsImported} errors=${errors.length}`);
    res.json({ imported, skipped, drawingsImported, errors, total: rows.length });
  } catch (err) {
    console.error('[import/inventory] unhandled error:', err);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  }
});

// ─── FINISHED GOODS ───────────────────────────────────────────────────────────

router.get('/finished-goods/template', authenticate, (req, res) => {
  sendTemplate(res,
    ['drawing_no', 'tube_material', 'tube_diameter_mm', 'wattage_w', 'voltage_v', 'plating_instructions', 'qty_available', 'notes'],
    'finished_goods_template.xlsx');
});

router.post('/finished-goods', authenticate, authorize('owner', 'admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const db = getDB();
  let rows;
  try { ({ rows } = parseRows(req.file.buffer)); } catch { return res.status(400).json({ error: 'Invalid Excel file' }); }
  if (!rows.length) return res.json({ imported: 0, skipped: 0, errors: [], total: 0 });

  let imported = 0, skipped = 0;
  const errors = [];

  for (const [i, row] of rows.entries()) {
    const rowNum = i + 2;
    const drawingNo = str(row.drawing_no);
    if (!drawingNo) { errors.push(`Row ${rowNum}: drawing_no is required`); skipped++; continue; }
    const qty = parseInt(row.qty_available);
    if (!qty || qty <= 0) { errors.push(`Row ${rowNum}: qty_available must be a positive number`); skipped++; continue; }

    // Strip trailing job-card suffix to get base drawing no
    const baseDrawingNo = drawingNo.replace(/-\d+$/, '');

    try {
      // Check if a FG entry already exists for this base drawing no
      let fg = await db.get('SELECT * FROM finished_goods WHERE base_drawing_no=$1', [baseDrawingNo]);

      if (fg) {
        // Update specs if provided, add to qty
        await db.run(`
          UPDATE finished_goods SET
            tube_material        = COALESCE($1, tube_material),
            tube_diameter        = COALESCE($2, tube_diameter),
            wattage              = COALESCE($3, wattage),
            voltage              = COALESCE($4, voltage),
            plating_instructions = COALESCE($5, plating_instructions),
            notes                = COALESCE($6, notes),
            qty_in               = qty_in + $7,
            qty_available        = qty_available + $7
          WHERE id=$8
        `, [
          strOrNull(row.tube_material),
          strOrNull(row.tube_diameter_mm),
          strOrNull(row.wattage_w),
          strOrNull(row.voltage_v),
          strOrNull(row.plating_instructions),
          strOrNull(row.notes),
          qty, fg.id,
        ]);
      } else {
        // Create new FG entry
        const { lastInsertRowid } = await db.insert(`
          INSERT INTO finished_goods
            (drawing_no, base_drawing_no, tube_material, tube_diameter, wattage, voltage,
             plating_instructions, qty_in, qty_available, notes, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [
          baseDrawingNo, baseDrawingNo,
          strOrNull(row.tube_material),
          strOrNull(row.tube_diameter_mm),
          strOrNull(row.wattage_w),
          strOrNull(row.voltage_v),
          strOrNull(row.plating_instructions),
          qty, qty,
          strOrNull(row.notes),
          req.user.id,
        ]);
        fg = { id: lastInsertRowid };
      }

      // Log the inward movement as Opening Stock
      await db.insert(`
        INSERT INTO finished_goods_log
          (finished_good_id, movement_type, qty, reference, notes, created_by)
        VALUES ($1,'inward',$2,'Opening Stock',$3,$4)
      `, [fg.id, qty, strOrNull(row.notes), req.user.id]);

      imported++;
    } catch (e) {
      errors.push(`Row ${rowNum}: ${e.message}`);
      skipped++;
    }
  }

  res.json({ imported, skipped, errors, total: rows.length });
});

module.exports = router;
