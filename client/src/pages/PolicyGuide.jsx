import { useState } from 'react';
import {
  BookOpen, ClipboardList, PenLine, FileText, Wrench, FlaskConical,
  Truck, HelpCircle, Warehouse, Package, Box, ShoppingCart, Building2,
  BarChart2, UserCog, LayoutDashboard, ChevronDown, ChevronRight, Search
} from 'lucide-react';

const SECTIONS = [
  {
    id: 'overview',
    icon: BookOpen,
    title: 'Application Overview',
    content: (
      <>
        <p>
          The PHE Management System is an end-to-end manufacturing management platform for Peena Heat Elements.
          It covers the complete lifecycle of a heating element order — from order creation and drawing approval,
          through production tracking across 29 stages, quality checks, dispatch, and post-dispatch customer query handling.
        </p>
        <h4>User Roles</h4>
        <table>
          <thead><tr><th>Role</th><th>Responsibilities</th></tr></thead>
          <tbody>
            <tr><td><strong>Owner</strong></td><td>Full system access. Approves orders, drawings, hold resumes, and manages all modules.</td></tr>
            <tr><td><strong>Admin</strong></td><td>Administrative oversight. User management, module permissions, order and job card management.</td></tr>
            <tr><td><strong>Accounts</strong></td><td>Financial tracking, dispatch documentation, inventory, purchases, and supplier management.</td></tr>
            <tr><td><strong>Design / QC</strong></td><td>Drawing uploads, quality control inspections, and material QC for incoming purchases.</td></tr>
            <tr><td><strong>Production</strong></td><td>Shop floor production tracking, job card stage updates, and daily work management.</td></tr>
          </tbody>
        </table>
        <h4>Order Lifecycle at a Glance</h4>
        <ol>
          <li>Order is created with items and inventory selections</li>
          <li>Owner approves the order</li>
          <li>Design uploads reference drawings per item</li>
          <li>Owner approves each drawing</li>
          <li>Admin creates a Job Card from the approved order</li>
          <li>Production tracks work through 29 stages</li>
          <li>Quality Check is performed after production</li>
          <li>Approved items move to Dispatch or Finished Goods</li>
          <li>Order is dispatched to the customer</li>
        </ol>
      </>
    ),
  },
  {
    id: 'dashboard',
    icon: LayoutDashboard,
    title: 'Dashboard',
    content: (
      <>
        <p>The Dashboard is your landing page and shows a personalised overview based on your role.</p>
        <h4>Owner / Admin Dashboard</h4>
        <ul>
          <li><strong>Pending Approvals</strong> — Orders awaiting your business approval.</li>
          <li><strong>On-Hold Job Cards</strong> — Cards paused due to production issues, with reject photos.</li>
          <li><strong>Production Rejections</strong> — Flagged when more than 2 pieces are rejected at any stage.</li>
          <li><strong>Urgent Dispatches</strong> — Job cards with dispatch dates within 5 days.</li>
          <li><strong>Pending Purchase Orders</strong> — POs awaiting action.</li>
          <li><strong>Low Stock Alerts</strong> — Inventory items below their reorder level.</li>
          <li><strong>Recent Activity</strong> — Live feed of recent actions across the system.</li>
        </ul>
        <h4>Accounts Dashboard</h4>
        <ul>
          <li>Active orders and total order value</li>
          <li>Collection rates (advance vs. balance payments)</li>
          <li>Outstanding balances by order with collection % bars</li>
          <li>Active purchase orders</li>
        </ul>
        <h4>Design / QC Dashboard</h4>
        <ul>
          <li>QC jobs pending inspection</li>
          <li>Material QC pending (for received purchases)</li>
          <li>Approved and rejected QC counts</li>
          <li>Production rejections by stage</li>
          <li>QC pass rate percentage</li>
        </ul>
        <h4>Production Dashboard</h4>
        <ul>
          <li>In-progress, pending, urgent, and overdue job cards</li>
          <li>Cards assigned to you (or all cards if none assigned)</li>
          <li>Rejection tracking</li>
        </ul>
        <h4>Notifications</h4>
        <p>
          The bell icon in the sidebar shows your unread notification count. Notifications appear when
          someone @mentions you in an order or customer query chat. Click any notification to jump directly
          to the relevant order or query. Desktop notifications will also pop up if you allow them in your browser.
        </p>
      </>
    ),
  },
  {
    id: 'orders',
    icon: ClipboardList,
    title: 'Orders',
    content: (
      <>
        <p>
          Orders are the starting point of every manufacturing job. Each order contains one or more items
          (heating elements) with detailed specifications.
        </p>
        <h4>Creating an Order</h4>
        <ol>
          <li>Click <strong>"New Order"</strong> on the Orders page.</li>
          <li>Select the customer and order type (Local HE, Export HE, Inventory Order, IO + Export HE, or IO + Local HE).</li>
          <li>Set the dispatch date and add any notes.</li>
          <li>Add items — each item requires: Product Code, Drawing Number, Tube Material, Tube Diameter, Wattage, Voltage, Plating Instructions, and Quantity.</li>
          <li>Link inventory items (required when creating; optional when editing later).</li>
          <li>Upload reference images if the client has provided any.</li>
          <li>Save the order — it will be in <strong>Pending Approval</strong> status.</li>
        </ol>
        <h4>Order Statuses</h4>
        <table>
          <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td>Pending Approval</td><td>Awaiting owner's business approval</td></tr>
            <tr><td>Approved</td><td>Order approved; design can upload drawings</td></tr>
            <tr><td>Job Card Created</td><td>Job card has been generated for production</td></tr>
            <tr><td>In Progress</td><td>Production is underway</td></tr>
            <tr><td>On Hold</td><td>Paused due to production issues</td></tr>
            <tr><td>QC Pending</td><td>Awaiting quality inspection</td></tr>
            <tr><td>QC Approved</td><td>Quality check passed</td></tr>
            <tr><td>Packaging</td><td>Being packed for shipment</td></tr>
            <tr><td>Dispatched</td><td>Shipped to the customer</td></tr>
            <tr><td>Rejected</td><td>Owner rejected; can be edited and resubmitted</td></tr>
          </tbody>
        </table>
        <h4>Rejected Orders</h4>
        <p>
          If the owner rejects an order, Admin/Accounts/Owner can edit the order details (dispatch date,
          order type, notes) and its items, then click <strong>"Resubmit for Approval"</strong> to send it
          back for the owner's review.
        </p>
        <h4>Chat &amp; @Mentions</h4>
        <p>
          Each order has a chat panel for internal team communication. Type <strong>@</strong> followed by a
          user's name to mention them — they will receive a notification on their dashboard and a desktop alert.
          You can also attach files (up to 5 per message) using the paperclip icon.
        </p>
        <h4>Filtering &amp; Search</h4>
        <p>
          Use the search bar to find orders by order code, customer name, or product. Filter by status, client,
          product, or date range using the filter controls.
        </p>
      </>
    ),
  },
  {
    id: 'drawings',
    icon: PenLine,
    title: 'Drawings',
    content: (
      <>
        <p>
          The Drawings section manages reference/technical drawings that must be approved before production begins.
          Drawings are uploaded per order item.
        </p>
        <h4>Drawing Workflow</h4>
        <ol>
          <li>After an order is approved, the <strong>Design</strong> team uploads drawings for each item.</li>
          <li>Drawings enter <strong>Pending Review</strong> status.</li>
          <li>The <strong>Owner</strong> reviews and either approves or rejects each drawing.</li>
          <li>If rejected, Design revises and re-uploads.</li>
          <li>Once <strong>all items</strong> in an order have approved drawings, a Job Card can be created.</li>
        </ol>
        <h4>Drawing Statuses</h4>
        <table>
          <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td>Needs Drawing</td><td>No drawing uploaded yet for one or more items</td></tr>
            <tr><td>Pending Review</td><td>Drawing uploaded, awaiting owner approval</td></tr>
            <tr><td>Rejected</td><td>Drawing rejected by owner — needs revision</td></tr>
            <tr><td>Approved</td><td>All item drawings approved</td></tr>
          </tbody>
        </table>
        <h4>Tabs</h4>
        <p>
          Orders are organised into tabs: <strong>Pending</strong> (need drawings), <strong>Awaiting Review</strong>,
          <strong>Rejected</strong>, and <strong>Approved</strong> — so the Design team can quickly see what needs attention.
        </p>
        <p><em>Accessible to: Owner, Admin, Design</em></p>
      </>
    ),
  },
  {
    id: 'jobcards',
    icon: FileText,
    title: 'Job Cards',
    content: (
      <>
        <p>
          Job Cards are production tickets generated from approved orders. They track each item's journey through
          29 production stages, quality checks, and dispatch.
        </p>
        <h4>Creating a Job Card</h4>
        <p>
          Once all items in an order have approved drawings, an Admin or Owner can click
          <strong> "Create Job Card"</strong> on the Order Detail page. This generates a job card linked to the order.
        </p>
        <h4>Job Card Tabs</h4>
        <ul>
          <li><strong>Overview</strong> — Basic info, quantities, dispatch date and urgency indicator.</li>
          <li><strong>Assemblies</strong> — Sub-component assemblies needed for the heater.</li>
          <li><strong>Drawings</strong> — Reference and technical drawings for the production floor.</li>
          <li><strong>Production</strong> — Stage-by-stage progress tracker (29 stages).</li>
          <li><strong>QC</strong> — Quality check reports and pass/fail status.</li>
          <li><strong>Dispatch</strong> — Packaging and dispatch documentation.</li>
          <li><strong>Timeline</strong> — Activity log of all changes.</li>
        </ul>
        <h4>Job Card Statuses</h4>
        <table>
          <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td>Pending</td><td>Not yet started</td></tr>
            <tr><td>In Progress</td><td>Production underway</td></tr>
            <tr><td>QC Pending</td><td>Awaiting quality inspection (after Stage 28)</td></tr>
            <tr><td>QC Approved</td><td>Passed QC; ready for packaging</td></tr>
            <tr><td>On Hold</td><td>Paused due to rejections — owner must approve resume</td></tr>
            <tr><td>Completed</td><td>Production finished</td></tr>
            <tr><td>Dispatched</td><td>Shipped to customer</td></tr>
          </tbody>
        </table>
      </>
    ),
  },
  {
    id: 'production',
    icon: Wrench,
    title: 'Production',
    content: (
      <>
        <p>
          The Production module is the shop floor management tool. It helps supervisors and workers
          track daily work and log progress through each production stage.
        </p>
        <h4>Daily Workflow</h4>
        <ol>
          <li>Supervisor opens the <strong>"Today's Work"</strong> tab and picks job cards for the day.</li>
          <li>Workers see their assigned job cards and update progress stage by stage.</li>
          <li>At each stage, workers record their name, measurements, and any required photos.</li>
          <li>When Stage 28 (Megger) is completed, the system automatically triggers QC.</li>
        </ol>
        <h4>Production Stages (29 Total)</h4>
        <table>
          <thead><tr><th>#</th><th>Stage</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td>1</td><td>Coil</td><td>Scrap value optional</td></tr>
            <tr><td>2</td><td>Coil + Tube Cutting</td><td>Optional stage</td></tr>
            <tr><td>3</td><td>Ohms</td><td>Ohms reading required</td></tr>
            <tr><td>4</td><td>Spot</td><td>Scrap value optional</td></tr>
            <tr><td>5</td><td>Tube Cutting</td><td>Scrap value optional</td></tr>
            <tr><td>6</td><td>Filling</td><td></td></tr>
            <tr><td>7</td><td>HV + Light Check</td><td>Verification checkpoint</td></tr>
            <tr><td>8</td><td>Draw</td><td></td></tr>
            <tr><td>9</td><td>HV + Light Check</td><td>Verification checkpoint</td></tr>
            <tr><td>10</td><td>Straightening</td><td></td></tr>
            <tr><td>11</td><td>Trimming</td><td>Scrap value optional</td></tr>
            <tr><td>12</td><td>Spot / Furnace Annealing</td><td></td></tr>
            <tr><td>13</td><td>Buffing</td><td>Optional stage</td></tr>
            <tr><td>14</td><td>Bending</td><td>Heater adjustment notes</td></tr>
            <tr><td>15</td><td>Brazing</td><td>Optional stage</td></tr>
            <tr><td>16-17</td><td>Plating</td><td>Optional stages</td></tr>
            <tr><td>18</td><td>Heater Cleaning</td><td>Optional stage</td></tr>
            <tr><td>19</td><td>Overnight Oven</td><td></td></tr>
            <tr><td>20</td><td>HV + Light Check</td><td>Verification checkpoint</td></tr>
            <tr><td>21</td><td>Nipple Press</td><td>Optional; scrap value optional</td></tr>
            <tr><td>22</td><td>3 Hours Oven</td><td>Optional stage</td></tr>
            <tr><td>23</td><td>Sealing</td><td></td></tr>
            <tr><td>24</td><td>HV + Light Check</td><td>Verification checkpoint</td></tr>
            <tr><td>25</td><td>Cleaning</td><td>Photo required</td></tr>
            <tr><td>26</td><td>Nut Washer</td><td>Scrap value optional</td></tr>
            <tr><td>27</td><td>HV + Light Check</td><td>Verification checkpoint</td></tr>
            <tr><td>28</td><td>Megger</td><td>Megger reading required; triggers QC</td></tr>
            <tr><td>29</td><td>Ready in Production</td><td>Photo required; triggers QC</td></tr>
          </tbody>
        </table>
        <p>
          <strong>Mandatory stages</strong> (must complete before QC): 1, 3–14, 19–28. Optional stages can be
          skipped if not applicable to the product.
        </p>
        <h4>Production Rejections</h4>
        <p>
          If a stage fails, record the rejection quantity and upload a photo. The job card goes <strong>"On Hold"</strong>
          and the Owner must approve resuming production. The dashboard flags any card with more than 2 rejected pieces.
        </p>
        <h4>Export</h4>
        <p>Download the production checklist as an Excel file with worker assignments and stage progress.</p>
      </>
    ),
  },
  {
    id: 'qc',
    icon: FlaskConical,
    title: 'Quality Check (QC)',
    content: (
      <>
        <p>
          Quality Check ensures every product meets standards before dispatch. QC has two parts:
          incoming material inspection and finished product inspection.
        </p>
        <h4>A. Purchase Material QC</h4>
        <p>
          When raw materials are received from a supplier, they appear in the Material QC queue.
          The Design/Owner reviews the material and approves it before it can be used in production.
        </p>
        <h4>B. Job Card QC (Product Inspection)</h4>
        <p>
          After production completes Stage 28 (Megger), the job card automatically enters
          <strong> QC Pending</strong> status.
        </p>
        <h4>QC Workflow</h4>
        <ol>
          <li>Open the QC Dashboard and select a pending job card.</li>
          <li>Upload a QC report with observations, test results, and photos.</li>
          <li>
            <strong>Approve</strong> — Choose a destination:
            <ul>
              <li><strong>Dispatch</strong> — Send directly to the customer.</li>
              <li><strong>Finished Goods</strong> — Add to finished goods stock.</li>
            </ul>
          </li>
          <li><strong>Reject</strong> — The job card goes "On Hold" for rework. Owner must approve resuming production.</li>
        </ol>
        <p><em>Accessible to: Owner, Admin, Design</em></p>
      </>
    ),
  },
  {
    id: 'dispatch',
    icon: Truck,
    title: 'Dispatch',
    content: (
      <>
        <p>
          Dispatch manages the final step — packaging and shipping QC-approved products to customers.
        </p>
        <h4>Dispatch Workflow</h4>
        <ol>
          <li>QC-approved job cards appear in the Dispatch list.</li>
          <li>Record packaging details.</li>
          <li>Upload dispatch documentation (invoices, packing lists, delivery challans).</li>
          <li>Enter shipment details — courier name, tracking number, etc.</li>
          <li>Mark the job card as <strong>Dispatched</strong>.</li>
        </ol>
        <h4>Dispatch Statuses</h4>
        <table>
          <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td>QC Approved</td><td>Ready for packaging</td></tr>
            <tr><td>Packaging</td><td>Being packed</td></tr>
            <tr><td>Ready for Dispatch</td><td>Waiting for pickup/shipment</td></tr>
            <tr><td>Dispatched</td><td>Shipped to customer</td></tr>
          </tbody>
        </table>
        <p><em>Primary users: Accounts, Owner</em></p>
      </>
    ),
  },
  {
    id: 'customer-queries',
    icon: HelpCircle,
    title: 'Customer Queries',
    content: (
      <>
        <p>
          Customer Queries track post-dispatch issues, complaints, and product returns. Each query is linked
          to a job card and has its own chat thread for team communication.
        </p>
        <h4>Query Types</h4>
        <ul>
          <li><strong>Query Raised</strong> — Customer reported a defect or issue.</li>
          <li><strong>Product Return</strong> — Physical product returned for inspection and repair.</li>
          <li><strong>Repair In Progress</strong> — Returned product being repaired.</li>
          <li><strong>Query Resolved</strong> — Issue fixed and re-dispatched.</li>
        </ul>
        <h4>Query Statuses</h4>
        <table>
          <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td>Open</td><td>New query, not yet assigned</td></tr>
            <tr><td>In Progress</td><td>Being worked on</td></tr>
            <tr><td>Resolved</td><td>Issue fixed and dispatched</td></tr>
            <tr><td>Product Return</td><td>Physical return initiated</td></tr>
          </tbody>
        </table>
        <h4>Return Tracking</h4>
        <p>
          When a product is physically returned, it goes through a return workflow: Pending Return &rarr;
          Received &rarr; QC Check &rarr; QC Pass/Fail &rarr; In Repair &rarr; Repaired &amp; Dispatched
          (or Debit Note Issued).
        </p>
        <h4>Chat &amp; Attachments</h4>
        <p>
          Each query has a chat panel with @mention support and file attachments, just like order chats.
          Mentioned users receive dashboard notifications and desktop alerts.
        </p>
      </>
    ),
  },
  {
    id: 'finished-goods',
    icon: Warehouse,
    title: 'Finished Goods',
    content: (
      <>
        <p>
          Finished Goods tracks completed products available in stock for dispatch or sale.
          Items enter finished goods when QC-approved products are routed here instead of direct dispatch.
        </p>
        <h4>Key Features</h4>
        <ul>
          <li><strong>Stock Overview</strong> — View current stock levels by drawing number, material, wattage, and voltage.</li>
          <li><strong>Movement Log</strong> — Track all inbound (from production) and outbound (to dispatch) movements.</li>
          <li><strong>Search &amp; Filter</strong> — Find items by drawing number, material, wattage, or voltage.</li>
          <li><strong>Out of Stock Filter</strong> — Quickly identify zero-stock items.</li>
          <li><strong>Bulk Import</strong> — Import finished goods data via Excel upload.</li>
        </ul>
        <p><em>Accessible to: Owner, Admin, Production</em></p>
      </>
    ),
  },
  {
    id: 'inventory',
    icon: Package,
    title: 'Inventory',
    content: (
      <>
        <p>
          Inventory manages raw materials, components, and consumables used in production.
        </p>
        <h4>Item Information</h4>
        <ul>
          <li>Item Code, Name, Category, Unit (kg, m, pcs, etc.)</li>
          <li>Current Stock level and Reorder Level (minimum threshold)</li>
          <li>Status: In Stock or Low Stock (when at or below reorder level)</li>
        </ul>
        <h4>Key Features</h4>
        <ul>
          <li><strong>Low Stock Alerts</strong> — Filter items below their reorder level. These also appear on the Owner/Admin dashboard.</li>
          <li><strong>Linked to Orders</strong> — When creating order items, you select required inventory items. This is mandatory when creating an order but optional when editing.</li>
          <li><strong>Stock Movements</strong> — Track inbound (from purchases) and outbound (to production) movements.</li>
          <li><strong>Bulk Import</strong> — Import inventory data via Excel upload.</li>
        </ul>
        <p><em>Accessible to: Owner, Admin, Accounts, Design</em></p>
      </>
    ),
  },
  {
    id: 'products',
    icon: Box,
    title: 'Products',
    content: (
      <>
        <p>
          The Products module is the master product catalogue. Products are referenced when creating order items.
        </p>
        <h4>Product Information</h4>
        <ul>
          <li>Product Code, Name, Category, Description</li>
          <li>Product Photo (optional)</li>
        </ul>
        <h4>Actions</h4>
        <ul>
          <li>Add new products manually or via bulk Excel import.</li>
          <li>Edit product details and photos.</li>
          <li>Search and filter by product code, name, or category.</li>
        </ul>
        <p><em>All roles can view products. Admin/Owner can add and edit.</em></p>
      </>
    ),
  },
  {
    id: 'purchases',
    icon: ShoppingCart,
    title: 'Purchases & Suppliers',
    content: (
      <>
        <p>
          The Purchases module manages vendor purchase orders and supplier relationships.
        </p>
        <h4>Suppliers</h4>
        <p>
          Maintain a supplier directory with Supplier Code, Name, Contact, Email, and Category.
          Add or edit suppliers from the Suppliers page.
        </p>
        <h4>Purchase Orders</h4>
        <h4>PO Workflow</h4>
        <ol>
          <li>Create a PO in <strong>Draft</strong> status — select the supplier, add items with quantities, unit prices, and GST.</li>
          <li>Send the PO for supplier approval.</li>
          <li>Supplier approves &rarr; Status becomes <strong>Approved</strong>.</li>
          <li>Materials arrive &rarr; Mark as <strong>Received</strong>.</li>
          <li><strong>Material QC</strong> — Design/Owner reviews received material quality.</li>
          <li>Upon QC approval, stock is updated in Inventory.</li>
        </ol>
        <h4>PO Statuses</h4>
        <table>
          <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td>Draft</td><td>Not yet sent to supplier</td></tr>
            <tr><td>Pending / Sent</td><td>Awaiting supplier response</td></tr>
            <tr><td>Approved</td><td>Supplier accepted</td></tr>
            <tr><td>Received</td><td>Materials received (triggers material QC)</td></tr>
            <tr><td>Rejected</td><td>Supplier rejected</td></tr>
          </tbody>
        </table>
        <p><em>Accessible to: Owner, Admin, Accounts</em></p>
      </>
    ),
  },
  {
    id: 'reports',
    icon: BarChart2,
    title: 'Reports',
    content: (
      <>
        <p>
          The Reports module provides customisable data reports and analytics across all modules.
        </p>
        <h4>Available Reports</h4>
        <ul>
          <li><strong>Orders</strong> — Order statistics, financial summary, status breakdown.</li>
          <li><strong>Job Cards</strong> — Production status, worker assignments, completion rates.</li>
          <li><strong>QC</strong> — Pass/fail trends, defect analysis.</li>
          <li><strong>Dispatch</strong> — Dispatch timing, on-time performance.</li>
          <li><strong>Inventory</strong> — Stock levels, movement history, reorder alerts.</li>
          <li><strong>Purchases</strong> — PO tracking, supplier performance, cost analysis.</li>
          <li><strong>Finished Goods</strong> — Stock availability and movement log.</li>
          <li><strong>Customer Queries</strong> — Issue types, resolution time, repeat problems.</li>
        </ul>
        <h4>Features</h4>
        <ul>
          <li><strong>Custom Columns</strong> — Choose which fields to display in your report.</li>
          <li><strong>Filters</strong> — Filter by date range, status, customer, product, and more.</li>
          <li><strong>Export to Excel</strong> — Download any report for external analysis.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'users',
    icon: UserCog,
    title: 'Account & User Management',
    content: (
      <>
        <h4>Account Settings (All Users)</h4>
        <ul>
          <li>Update your display name.</li>
          <li>Change your password (requires current password).</li>
          <li>View your current role and permissions.</li>
        </ul>
        <h4>User Management (Owner / Admin Only)</h4>
        <ul>
          <li><strong>Add User</strong> — Create a new account and assign a role.</li>
          <li><strong>Edit User</strong> — Change name or role.</li>
          <li><strong>Reset Password</strong> — Resets to default password (user must change on next login).</li>
          <li><strong>Module Permissions</strong> — Restrict users to specific modules. Owner always has full access.</li>
          <li><strong>Delete User</strong> — Permanently remove an account.</li>
        </ul>
        <h4>Default Module Access by Role</h4>
        <table>
          <thead><tr><th>Role</th><th>Default Modules</th></tr></thead>
          <tbody>
            <tr><td>Owner</td><td>All modules</td></tr>
            <tr><td>Admin</td><td>All modules</td></tr>
            <tr><td>Accounts</td><td>Orders, Job Cards, Dispatch, Inventory, Purchases, Suppliers, Products, Reports</td></tr>
            <tr><td>Design</td><td>Orders, Drawings, Job Cards, QC, Inventory, Products, Reports</td></tr>
            <tr><td>Production</td><td>Orders, Job Cards, Production, Dispatch, Reports</td></tr>
          </tbody>
        </table>
      </>
    ),
  },
];

export default function PolicyGuide() {
  const [openSection, setOpenSection] = useState('overview');
  const [search, setSearch] = useState('');

  const filtered = search.trim()
    ? SECTIONS.filter(s =>
        s.title.toLowerCase().includes(search.toLowerCase())
      )
    : SECTIONS;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
          <BookOpen className="text-phe-600" size={28} />
          Policy of PHE — User Guide
        </h1>
        <p className="text-gray-500 mt-1">
          How to use each module of the PHE Management System.
        </p>
      </div>

      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
        <input
          type="text"
          placeholder="Search sections..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-phe-500 focus:border-phe-500 outline-none"
        />
      </div>

      <div className="space-y-2">
        {filtered.map(section => {
          const Icon = section.icon;
          const isOpen = openSection === section.id;
          return (
            <div key={section.id} className="border border-gray-200 rounded-lg overflow-hidden bg-white">
              <button
                onClick={() => setOpenSection(isOpen ? null : section.id)}
                className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-gray-50 transition-colors"
              >
                <Icon size={20} className="text-phe-600 flex-shrink-0" />
                <span className="flex-1 font-semibold text-gray-800">{section.title}</span>
                {isOpen
                  ? <ChevronDown size={18} className="text-gray-400" />
                  : <ChevronRight size={18} className="text-gray-400" />
                }
              </button>
              {isOpen && (
                <div className="px-5 pb-5 pt-1 border-t border-gray-100 policy-content">
                  {section.content}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-center text-gray-400 py-8">No sections match your search.</p>
        )}
      </div>
    </div>
  );
}
