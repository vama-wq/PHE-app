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
async function uploadToStorage(folder, filename, buffer, mimetype) {
  const storagePath = `${folder}/${filename}`;
  const supabase = getSupabase();
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType: mimetype || 'application/octet-stream', upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return storagePath;
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

// Generate a public URL for a stored file.
function getPublicUrl(storagePath) {
  if (!storagePath) return null;
  const supabase = getSupabase();
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data?.publicUrl || null;
}

// All multer instances use memoryStorage — files are then pushed to Supabase Storage
// by route handlers (or via the postUpload middleware below).
const memStorage = multer.memoryStorage();

const allowedTypes  = /pdf|jpg|jpeg|png|gif|webp/;
const imageOnlyTypes = /jpg|jpeg|png|gif|webp/;

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  allowedTypes.test(ext) ? cb(null, true) : cb(new Error('Only PDF and image files are allowed'));
}
function imageOnlyFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  imageOnlyTypes.test(ext) ? cb(null, true) : cb(new Error('Only image files (JPG, PNG, GIF, WebP) are allowed'));
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
        const ts = Date.now();
        const safe = f.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        f.filename = `${ts}_${safe}`;
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
  chatAttachment:  makeUploader('chat-attachments',   fileFilter, 10),
};

// Export multer + push middleware pairs, matching the old named-export API
module.exports = {
  uploadQuotation:       [uploaders.quotation.upload.single('file'),       uploaders.quotation.pushToStorage],
  uploadDrawing:         [uploaders.drawing.upload.single('file'),          uploaders.drawing.pushToStorage],
  uploadPackage:         [uploaders.package.upload.single('file'),          uploaders.package.pushToStorage],
  uploadDispatch:        [uploaders.dispatch.upload.single('file'),         uploaders.dispatch.pushToStorage],
  uploadQC:              [uploaders.qc.upload.single('file'),               uploaders.qc.pushToStorage],
  uploadOrderDrawing:    [uploaders.orderDrawing.upload.single('file'),     uploaders.orderDrawing.pushToStorage],
  uploadOrderItemImage:  [uploaders.orderItemImage.upload.array('images',10), uploaders.orderItemImage.pushToStorage],
  uploadJobCard:         [uploaders.jobCard.upload.single('file'),          uploaders.jobCard.pushToStorage],
  uploadChecklistPhoto:  [uploaders.checklistPhoto.upload.single('file'),   uploaders.checklistPhoto.pushToStorage],
  uploadRejectionPhoto:  [uploaders.rejectionPhoto.upload.single('file'),   uploaders.rejectionPhoto.pushToStorage],
  uploadProductPhoto:    [uploaders.productPhoto.upload.single('photo'),    uploaders.productPhoto.pushToStorage],
  uploadItemDrawing:     [uploaders.itemDrawing.upload.single('drawing'),   uploaders.itemDrawing.pushToStorage],
  uploadPurchaseQC:      [uploaders.purchaseQC.upload.single('report'),     uploaders.purchaseQC.pushToStorage],
  uploadChatAttachments: [uploaders.chatAttachment.upload.array('attachments', 5), uploaders.chatAttachment.pushToStorage],

  // Utilities for route handlers
  uploadToStorage,
  deleteFromStorage,
  getPublicUrl,
  BUCKET,
};
