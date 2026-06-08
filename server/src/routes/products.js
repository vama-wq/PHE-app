const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadProductPhoto, deleteFromStorage } = require('../middleware/upload');

router.get('/', authenticate, async (req, res) => {
  res.json(await getDB().all('SELECT * FROM products ORDER BY product_code'));
});

router.get('/:id', authenticate, async (req, res) => {
  const p = await getDB().get('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

router.post('/', authenticate, authorize('admin', 'owner'), ...uploadProductPhoto, async (req, res) => {
  const { product_code, name, description, category } = req.body;
  if (!product_code || !name) return res.status(400).json({ error: 'Code and name required' });
  try {
    const r = await getDB().insert(
      `INSERT INTO products (product_code, name, description, category, photo_file, photo_original_name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [product_code, name, description||null, category||null,
       req.file?.storagePath || null, req.file?.originalname || null, req.user.id]
    );
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Product code already exists' });
    throw e;
  }
});

router.put('/:id', authenticate, authorize('admin', 'owner'), ...uploadProductPhoto, async (req, res) => {
  const { product_code, name, description, category } = req.body;
  const db = getDB();

  // Check if code is being changed to one that already exists (different product)
  const existing = await db.get('SELECT id FROM products WHERE product_code=$1 AND id!=$2', [product_code, req.params.id]);
  if (existing) return res.status(409).json({ error: 'Product code already exists' });

  try {
    if (req.file) {
      // Delete old photo from Supabase Storage
      const old = await db.get('SELECT photo_file FROM products WHERE id=$1', [req.params.id]);
      if (old?.photo_file) await deleteFromStorage(old.photo_file);

      await db.run(
        'UPDATE products SET product_code=$1, name=$2, description=$3, category=$4, photo_file=$5, photo_original_name=$6 WHERE id=$7',
        [product_code, name, description||null, category||null, req.file.storagePath, req.file.originalname, req.params.id]
      );
    } else {
      await db.run(
        'UPDATE products SET product_code=$1, name=$2, description=$3, category=$4 WHERE id=$5',
        [product_code, name, description||null, category||null, req.params.id]
      );
    }
    res.json({ message: 'Updated' });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Product code already exists' });
    throw e;
  }
});

router.delete('/:id', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const db = getDB();
  const p = await db.get('SELECT photo_file FROM products WHERE id=$1', [req.params.id]);
  if (p?.photo_file) await deleteFromStorage(p.photo_file);
  await db.run('DELETE FROM products WHERE id=$1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

module.exports = router;
