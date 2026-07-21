-- PHE App — PostgreSQL Schema
-- Run this in the Supabase SQL Editor (Database → SQL Editor → New query)

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','accounts','design','production','owner')),
  force_password_change INTEGER DEFAULT 1,
  permitted_modules TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  customer_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  billing_address TEXT,
  shipping_address TEXT,
  gst_no TEXT,
  country_of_destination TEXT,
  port_of_loading TEXT,
  port_of_discharge TEXT,
  final_destination TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  product_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  photo_file TEXT,
  photo_original_name TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inquiries (
  id SERIAL PRIMARY KEY,
  inquiry_code TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  description TEXT,
  is_custom_design INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open' CHECK(status IN ('open','quotation_sent','order_received','lost')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_code TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  inquiry_id INTEGER REFERENCES inquiries(id),
  order_date DATE NOT NULL,
  dispatch_date DATE,
  status TEXT DEFAULT 'pending_approval' CHECK(status IN (
    'pending_approval','approved','rejected',
    'job_card_created','in_progress','qc_pending',
    'qc_approved','packaging','dispatched','on_hold'
  )),
  rejection_reason TEXT,
  notes TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quotations (
  id SERIAL PRIMARY KEY,
  inquiry_id INTEGER REFERENCES inquiries(id),
  order_id INTEGER REFERENCES orders(id),
  file_path TEXT,
  file_name TEXT,
  sent_date DATE,
  notes TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_cards (
  id SERIAL PRIMARY KEY,
  job_card_no TEXT UNIQUE NOT NULL,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  file_path TEXT,
  file_name TEXT,
  original_name TEXT,
  qty INTEGER,
  dispatch_date DATE NOT NULL,
  current_stage INTEGER DEFAULT 0,
  punching TEXT,
  drawing_no TEXT,
  product_name TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN (
    'pending','in_progress','on_hold','qc_pending','qc_approved','completed','dispatched'
  )),
  notes TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_card_assemblies (
  id SERIAL PRIMARY KEY,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  assembly_no INTEGER NOT NULL,
  wattage_actual DOUBLE PRECISION,
  voltage_actual DOUBLE PRECISION,
  tube_material TEXT,
  tube_diameter_mm DOUBLE PRECISION,
  tube_length_val1 DOUBLE PRECISION,
  tube_length_val2 DOUBLE PRECISION,
  tube_length_val3 DOUBLE PRECISION,
  tube_length_val4 DOUBLE PRECISION,
  tube_cutting_val1 DOUBLE PRECISION,
  tube_cutting_val2 DOUBLE PRECISION,
  tube_cutting_unit TEXT DEFAULT 'mm',
  tube_cutting_percentage DOUBLE PRECISION,
  wire_gauge_swg DOUBLE PRECISION,
  wire_ohms_per_mtr DOUBLE PRECISION,
  wire_length_min DOUBLE PRECISION,
  wire_length_max DOUBLE PRECISION,
  ohms_range_val1 DOUBLE PRECISION,
  ohms_range_val2 DOUBLE PRECISION,
  ohms_range_val3 DOUBLE PRECISION,
  ohms_tolerance_percent DOUBLE PRECISION,
  cold_zone_big DOUBLE PRECISION,
  cold_zone_small DOUBLE PRECISION,
  terminal_pin_big_material TEXT,
  terminal_pin_big_val1 DOUBLE PRECISION,
  terminal_pin_big_val2 DOUBLE PRECISION,
  terminal_pin_small_material TEXT,
  terminal_pin_small_val1 DOUBLE PRECISION,
  terminal_pin_small_val2 DOUBLE PRECISION,
  ohms_after_draw_val1 DOUBLE PRECISION,
  ohms_after_draw_val2 DOUBLE PRECISION,
  ohms_after_draw_val3 DOUBLE PRECISION,
  bending_roller1_unit TEXT DEFAULT 'U Inch',
  bending_roller1_value TEXT,
  bending_roller2_unit TEXT DEFAULT 'U Inch',
  bending_roller2_value TEXT,
  remark TEXT,
  plating_required INTEGER DEFAULT 0,
  plating_description TEXT,
  raw_material_status TEXT DEFAULT 'pending' CHECK(raw_material_status IN ('pending','partial','dispatched')),
  raw_material_notes TEXT,
  raw_material_dispatched_at TIMESTAMPTZ,
  raw_material_dispatched_by INTEGER REFERENCES users(id),
  UNIQUE(job_card_id, assembly_no)
);

CREATE TABLE IF NOT EXISTS drawings (
  id SERIAL PRIMARY KEY,
  job_card_id INTEGER REFERENCES job_cards(id),
  assembly_id INTEGER REFERENCES job_card_assemblies(id),
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  original_name TEXT,
  version INTEGER DEFAULT 1,
  notes TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
  item_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT NOT NULL,
  current_stock DOUBLE PRECISION DEFAULT 0,
  reorder_level DOUBLE PRECISION DEFAULT 0,
  unit_cost DOUBLE PRECISION DEFAULT 0,
  drawing_file TEXT,
  drawing_original_name TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  transaction_type TEXT NOT NULL CHECK(transaction_type IN (
    'opening_stock','purchase_in','dispatch_to_production',
    'return_from_production','adjustment'
  )),
  quantity DOUBLE PRECISION NOT NULL,
  balance_after DOUBLE PRECISION NOT NULL,
  job_card_id INTEGER REFERENCES job_cards(id),
  supplier_name TEXT,
  po_number TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS qc_reports (
  id SERIAL PRIMARY KEY,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  result TEXT NOT NULL CHECK(result IN ('approved','rejected','conditional')),
  observations TEXT,
  corrective_action TEXT,
  product_weight DOUBLE PRECISION,
  file_path TEXT,
  file_name TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS production_daily_reports (
  id SERIAL PRIMARY KEY,
  report_date DATE NOT NULL,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  qty_completed INTEGER DEFAULT 0,
  qty_rejected INTEGER DEFAULT 0,
  rejection_reason TEXT,
  notes TEXT,
  reported_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS production_day_picks (
  id SERIAL PRIMARY KEY,
  pick_date DATE NOT NULL,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  picked_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pick_date, job_card_id)
);

CREATE TABLE IF NOT EXISTS package_photos (
  id SERIAL PRIMARY KEY,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  notes TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dispatch_documents (
  id SERIAL PRIMARY KEY,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  doc_type TEXT CHECK(doc_type IN ('invoice','packing_list','delivery_challan','eway_bill','other')),
  file_path TEXT,
  file_name TEXT,
  shipping_carrier TEXT,
  tracking_number TEXT,
  dispatch_date DATE,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  job_card_id INTEGER REFERENCES job_cards(id),
  activity_type TEXT NOT NULL,
  description TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  drawing_number TEXT,
  tube_material TEXT,
  tube_diameter DOUBLE PRECISION,
  wattage DOUBLE PRECISION,
  voltage DOUBLE PRECISION,
  plating_instructions TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  remark TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_item_images (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  original_name TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_drawings (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  original_name TEXT,
  notes TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_messages (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_mentions (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES order_messages(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  mentioned_user_id INTEGER NOT NULL REFERENCES users(id),
  is_read INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS production_checklist (
  id SERIAL PRIMARY KEY,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  stage_no INTEGER NOT NULL CHECK(stage_no BETWEEN 1 AND 30),
  done INTEGER DEFAULT 0,
  value1 TEXT,
  value2 TEXT,
  photo_file TEXT,
  photo_original_name TEXT,
  rejection_qty INTEGER DEFAULT 0,
  remade_qty INTEGER DEFAULT 0,
  rejection_photo_file TEXT,
  rejection_photo_original_name TEXT,
  worker_name TEXT,
  scrap_value TEXT,
  dispatched_qty INTEGER DEFAULT NULL,
  done_at TIMESTAMPTZ,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(job_card_id, stage_no)
);

CREATE TABLE IF NOT EXISTS job_card_holds (
  id SERIAL PRIMARY KEY,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  stage_no INTEGER,
  rejection_qty INTEGER,
  hold_photo_file TEXT,
  hold_photo_original_name TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved')),
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  supplier_code TEXT,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  gst_no TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  po_number TEXT UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','approved','rejected','received')),
  transport_charges DOUBLE PRECISION DEFAULT 0,
  igst_percent DOUBLE PRECISION DEFAULT 18,
  subtotal DOUBLE PRECISION DEFAULT 0,
  igst_amount DOUBLE PRECISION DEFAULT 0,
  grand_total DOUBLE PRECISION DEFAULT 0,
  delivery_status TEXT DEFAULT NULL,
  expected_delivery_date DATE DEFAULT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id SERIAL PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  inventory_item_id INTEGER REFERENCES inventory_items(id),
  description TEXT NOT NULL,
  unit TEXT,
  qty DOUBLE PRECISION NOT NULL,
  rate DOUBLE PRECISION NOT NULL,
  amount DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_fifo_lots (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  po_id INTEGER REFERENCES purchase_orders(id),
  qty_original DOUBLE PRECISION NOT NULL,
  qty_remaining DOUBLE PRECISION NOT NULL,
  unit_cost DOUBLE PRECISION NOT NULL,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_material_qc (
  id SERIAL PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  observations TEXT,
  result TEXT DEFAULT 'accepted',
  rejection_reason TEXT,
  file_path TEXT,
  file_name TEXT,
  file_original_name TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_order_messages (
  id SERIAL PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  data_source TEXT NOT NULL,
  columns_config TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Customer Queries (post-dispatch issue tracking) ────────────────────────
CREATE TABLE IF NOT EXISTS customer_queries (
  id SERIAL PRIMARY KEY,
  query_no TEXT UNIQUE NOT NULL,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  job_card_id INTEGER REFERENCES job_cards(id),
  subject TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general' CHECK(category IN ('design','production','quality','general')),
  priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
  assigned_department TEXT CHECK(assigned_department IN ('design','production','admin')),
  status TEXT DEFAULT 'open' CHECK(status IN (
    'open','in_progress','resolved','product_return'
  )),
  return_type TEXT CHECK(return_type IN ('repair','debit_note')),
  return_status TEXT CHECK(return_status IN (
    'pending_return','received','qc_check','qc_pass','qc_fail','in_repair','repaired_dispatched','debit_note_issued'
  )),
  debit_note_no TEXT,
  return_coupon_no TEXT,
  resolution_summary TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_query_photos (
  id SERIAL PRIMARY KEY,
  query_id INTEGER NOT NULL REFERENCES customer_queries(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  caption TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_query_messages (
  id SERIAL PRIMARY KEY,
  query_id INTEGER NOT NULL REFERENCES customer_queries(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_query_mentions (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES customer_query_messages(id) ON DELETE CASCADE,
  query_id INTEGER NOT NULL REFERENCES customer_queries(id) ON DELETE CASCADE,
  mentioned_user_id INTEGER NOT NULL REFERENCES users(id),
  is_read INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sales prospecting: B2B lead lists researched in Claude Code, reviewed & exported in-app
CREATE TABLE IF NOT EXISTS prospects (
  id            SERIAL PRIMARY KEY,
  company       TEXT NOT NULL,
  city          TEXT,
  state         TEXT,                        -- region / province within the country
  country       TEXT DEFAULT 'India',
  segment       TEXT NOT NULL,
  application   TEXT,                        -- e.g. 'Boilers & steam' — drives filtering + tailored email copy
  email         TEXT,
  phone         TEXT,
  contact_role  TEXT,
  product_fit   TEXT,
  priority      TEXT NOT NULL DEFAULT 'M',   -- H / M / L
  status        TEXT NOT NULL DEFAULT 'new', -- new / exported / contacted
  source        TEXT DEFAULT 'claude-research',
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prospects_segment ON prospects(segment);
CREATE INDEX IF NOT EXISTS idx_prospects_status  ON prospects(status);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_prospect_company_email ON prospects(lower(company), lower(coalesce(email,'')));
