import { useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Card, useFetch, Modal, Field, ErrorBox, Badge, Empty, useToast } from '../components/ui.jsx';

function RoleEditor({ role, perms, onClose, onSaved }) {
  const [name, setName] = useState(role?.name || '');
  const [description, setDescription] = useState(role?.description || '');
  const [sel, setSel] = useState(new Set(role?.permissions || []));
  const [error, setError] = useState(null);
  const groups = perms.reduce((g, p) => { (g[p.module] ||= []).push(p); return g; }, {});
  const toggle = (code) => { const s = new Set(sel); s.has(code) ? s.delete(code) : s.add(code); setSel(s); };
  const toggleGroup = (list) => { const s = new Set(sel); const all = list.every((p) => s.has(p.code)); list.forEach((p) => (all ? s.delete(p.code) : s.add(p.code))); setSel(s); };
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    const body = { name, description, permissions: [...sel] };
    try { onSaved(role ? await api.put(`/roles/${role.id}`, body) : await api.post('/roles', body)); } catch (err) { setError(err); }
  };
  return (
    <Modal title={role ? `Rôle « ${role.name} »` : 'Nouveau rôle personnalisé'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Nom du rôle" required><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label="Description" className="span-2"><input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
        <div className="perm-grid">
          {Object.entries(groups).map(([mod, list]) => (
            <div key={mod} className="perm-group">
              <h3><label><input type="checkbox" checked={list.every((p) => sel.has(p.code))} onChange={() => toggleGroup(list)} /> {mod}</label></h3>
              {list.map((p) => <label key={p.code}><input type="checkbox" checked={sel.has(p.code)} onChange={() => toggle(p.code)} />{p.label}</label>)}
            </div>
          ))}
        </div>
        {role && <div className="alert-box warn">La modification s'applique immédiatement à tous les employés ayant ce rôle ({role.user_count}) et est tracée dans le journal d'audit.</div>}
        <ErrorBox error={error} />
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary">Enregistrer ({sel.size} permissions)</button></div>
      </form>
    </Modal>
  );
}

export default function Roles() {
  const toast = useToast();
  const { data: roles, reload } = useFetch('/roles');
  const { data: perms } = useFetch('/roles/permissions');
  const [modal, setModal] = useState(null);
  if (!roles || !perms) return <Empty>Chargement…</Empty>;
  return (
    <>
      <PageHeader title="Rôles & permissions" subtitle="Chaque utilisateur ne voit que les données nécessaires à sa fonction">
        <button className="btn primary" onClick={() => setModal({ role: null })}>+ Rôle personnalisé</button>
      </PageHeader>
      <div className="grid-3">
        {roles.map((r) => (
          <Card key={r.id} title={<>{r.name} {r.is_system && <Badge tone="muted">système</Badge>}</>} actions={!r.is_superadmin && <button className="btn sm" onClick={() => setModal({ role: r })}>Modifier</button>}>
            <p className="muted small" style={{ marginTop: 0 }}>{r.description}</p>
            <p className="small"><b>{r.user_count}</b> employé(s) · <b>{r.is_superadmin ? 'toutes' : r.permissions.length}</b> permission(s)</p>
            {!r.is_superadmin && <div className="small muted">{r.permissions.map((c) => perms.find((p) => p.code === c)?.label).filter(Boolean).slice(0, 8).join(' · ')}{r.permissions.length > 8 && ' …'}</div>}
            {!r.is_system && r.user_count === 0 && <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={async () => { await api.del(`/roles/${r.id}`); toast('Rôle supprimé'); reload(); }}>Supprimer</button>}
          </Card>
        ))}
      </div>
      {modal && <RoleEditor role={modal.role} perms={perms} onClose={() => setModal(null)} onSaved={() => { setModal(null); toast('Rôle enregistré'); reload(); }} />}
    </>
  );
}
