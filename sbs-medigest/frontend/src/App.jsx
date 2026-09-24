import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import { Login, ChangePassword, ForcedMfaSetup } from './pages/Auth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { PatientList, PatientDetail } from './pages/Patients.jsx';
import { ConsultationList, ConsultationDetail } from './pages/Consultations.jsx';
import Appointments from './pages/Appointments.jsx';
import { PaymentList, PaymentNew, PaymentDetail } from './pages/Payments.jsx';
import { Cash, CashSession } from './pages/Cash.jsx';
import Expenses from './pages/Expenses.jsx';
import { Pharmacy, ProductDetail, InventoryDetail } from './pages/Pharmacy.jsx';
import Suppliers from './pages/Suppliers.jsx';
import { LabList, LabDetail } from './pages/Lab.jsx';
import { Reports, EmployeeReport } from './pages/Reports.jsx';
import Alerts from './pages/Alerts.jsx';
import Audit from './pages/Audit.jsx';
import { Employees, EmployeeDetail } from './pages/Employees.jsx';
import Roles from './pages/Roles.jsx';
import Catalog from './pages/Catalog.jsx';
import Settings from './pages/Settings.jsx';
import { InvoiceList, InvoiceDetail, DocumentVerify } from './pages/Invoices.jsx';

function Home() {
  const { can } = useAuth();
  if (can('dashboard.view', 'dashboard.finance')) return <Dashboard />;
  const first = [
    ['consultations.view', '/consultations'], ['payments.create', '/paiements/nouveau'], ['pharmacy.sell', '/pharmacie'],
    ['lab.results', '/laboratoire'], ['patients.view', '/patients'], ['appointments.view', '/rendez-vous'],
  ].find(([p]) => can(p));
  return <Navigate to={first ? first[1] : '/mot-de-passe'} replace />;
}

export default function App() {
  const { loading, user } = useAuth();
  if (loading) return <div className="empty">Chargement…</div>;
  if (!user) return <Login />;
  if (user.mustChangePassword) return <ChangePassword forced />;
  if (user.mfaSetupRequired) return <ForcedMfaSetup />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="patients" element={<PatientList />} />
        <Route path="patients/:id" element={<PatientDetail />} />
        <Route path="consultations" element={<ConsultationList />} />
        <Route path="consultations/:id" element={<ConsultationDetail />} />
        <Route path="rendez-vous" element={<Appointments />} />
        <Route path="paiements" element={<PaymentList />} />
        <Route path="paiements/nouveau" element={<PaymentNew />} />
        <Route path="paiements/:id" element={<PaymentDetail />} />
        <Route path="factures" element={<InvoiceList />} />
        <Route path="factures/:id" element={<InvoiceDetail />} />
        <Route path="verification" element={<DocumentVerify />} />
        <Route path="caisse" element={<Cash />} />
        <Route path="caisse/sessions/:id" element={<CashSession />} />
        <Route path="depenses" element={<Expenses />} />
        <Route path="pharmacie" element={<Pharmacy />} />
        <Route path="pharmacie/produits/:id" element={<ProductDetail />} />
        <Route path="pharmacie/inventaires/:id" element={<InventoryDetail />} />
        <Route path="fournisseurs" element={<Suppliers />} />
        <Route path="laboratoire" element={<LabList />} />
        <Route path="laboratoire/:id" element={<LabDetail />} />
        <Route path="rapports" element={<Reports />} />
        <Route path="rapports/employe/:id" element={<EmployeeReport />} />
        <Route path="alertes" element={<Alerts />} />
        <Route path="audit" element={<Audit />} />
        <Route path="employes" element={<Employees />} />
        <Route path="employes/:id" element={<EmployeeDetail />} />
        <Route path="roles" element={<Roles />} />
        <Route path="actes" element={<Catalog />} />
        <Route path="parametres" element={<Settings />} />
        <Route path="mot-de-passe" element={<ChangePassword />} />
        <Route path="*" element={<div className="empty">Page introuvable.</div>} />
      </Route>
    </Routes>
  );
}
