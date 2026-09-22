import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { Field, ErrorBox, useToast } from '../components/ui.jsx';

export function Login() {
  const { login } = useAuth();
  const [f, setF] = useState({ username: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await login(f.username.trim(), f.password); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="login-page">
      <form className="login-card form" onSubmit={submit}>
        <div className="brand"><img src="/icon.svg" alt="" /><div><b>CABINET MÉDICAL SBS</b><span>Sounkaro Bakary Souaré — Siguiri</span></div></div>
        <Field label="Identifiant"><input autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required autoFocus /></Field>
        <Field label="Mot de passe"><input type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></Field>
        <ErrorBox error={error} />
        <button className="btn primary" disabled={busy}>{busy ? 'Connexion…' : 'Se connecter'}</button>
        <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>Accès réservé au personnel du cabinet. Toutes les connexions sont enregistrées.</p>
      </form>
    </div>
  );
}

export function ChangePassword({ forced }) {
  const { refresh, logout, user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    if (f.newPassword !== f.confirm) return setError(new Error('Les deux mots de passe ne correspondent pas.'));
    try {
      await api.post('/auth/change-password', { currentPassword: f.currentPassword, newPassword: f.newPassword });
      toast('Mot de passe modifié');
      await refresh();
      if (!forced) nav('/');
    } catch (err) { setError(err); }
  };
  const form = (
    <form className="form" onSubmit={submit} style={{ maxWidth: 420 }}>
      {forced && <div className="alert-box info">Bienvenue {user.firstName} ! Pour des raisons de sécurité, choisissez votre mot de passe personnel.</div>}
      <Field label="Mot de passe actuel (ou temporaire)"><input type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} required /></Field>
      <Field label="Nouveau mot de passe" hint="8 caractères minimum, lettres et chiffres."><input type="password" autoComplete="new-password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} required minLength={8} /></Field>
      <Field label="Confirmer"><input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required /></Field>
      <ErrorBox error={error} />
      <div className="form-actions">
        {forced && <button type="button" className="btn ghost" onClick={logout}>Se déconnecter</button>}
        <button className="btn primary">Enregistrer</button>
      </div>
    </form>
  );
  if (forced) return <div className="login-page"><div className="login-card"><h1 style={{ marginBottom: 16 }}>Nouveau mot de passe</h1>{form}</div></div>;
  return <div className="card"><h1 style={{ marginBottom: 16 }}>Changer mon mot de passe</h1>{form}</div>;
}
