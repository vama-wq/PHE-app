require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
// Force IPv4 DNS resolution — Railway/Node 22 defaults to IPv6 which can't reach Supabase
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: [
    process.env.CLIENT_URL || 'http://localhost:5173',
    /^http:\/\/192\.168\./,
    /^http:\/\/10\./,
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Serve uploaded files via Supabase Storage proxy ──────────────────────────
// Maintains backward compat: frontend still uses /uploads/folder/filename URLs
app.get('/uploads/*', async (req, res) => {
  const storagePath = req.params[0]; // e.g. 'product-photos/1234_img.jpg'
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await supabase.storage.from('phe-uploads').download(storagePath);
    if (error || !data) return res.status(404).send('File not found');
    const buf = Buffer.from(await data.arrayBuffer());
    res.set('Content-Type', data.type || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (err) {
    res.status(500).send('Error fetching file');
  }
});

app.use('/api/auth',            require('./routes/auth'));
app.use('/api/customers',       require('./routes/customers'));
app.use('/api/products',        require('./routes/products'));
app.use('/api/orders',          require('./routes/orders'));
app.use('/api/job-cards',       require('./routes/jobCards'));
app.use('/api/inventory',       require('./routes/inventory'));
app.use('/api/drawings',        require('./routes/drawings'));
app.use('/api/production',      require('./routes/production'));
app.use('/api/dispatch',        require('./routes/dispatch'));
app.use('/api/activity',        require('./routes/activity'));
app.use('/api/qc',              require('./routes/qc'));
app.use('/api/suppliers',       require('./routes/suppliers'));
app.use('/api/purchase-orders', require('./routes/purchaseOrders'));
app.use('/api/export',          require('./routes/export'));
app.use('/api/reports',         require('./routes/reports'));
app.use('/api/import',          require('./routes/import'));
app.use('/api/finished-goods',  require('./routes/finishedGoods'));
app.use('/api/customer-queries', require('./routes/customerQueries'));
app.use('/api/notifications',    require('./routes/notifications'));

// Serve React client in production
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Init DB then start listening
initDB()
  .then(() => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`\nPHE Server running at http://localhost:${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV}`);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n⚠️  Port ${PORT} is already in use.`);
        process.exit(1);
      } else throw err;
    });
  })
  .catch((err) => {
    console.error('Failed to connect to database:', err.message);
    process.exit(1);
  });
