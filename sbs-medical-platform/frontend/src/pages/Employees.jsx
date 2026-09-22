import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { PageHeader, Card, Table, useFetch, Modal, Field, ErrorBox, Badge, Empty, useToast, useForm, Tabs } from '../components/ui.jsx';
import { dateTime, LABELS } from '../format.js';

/** Éditeur de surcharges : hériter du rôle / accorder / retirer. */
function OverridesEditor({ role, value, onChange }) {
  const { data: perms } = useFetch('/roles/permissions');
  if (!perms || !role) return null;
  const groups = perms.reduce((g, p) => { (g[p.module] ||= []).push(p); return g; }, {});
  const get = (code) => value.find((o) => o.permission_code === code);
  const set = (code, v) => {
    const rest = value.filter((o) => o.permission_code !== code);
    onChange(v === 'inherit' ? rest : [...rest, { permission_code: code, granted: v === 'grant' }]);
  };
  return (
    <div className="perm-grid">
      {Object.entries(groups).map(([mod, list]) => (
        <div key={mod} className="perm-group"><h3>{mod}</h3>
          {list.map((p) => {
            const inRole = role.is_superadmin || role.permissions.includes(p.code);
            const o = get(p.code);
            const effective = o ? o.granted : inRole;
            return (
              <label key={p.code} style={{ justifyContent: 'space-between' }}>
                <span>{effective ? '✅' : '▫️'} {p.label}</span>
                <select value={o ? (o.granted ? 'grant' : 'deny') : 'inherit'} onChange={(e) => set(p.code, e.target.value)} disabled={role.is_superadmin} aria-label={p.label}>
                  <option value="inherit">Rôle ({inRole ? 'oui' : 'non'})</option>
                  <option value="grant">Accorder</option>
                  <option value="deny">Retirer</option>
                </select>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function EmployeeForm({ employee, onClose, onSaved }) {
  const { data: roles } = useFetch('/roles');
  const { values, bind, set } = useForm(employee
    ? { ...employee, role_id: String(employee.role_id), permission_overrides: employee.permission_overrides || [] }
    : { status: 'active', permission_overrides: [], role_id: '' });
  const [showPerms, setShowPerms] = useState(false);
  const [error, setError] = useState(null);
  const role = roles?.find((r) => String(r.id) === String(values.role_id));
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    const body = {
      first_name: values.first_name, last_name: values.last_name, phone: values.phone || null, email: values.email || '', job_title: values.job_title || null,
      role_id: Number(values.role_id), username: values.username, status: values.status, permission_overrides: values.permission_overrides,
    };
    if (!employee && values.password) body.password = values.password;
    try { onSaved(employee ? { user: await api.put(`/users/${employee.id}`, body) } : await api.post('/users', body)); } catch (err) { setError(err); }
  };
  return (
    <Modal title={employee ? `Modifier ${employee.first_name} ${employee.last_name}` : 'Ajouter un employé'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Nom" required><input {...bind('last_name')} required /></Field>
          <Field label="Prénom" required><input {...bind('first_name')} required /></Field>
          <Field label="Téléphone"><input type="tel" {...bind('phone')} /></Field>
          <Field label="E-mail"><input type="email" {...bind('email')} /></Field>
          <Field label="Fonction"><input {...bind('job_title')} placeholder="Médecin généraliste, caissière…" /></Field>
          <Field label="Rôle" required><select {...bind('role_id')} required><option value="">—</option>{roles?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          <Field label="Identifiant de connexion" required><input {...bind('username')} required autoComplete="off" pattern="[a-zA-Z0-9._\-]{3,50}" /></Field>
          {!employee && <Field label="Mot de passe temporaire" hint="Laisser vide pour en générer un automatiquement."><input {...bind('password')} autoComplete="new-password" /></Field>}
          <Field label="Statut"><select {...bind('status')}><option value="active">Actif</option><option value="disabled">Désactivé</option></select></Field>
        </div>
        {role && (
          <div>
            <button type="button" className="btn ghost sm" onClick={() => setShowPerms(!showPerms)}>{showPerms ? '▾' : '▸'} Permissions individuelles ({values.permission_overrides.length} ajustement(s))</button>
            {showPerms && <div style={{ marginTop: 8 }}><OverridesEditor role={role} value={values.permission_overrides} onChange={(v) => set('permission_overrides', v)} /></div>}
          </div>
        )}
        <ErrorBox error={error} />
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Annuler</button><button className="btn primary">Enregistrer</button></div>
      </form>
    </Modal>
  );
}

function TempPassword({ user, password, onClose }) {
  return (
    <Modal title="Accès de l'employé" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>J'ai noté ces informations</button>}>
      <div className="alert-box info">Communiquez ces informations à l'employé en main propre. Il devra choisir son propre mot de passe à la première connexion.</div>
      <dl className="kv" style={{ marginTop: 12, fontSize: '1.1rem' }}>
        <dt>Employé</dt><dd>{user.first_name} {user.last_name}</dd>
        <dt>Identifiant</dt><dd><code>{user.username}</code></dd>
        <dt>Mot de passe temporaire</dt><dd><code style={{ fontSize: '1.2rem' }}>{password}</code> <button className="btn sm ghost" onClick={() => navigator.clipboard?.writeText(password)}>Copier</button></dd>
      </dl>
    </Modal>
  );
}

export function Employees() {
  const { can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const { data, reload } = useFetch('/users');
  const [modal, setModal] = useState(null);
  return (
    <>
      <PageHeader title="Employés" subtitle={data ? `${data.filter((u) => u.status === 'active').length} actif(s) sur ${data.length} — aucune limite de nombre` : ''}>
        {can('users.manage') && <button className="btn primary" onClick={() => setModal('new')}>+ Ajouter</button>}
      </PageHeader>
      <Card>
        <Table rows={data} onRowClick={(r) => nav(`/employes/${r.id}`)} columns={[
          { key: 'name', label: 'Employé', render: (r) => <><b>{r.last_name} {r.first_name}</b><div className="muted small">{r.employee_number} · {r.username}</div></> },
          { key: 'job_title', label: 'Fonction' },
          { key: 'role_name', label: 'Rôle', render: (r) => <Badge tone="info">{r.role_name}</Badge> },
          { key: 'phone', label: 'Téléphone' },
          { key: 'last_login', label: 'Dernière connexion', render: (r) => dateTime(r.last_login) },
          { key: 'status', label: 'Statut', render: (r) => r.status === 'active' ? (r.locked_until && new Date(r.locked_until) > new Date() ? <Badge tone="warn">Verrouillé</Badge> : <Badge tone="ok">Actif</Badge>) : <Badge tone="muted">Désactivé</Badge> },
        ]} />
      </Card>
      {modal === 'new' && <EmployeeForm onClose={() => setModal(null)} onSaved={(r) => { reload(); setModal({ temp: r }); toast('Employé créé'); }} />}
      {modal?.temp && <TempPassword user={modal.temp.user} password={modal.temp.temporaryPassword} onClose={() => setModal(null)} />}
    </>
  );
}

export function EmployeeDetail() {
  const { id } = useParams();
  const { can, user: me } = useAuth();
  const toast = useToast();
  const { data: u, reload, error } = useFetch(`/users/${id}`);
  const [tab, setTab] = useState('activity');
  const { data: activity } = useFetch(tab === 'activity' ? `/users/${id}/activity` : null);
  const { data: logins } = useFetch(tab === 'logins' ? `/users/${id}/logins` : null);
  const { data: history } = useFetch(tab === 'history' ? `/users/${id}/history` : null);
  const [modal, setModal] = useState(null);
  if (error) return <ErrorBox error={error} />;
  if (!u) return <Empty>Chargement…</Empty>;
  const locked = u.locked_until && new Date(u.locked_until) > new Date();
  const setStatus = async (status) => { try { await api.put(`/users/${id}`, { status }); toast(status === 'active' ? 'Compte réactivé' : 'Compte désactivé — sessions fermées'); reload(); } catch (e) { toast(e.message, 'danger'); } };
  return (
    <>
      <PageHeader title={`${u.first_name} ${u.last_name}`} subtitle={`${u.employee_number} · ${u.job_title || u.role_name} · identifiant « ${u.username} »`}>
        {u.status === 'active' ? <Badge tone="ok">Actif</Badge> : <Badge tone="muted">Désactivé</Badge>}
        {locked && <Badge tone="warn">Verrouillé</Badge>}
        {can('reports.employee') && <Link className="btn" to={`/rapports/employe/${u.id}`}>📈 Rapport</Link>}
        {can('users.manage') && <>
          <button className="btn" onClick={() => setModal('edit')}>✏️ Modifier / permissions</button>
          <button className="btn" onClick={async () => { const r = await api.post(`/users/${id}/reset-password`); setModal({ temp: r.temporaryPassword }); }}>🔑 Réinitialiser le mot de passe</button>
          {locked && <button className="btn" onClick={async () => { await api.post(`/users/${id}/unlock`); toast('Compte déverrouillé'); reload(); }}>🔓 Déverrouiller</button>}
          {u.id !== me.id && (u.status === 'active'
            ? <button className="btn danger" onClick={() => setStatus('disabled')}>Désactiver</button>
            : <button className="btn primary" onClick={() => setStatus('active')}>Réactiver</button>)}
        </>}
      </PageHeader>
      <Card>
        <dl className="kv">
          <dt>Rôle</dt><dd>{u.role_name}{u.permission_overrides.length > 0 && <span className="muted small"> + {u.permission_overrides.length} permission(s) ajustée(s)</span>}</dd>
          <dt>Téléphone</dt><dd>{u.phone || '—'}</dd>
          <dt>E-mail</dt><dd>{u.email || '—'}</dd>
          <dt>Dernière connexion</dt><dd>{dateTime(u.last_login_at)}</dd>
          <dt>Créé le</dt><dd>{dateTime(u.created_at)}</dd>
          <dt>Mot de passe</dt><dd>{u.must_change_password ? 'Temporaire (à changer)' : 'Personnel'}</dd>
        </dl>
      </Card>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'activity', label: 'Activité' }, { key: 'logins', label: 'Connexions' }, { key: 'history', label: 'Historique du compte' }]} />
      <Card>
        {tab === 'activity' && <Table rows={activity} columns={[
          { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) }, { key: 'action', label: 'Action', render: (r) => <code className="small">{r.action}</code> },
          { key: 'summary', label: 'Détail', render: (r) => <>{r.summary}{r.reason && <div className="muted small">Motif : {r.reason}</div>}</> },
        ]} />}
        {tab === 'logins' && <Table rows={logins} columns={[
          { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) },
          { key: 'event', label: 'Évènement', render: (r) => <Badge tone={r.event === 'login' ? 'ok' : r.event === 'logout' ? 'muted' : 'danger'}>{LABELS.login_event[r.event]}</Badge> },
          { key: 'ip', label: 'Adresse IP' }, { key: 'user_agent', label: 'Appareil', render: (r) => <span className="small muted">{(r.user_agent || '').slice(0, 80)}</span> },
        ]} />}
        {tab === 'history' && <Table rows={history} columns={[
          { key: 'created_at', label: 'Date', render: (r) => dateTime(r.created_at) }, { key: 'username', label: 'Par' }, { key: 'summary', label: 'Modification' },
          { key: 'changes', label: 'Changements', render: (r) => r.new_value ? <span className="small">{Object.keys(r.new_value).join(', ')}</span> : '' },
        ]} />}
      </Card>
      {modal === 'edit' && <EmployeeForm employee={u} onClose={() => setModal(null)} onSaved={() => { setModal(null); toast('Employé mis à jour'); reload(); }} />}
      {modal?.temp && <TempPassword user={u} password={modal.temp} onClose={() => setModal(null)} />}
    </>
  );
}
