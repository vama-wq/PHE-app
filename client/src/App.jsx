import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuthStore } from './store/authStore';
import AppLayout from './components/layout/AppLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import OrderList from './pages/orders/OrderList';
import OrderDetail from './pages/orders/OrderDetail';
import JobCardList from './pages/jobCards/JobCardList';
import JobCardDetail from './pages/jobCards/JobCardDetail';
import InventoryList from './pages/inventory/InventoryList';
import InventoryDetail from './pages/inventory/InventoryDetail';
import CustomerList from './pages/customers/CustomerList';
import ProductList from './pages/products/ProductList';
import ProductionDashboard from './pages/production/ProductionDashboard';
import DispatchList from './pages/dispatch/DispatchList';
import QCDashboard from './pages/qc/QCDashboard';
import AccountSettings from './pages/account/AccountSettings';
import UserManagement from './pages/account/UserManagement';
import SupplierList from './pages/purchases/SupplierList';
import PurchaseOrderList from './pages/purchases/PurchaseOrderList';
import PurchaseOrderDetail from './pages/purchases/PurchaseOrderDetail';
import PurchaseOrderForm from './pages/purchases/PurchaseOrderForm';
import ReportsDashboard from './pages/reports/ReportsDashboard';
import FinishedGoodsList from './pages/finishedGoods/FinishedGoodsList';
import FinishedGoodsDetail from './pages/finishedGoods/FinishedGoodsDetail';
import FinishedGoodsLog from './pages/finishedGoods/FinishedGoodsLog';
import DrawingsList from './pages/drawings/DrawingsList';
import CustomerQueryList from './pages/customerQueries/CustomerQueryList';
import CustomerQueryDetail from './pages/customerQueries/CustomerQueryDetail';
import OrderTimeline from './pages/customerQueries/OrderTimeline';
import PolicyGuide from './pages/PolicyGuide';

// ── Module permission helper ──────────────────────────────────────────────────
// null permitted_modules = full role-based access. Owner always has full access.
function canAccessModule(user, moduleId) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (!user.permitted_modules) return true;
  try { return JSON.parse(user.permitted_modules).includes(moduleId); }
  catch { return true; }
}

// ── Route guards ──────────────────────────────────────────────────────────────
function ProtectedRoute({ children, roles, module: moduleId }) {
  const { user } = useAuthStore();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  if (moduleId && !canAccessModule(user, moduleId)) return <Navigate to="/" replace />;
  return children;
}

// For routes open to all roles but still module-gated
function ModuleRoute({ children, module: moduleId }) {
  const { user } = useAuthStore();
  if (!user) return <Navigate to="/login" replace />;
  if (moduleId && !canAccessModule(user, moduleId)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { init } = useAuthStore();
  useEffect(() => { init(); }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<AppLayout />}>
          <Route index element={<Dashboard />} />

          <Route path="orders"    element={<ModuleRoute module="orders"><OrderList /></ModuleRoute>} />
          <Route path="orders/:id" element={<ModuleRoute module="orders"><OrderDetail /></ModuleRoute>} />

          <Route path="job-cards"    element={<ModuleRoute module="job-cards"><JobCardList /></ModuleRoute>} />
          <Route path="job-cards/:id" element={<ModuleRoute module="job-cards"><JobCardDetail /></ModuleRoute>} />

          <Route path="production" element={<ModuleRoute module="production"><ProductionDashboard /></ModuleRoute>} />
          <Route path="dispatch"   element={<ModuleRoute module="dispatch"><DispatchList /></ModuleRoute>} />
          <Route path="customer-queries" element={<ModuleRoute module="dispatch"><CustomerQueryList /></ModuleRoute>} />
          <Route path="customer-queries/:id" element={<ModuleRoute module="dispatch"><CustomerQueryDetail /></ModuleRoute>} />
          <Route path="order-timeline/:orderId" element={<OrderTimeline />} />
          <Route path="products"   element={<ModuleRoute module="products"><ProductList /></ModuleRoute>} />

          <Route path="inventory" element={
            <ProtectedRoute roles={['owner','admin','accounts','design']} module="inventory">
              <InventoryList />
            </ProtectedRoute>
          } />
          <Route path="inventory/:id" element={
            <ProtectedRoute roles={['owner','admin','accounts','design']} module="inventory">
              <InventoryDetail />
            </ProtectedRoute>
          } />

          <Route path="qc" element={
            <ProtectedRoute roles={['design','owner','admin']} module="qc">
              <QCDashboard />
            </ProtectedRoute>
          } />

          <Route path="customers" element={
            <ProtectedRoute roles={['admin','owner']} module="customers">
              <CustomerList />
            </ProtectedRoute>
          } />

          <Route path="suppliers" element={
            <ProtectedRoute roles={['owner','admin','accounts']} module="suppliers">
              <SupplierList />
            </ProtectedRoute>
          } />

          <Route path="purchases" element={
            <ProtectedRoute roles={['owner','admin','accounts']} module="purchases">
              <PurchaseOrderList />
            </ProtectedRoute>
          } />
          <Route path="purchases/new" element={
            <ProtectedRoute roles={['owner','admin','accounts']} module="purchases">
              <PurchaseOrderForm />
            </ProtectedRoute>
          } />
          <Route path="purchases/:id" element={
            <ProtectedRoute roles={['owner','admin','accounts']} module="purchases">
              <PurchaseOrderDetail />
            </ProtectedRoute>
          } />
          <Route path="purchases/:id/edit" element={
            <ProtectedRoute roles={['owner','admin','accounts']} module="purchases">
              <PurchaseOrderForm />
            </ProtectedRoute>
          } />

          <Route path="finished-goods" element={<ModuleRoute module="finished-goods"><FinishedGoodsList /></ModuleRoute>} />
          <Route path="finished-goods/logs" element={<ModuleRoute module="finished-goods"><FinishedGoodsLog /></ModuleRoute>} />
          <Route path="finished-goods/:id" element={<ModuleRoute module="finished-goods"><FinishedGoodsDetail /></ModuleRoute>} />

          <Route path="drawings" element={
            <ProtectedRoute roles={['owner','admin','design']}>
              <DrawingsList />
            </ProtectedRoute>
          } />

          <Route path="reports" element={<ModuleRoute module="reports"><ReportsDashboard /></ModuleRoute>} />
          <Route path="policy" element={<PolicyGuide />} />

          {/* Account pages are never module-gated */}
          <Route path="account" element={<AccountSettings />} />
          <Route path="users" element={
            <ProtectedRoute roles={['owner','admin']}>
              <UserManagement />
            </ProtectedRoute>
          } />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
