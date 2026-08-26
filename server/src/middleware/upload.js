const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// All uploads go to Supabase Storage (single bucket, folder-per-type)
const BUCKET = 'phe-uploads';

let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return _supabase;
}

// Upload a buffer to Supabase Storage. Returns the storage path.
// Supabase storage occasionally throws a transient 5xx (its API reports these
// with message "<none>"), which used to fail the user's whole form on the
// first try. Retry a couple of times before giving up — upsert:true makes a
// repeat of a half-landed attempt safe.
async function uploadToStorage(folder, filename, buffer, mimetype) {
  const storagePath = `${folder}/${filename}`;
  const supabase = getSupabase();
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, buffer, { contentType: mimetype || 'application/octet-stream', upsert: true });
    if (!error) return storagePath;
    lastError = error;
    console.error(`Storage upload attempt ${attempt}/3 failed for ${storagePath}: ${error.message}` +
      (error.status || error.statusCode ? ` (status ${error.status || error.statusCode})` : ''));
    if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 700));
  }
  throw new Error(`Storage upload failed: ${lastError.message}` +
    (lastError.status || lastError.statusCode ? ` (status ${lastError.status || lastError.statusCode})` : '') +
    ' — please try again');
}

// Delete a file from Supabase Storage by its storage path.
async function deleteFromStorage(storagePath) {
  if (!storagePath) return;
  try {
    const supabase = getSupabase();
    await supabase.storage.from(BUCKET).remove([storagePath]);
  } catch (err) {
    console.error('deleteFromStorage error:', err.message);
  }
}

// Download a stored file's bytes as a Buffer (e.g. to re-parse an ESSL PDF).
async function downloadFromStorage(storagePath) {
  if (!storagePath) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error || !data) throw new Error(`Storage download failed: ${error?.message || 'not found'}`);
  return Buffer.from(await data.arrayBuffer());
}

// Generate a public URL for a stored file.
function getPublicUrl(storagePath) {
  if (!storagePath) return null;
  const supabase = getSupabase();
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data?.publicUrl || null;
}

// Server-side copy of an existing stored file to a new path within the bucket
// (no download/re-upload). Returns the new storage path.
async function copyInStorage(fromPath, toFolder, newFilename) {
  if (!fromPath) return null;
  const supabase = getSupabase();
  const toPath = `${toFolder}/${newFilename}`;
  const { error } = await supabase.storage.from(BUCKET).copy(fromPath, toPath);
  if (error) throw new Error(`Storage copy failed: ${error.message}`);
  return toPath;
}

// Storage object keys inherit the uploaded filename. Phone shares can carry
// ~270-char names, which exceed macOS's 255-byte filename cap and broke the
// local backup mirror for a week — cap the base name, keep the extension.
function storageFilename(originalname) {
  const safe = originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const ext = path.extname(safe).slice(0, 20);
  const base = path.basename(safe, ext);
  const capped = base.length > 100 ? base.slice(0, 100) : base;
  return `${Date.now()}_${capped}${ext}`;
}

// All multer instances use memoryStorage — files are then pushed to Supabase Storage
// by route handlers (or via the postUpload middleware below).
const memStorage = multer.memoryStorage();

const allowedExts  = /pdf|jpg|jpeg|png|gif|webp|heic|heif|doc|docx|xls|xlsx/;
const allowedMimes = /^(image\/|application\/pdf|application\/msword|application\/vnd\.openxmlformats)/;
const imageExts    = /jpg|jpeg|png|gif|webp|heic|heif/;
const imageMimes   = /^image\//;

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  if (allowedExts.test(ext) || allowedMimes.test(file.mimetype)) return cb(null, true);
  cb(new Error('Only PDF, image, and document files are allowed'));
}
function imageOnlyFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  if (imageExts.test(ext) || imageMimes.test(file.mimetype)) return cb(null, true);
  cb(new Error('Only image files (JPG, PNG, GIF, WebP) are allowed'));
}

// Factory: returns multer instance + a post-upload middleware that pushes to Supabase Storage.
// After the middleware chain runs, req.file will have:
//   .filename      — generated filename  (e.g. 1712345678_foo.jpg)
//   .storagePath   — Supabase path       (e.g. product-photos/1712345678_foo.jpg)
//   .originalname  — untouched
function makeUploader(folder, filter, maxSizeMB = 20) {
  const upload = multer({ storage: memStorage, fileFilter: filter, limits: { fileSize: maxSizeMB * 1024 * 1024 } });

  async function pushToStorage(req, res, next) {
    if (!req.file && !(req.files?.length)) return next();
    const files = req.files?.length ? req.files : [req.file];
    try {
      for (const f of files) {
        f.filename = storageFilename(f.originalname);
        f.storagePath = await uploadToStorage(folder, f.filename, f.buffer, f.mimetype);
        f.path = f.storagePath; // backward compat — routes use req.file.path in some places
      }
      // restore single file ref
      if (!req.files?.length) req.file = files[0];
    } catch (err) {
      return next(err);
    }
    next();
  }

  return { upload, pushToStorage };
}

