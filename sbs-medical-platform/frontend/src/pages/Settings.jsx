import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { PageHeader, Card, useFetch, Field, ErrorBox, Empty, useToast, Table } from '../components/ui.jsx';
import { dateTime } from '../format.js';

function Section({ title, k, initial, fields, onSaved }) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState(null);
  useEffect(() => setV(initial), [initial]);
  const save = async (e) => { e.preventDefault(); setError(null); try { await api.put(`/settings/${k}`, v); onSaved(); } catch (err) { setError(err); } };
  return (
    <Card title={title}>
      <form className="form" onSubmit={save}>
        <div className="form-grid">
          {fields.map(([name, label, type = 'text', hint]) => (
            <Field key={name} label={label} hint={hint}><input type={type} value={v?.[name] ?? ''} onChange={(e) => setV({ ...v, [name]: type === 'number' ? Number(e.target.value) : e.target.value })} /></Field>
          ))}
        </div>
        <ErrorBox error={error} />
        <div className="form-actions"><button className="btn primary">Enregistrer</button></div>
      </form>
    </Card>
  );
}

export default function Settings() {
  const toast = useToast();
  const { refresh } = useAuth();
  const { data, reload } = useFetch('/settings');
  const { data: backups } = useFetch('/settings/backups');
  const [cats, setCats] = useState('');
  const [register, setRegister] = useState('');
  useEffect(() => { if (data) setCats(data.settings.expense_categories.join('\n')); }, [data]);
  if (!data) return <Empty>Chargement…</Empty>;
  const s = data.settings;
  const saved = () => { toast('Paramètres enregistrés (modification tracée)'); reload(); refresh(); };
  return (
    <>
      <PageHeader title="Paramètres" />
      <div className="grid-2">
        <Section title="Cabinet (en-tête des reçus)" k="clinic" initial={s.clinic} onSaved={saved} fields={[
          ['name', 'Nom affiché'], ['full_name', 'Raison sociale'], ['address', 'Adresse'], ['phone', 'Téléphone'], ['currency', 'Devise'],
        ]} />
        <Section title="Contrôles financiers" k="finance" initial={s.finance} onSaved={saved} fields={[
          ['expense_validation_threshold', 'Validation admin des dépenses à partir de (GNF)', 'number'],
          ['unusual_expense_threshold', 'Alerte « dépense inhabituelle » à partir de (GNF)', 'number'],
          ['discount_alert_percent', 'Alerte remise à partir de (%)', 'number'],
          ['cash_tolerance', 'Écart de caisse toléré sans alerte (GNF)', 'number'],
        ]} />
        <Section title="Sécurité" k="security" initial={s.security} onSaved={saved} fields={[
          ['max_failed_logins', 'Échecs avant verrouillage', 'number'],
          ['lock_minutes', 'Durée du verrouillage (minutes)', 'number'],
          ['failed_login_alert_threshold', 'Alerte après N échecs (30 min)', 'number'],
        ]} />
        <Section title="Stock" k="stock" initial={s.stock} onSaved={saved} fields={[['expiry_warning_days', 'Alerte expiration (jours avant)', 'number']]} />
        <Card title="Catégories de dépenses">
          <form className="form" onSubmit={async (e) => { e.preventDefault(); await api.put('/settings/expense_categories', cats.split('\n').map((c) => c.trim()).filter(Boolean)); saved(); }}>
            <Field label="Une catégorie par ligne"><textarea rows={8} value={cats} onChange={(e) => setCats(e.target.value)} /></Field>
            <div className="form-actions"><button className="btn primary">Enregistrer</button></div>
          </form>
        </Card>
        <Card title="Caisses">
          <Table rows={data.registers} columns={[{ key: 'id', label: '#' }, { key: 'name', label: 'Caisse' }]} />
          <form className="row" style={{ marginTop: 12 }} onSubmit={async (e) => { e.preventDefault(); await api.post('/settings/registers', { name: register }); setRegister(''); saved(); }}>
            <input className="grow" placeholder="Nom de la nouvelle caisse" value={register} onChange={(e) => setRegister(e.target.value)} required minLength={2} />
            <button className="btn">+ Ajouter</button>
          </form>
        </Card>
        <Card title="Sauvegardes">
          {!backups?.configured ? <p className="muted">Le répertoire des sauvegardes n'est pas monté sur ce serveur. Voir la documentation d'exploitation (sauvegarde automatique quotidienne chiffrée, copie hors serveur).</p> : (
            <>
              <p>Dernière sauvegarde : <b>{backups.last ? dateTime(backups.last.modified) : 'aucune'}</b></p>
              <Table rows={backups.files.slice(0, 10)} columns={[{ key: 'name', label: 'Fichier' }, { key: 'modified', label: 'Date', render: (r) => dateTime(r.modified) }, { key: 'size', label: 'Taille', align: 'right', render: (r) => `${(r.size / 1048576).toFixed(1)} Mo` }]} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}