// Build named uploaders
const uploaders = {
  quotation:       makeUploader('quotations',        fileFilter),
  drawing:         makeUploader('drawings',           fileFilter),
  package:         makeUploader('packages',           fileFilter),
  dispatch:        makeUploader('dispatch',           fileFilter),
  qc:              makeUploader('qc',                 fileFilter),
  orderDrawing:    makeUploader('order-drawings',     fileFilter),
  orderItemImage:  makeUploader('item-images',        imageOnlyFilter),
  jobCard:         makeUploader('job-cards',          fileFilter),
  checklistPhoto:  makeUploader('checklist-photos',   imageOnlyFilter, 10),
  rejectionPhoto:  makeUploader('rejection-photos',   imageOnlyFilter, 10),
  productPhoto:    makeUploader('product-photos',     imageOnlyFilter, 10),
  itemDrawing:     makeUploader('item-drawings',      fileFilter),
  purchaseQC:      makeUploader('purchase-qc',        fileFilter),
  purchaseInvoice: makeUploader('purchase-invoices',  fileFilter),
  purchaseItemQC:  makeUploader('purchase-qc',        imageOnlyFilter),
  chatAttachment:  makeUploader('chat-attachments',   fileFilter, 10),
  pettyCashReceipt: makeUploader('petty-cash',        fileFilter),
  esslReport:      makeUploader('essl-reports',       fileFilter, 25),
  debitNote:       makeUploader('debit-notes',        fileFilter),
  capaPhoto:       makeUploader('capa-photos',        imageOnlyFilter, 10),
};

// Purchase-item QC takes TWO groups in one request: the material image plus
// rejection photos (compulsory for any rejected qty). multer .fields() puts
// them in req.files as an object, so the standard array push doesn't apply.
const purchaseItemQCFields = uploaders.purchaseItemQC.upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'rejection_photos', maxCount: 10 },
]);
async function pushPurchaseItemQCFields(req, res, next) {
  const groups = req.files || {};
  const all = [...(groups.image || []), ...(groups.rejection_photos || [])];
  try {
    for (const f of all) {
      f.filename = storageFilename(f.originalname);
      f.storagePath = await uploadToStorage('purchase-qc', f.filename, f.buffer, f.mimetype);
      f.path = f.storagePath;
    }
  } catch (err) { return next(err); }
  next();
}

// Receiving a PO item takes TWO documents: the supplier's invoice and the PO
// copy that came with the goods. .fields() puts them in req.files as an object.
const purchaseReceiveFields = uploaders.purchaseInvoice.upload.fields([
  { name: 'invoice', maxCount: 1 },
  { name: 'po_document', maxCount: 1 },
]);
async function pushPurchaseReceiveFields(req, res, next) {
  const groups = req.files || {};
  const all = [...(groups.invoice || []), ...(groups.po_document || [])];
  try {
    for (const f of all) {
      f.filename = storageFilename(f.originalname);
      f.storagePath = await uploadToStorage('purchase-invoices', f.filename, f.buffer, f.mimetype);
      f.path = f.storagePath;
    }
  } catch (err) { return next(err); }
  next();
}

// Export multer + push middleware pairs, matching the old named-export API
module.exports = {
  uploadQuotation:       [uploaders.quotation.upload.single('file'),       uploaders.quotation.pushToStorage],
  uploadDrawing:         [uploaders.drawing.upload.single('file'),          uploaders.drawing.pushToStorage],
  uploadPackage:         [uploaders.package.upload.single('file'),          uploaders.package.pushToStorage],
  uploadDispatch:        [uploaders.dispatch.upload.single('file'),         uploaders.dispatch.pushToStorage],
  uploadQC:              [uploaders.qc.upload.single('file'),               uploaders.qc.pushToStorage],
  uploadOrderDrawing:    [uploaders.orderDrawing.upload.single('file'),     uploaders.orderDrawing.pushToStorage],
  uploadOrderItemImage:  [uploaders.orderItemImage.upload.array('images',40), uploaders.orderItemImage.pushToStorage],
  uploadJobCard:         [uploaders.jobCard.upload.single('file'),          uploaders.jobCard.pushToStorage],
  uploadChecklistPhoto:  [uploaders.checklistPhoto.upload.single('file'),   uploaders.checklistPhoto.pushToStorage],
  uploadRejectionPhoto:  [uploaders.rejectionPhoto.upload.single('file'),   uploaders.rejectionPhoto.pushToStorage],
  uploadProductPhoto:    [uploaders.productPhoto.upload.single('photo'),    uploaders.productPhoto.pushToStorage],
  uploadItemDrawing:     [uploaders.itemDrawing.upload.single('drawing'),   uploaders.itemDrawing.pushToStorage],
  uploadPurchaseQC:      [uploaders.purchaseQC.upload.single('report'),     uploaders.purchaseQC.pushToStorage],
  uploadPettyCashReceipt: [uploaders.pettyCashReceipt.upload.single('receipt'), uploaders.pettyCashReceipt.pushToStorage],
  uploadEsslReport:      [uploaders.esslReport.upload.single('essl'),           uploaders.esslReport.pushToStorage],
  uploadPurchaseInvoice: [uploaders.purchaseInvoice.upload.single('invoice'), uploaders.purchaseInvoice.pushToStorage],
  uploadPurchaseReceive: [purchaseReceiveFields, pushPurchaseReceiveFields],
  uploadPurchaseItemQC:  [uploaders.purchaseItemQC.upload.single('image'),   uploaders.purchaseItemQC.pushToStorage],
  uploadPurchaseItemQCFields: [purchaseItemQCFields, pushPurchaseItemQCFields],
  uploadDebitNote:       [uploaders.debitNote.upload.single('file'),         uploaders.debitNote.pushToStorage],
  uploadChatAttachments: [uploaders.chatAttachment.upload.array('attachments', 5), uploaders.chatAttachment.pushToStorage],
  uploadCapaPhotos:      [uploaders.capaPhoto.upload.array('photos', 6), uploaders.capaPhoto.pushToStorage],

  // Utilities for route handlers
  uploadToStorage,
  deleteFromStorage,
  downloadFromStorage,
  getPublicUrl,
  copyInStorage,
  BUCKET,
};
