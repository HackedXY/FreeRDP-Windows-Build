import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { Field, ErrorBox, useToast } from '../components/ui.jsx';

export function Login() {
  const { login, loginMfa, expired } = useAuth();
  const [f, setF] = useState({ username: '', password: '' });
  const [mfa, setMfa] = useState(null); // { token } : deuxième étape (double authentification)
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await login(f.username.trim(), f.password);
      if (r?.mfa_required) { setMfa({ token: r.mfa_token }); setF((x) => ({ ...x, password: '' })); }
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const submitMfa = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await loginMfa(mfa.token, useRecovery ? { recoveryCode: code } : { code }); } catch (err) {
      setError(err);
      if (err.status === 401 && /expirée/.test(err.message)) { setMfa(null); setCode(''); }
    } finally { setBusy(false); }
  };
  const brand = <div className="brand"><img src="/icon.svg" alt="" /><div><b>CABINET MÉDICAL SBS</b><span>Sounkaro Bakary Souaré — Siguiri</span></div></div>;
  if (mfa) {
    return (
      <div className="login-page">
        <form className="login-card form" onSubmit={submitMfa}>
          {brand}
          <div className="alert-box info">Double authentification : {useRecovery ? 'saisissez un de vos codes de récupération.' : 'saisissez le code à 6 chiffres affiché par votre application d\'authentification.'}</div>
          <Field label={useRecovery ? 'Code de récupération' : 'Code de vérification'}>
            <input autoComplete="one-time-code" inputMode={useRecovery ? 'text' : 'numeric'} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus maxLength={useRecovery ? 20 : 6} />
          </Field>
          <ErrorBox error={error} />
          <button className="btn primary" disabled={busy}>{busy ? 'Vérification…' : 'Valider'}</button>
          <button type="button" className="btn ghost" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }}>
            {useRecovery ? 'Utiliser le code de l\'application' : 'Utiliser un code de récupération'}
          </button>
          <button type="button" className="btn ghost" onClick={() => { setMfa(null); setCode(''); setError(null); }}>Annuler</button>
        </form>
      </div>
    );
  }
  return (
    <div className="login-page">
      <form className="login-card form" onSubmit={submit}>
        {brand}
        {expired && <div className="alert-box info">Votre session a expiré (inactivité ou durée maximale). Reconnectez-vous.</div>}
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
  return (
    <>
      <div className="card"><h1 style={{ marginBottom: 16 }}>Changer mon mot de passe</h1>{form}</div>
      {user.superadmin && <MfaSettings />}
    </>
  );
}

/** Double authentification (TOTP) — compte propriétaire. */
export function MfaSettings({ onDone }) {
  const toast = useToast();
  const [st, setSt] = useState(null);
  const [step, setStep] = useState(null); // 'setup' | 'confirm' | 'disable' | 'regen'
  const [f, setF] = useState({ password: '', code: '', recovery_code: '' });
  const [setup, setSetup] = useState(null);
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState(null);
  const load = () => api.get('/auth/mfa').then(setSt).catch(setError);
  useEffect(() => { load(); }, []);
  const reset = () => { setStep(null); setF({ password: '', code: '', recovery_code: '' }); setError(null); };
  const run = async (fn) => { setError(null); try { await fn(); } catch (err) { setError(err); } };

  const startSetup = (e) => { e.preventDefault(); run(async () => {
    // changement d'appareil : le second facteur actuel est exigé
    const body = st.enabled ? secondFactor() : { password: f.password };
    setSetup(await api.post('/auth/mfa/setup', body)); setStep('confirm'); setF({ password: '', code: '', recovery_code: '' });
  }); };
  const confirm = (e) => { e.preventDefault(); run(async () => {
    const r = await api.post('/auth/mfa/confirm', { code: f.code }); setCodes(r.recovery_codes); setSetup(null); reset(); toast('Double authentification activée'); load(); onDone?.();
  }); };
  const secondFactor = () => ({ password: f.password, ...(f.recovery_code ? { recovery_code: f.recovery_code } : { code: f.code }) });
  const disable = (e) => { e.preventDefault(); run(async () => {
    await api.post('/auth/mfa/disable', secondFactor()); reset(); setCodes(null); toast('Double authentification désactivée', 'warn'); load();
  }); };
  const regen = (e) => { e.preventDefault(); run(async () => {
    const r = await api.post('/auth/mfa/recovery-codes', secondFactor()); setCodes(r.recovery_codes); reset(); load();
  }); };

  if (!st) return null;
  const pwd = <Field label="Mot de passe actuel"><input type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></Field>;
  const factor = (
    <>
      <Field label="Code de l'application (6 chiffres)"><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value, recovery_code: '' })} /></Field>
      <Field label="… ou un code de récupération"><input value={f.recovery_code} onChange={(e) => setF({ ...f, recovery_code: e.target.value, code: '' })} /></Field>
    </>
  );
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginBottom: 8 }}>Double authentification (TOTP)</h2>
      <p className="muted small">Protège le compte propriétaire : à la connexion, un code à 6 chiffres généré par une application d'authentification (Google Authenticator, Aegis, FreeOTP…) est demandé en plus du mot de passe.</p>
      <p>État : <b>{st.enabled ? `activée${st.recovery_codes_remaining !== undefined ? ` — ${st.recovery_codes_remaining} code(s) de récupération disponible(s)` : ''}` : 'désactivée'}</b></p>
      {codes && (
        <div className="alert-box warn">
          <b>Codes de récupération — notez-les maintenant, ils ne seront plus affichés.</b> Chaque code ne sert qu'une fois, en cas de perte du téléphone.
          <pre style={{ userSelect: 'all', marginTop: 8 }}>{codes.join('\n')}</pre>
          <button type="button" className="btn ghost small" onClick={() => setCodes(null)}>J'ai conservé ces codes</button>
        </div>
      )}
      {!st.enabled && !step && <button className="btn primary" onClick={() => setStep('setup')}>Activer la double authentification</button>}
      {st.required && !st.enabled && <div className="alert-box warn">Obligatoire pour le compte propriétaire : l'accès à la plateforme est bloqué tant qu'elle n'est pas activée.</div>}
      {step === 'setup' && (
        <form className="form" onSubmit={startSetup} style={{ maxWidth: 420 }}>{pwd}{st.enabled && factor}<ErrorBox error={error} />
          <div className="form-actions"><button type="button" className="btn ghost" onClick={reset}>Annuler</button><button className="btn primary">Continuer</button></div></form>
      )}
      {step === 'confirm' && setup && (
        <form className="form" onSubmit={confirm} style={{ maxWidth: 520 }}>
          <div className="alert-box info">Dans l'application d'authentification, ajoutez un compte avec la clé ci-dessous (saisie manuelle, type « basé sur l'heure »), puis saisissez le code affiché.</div>
          <Field label="Clé secrète"><input readOnly value={setup.secret} onFocus={(e) => e.target.select()} style={{ fontFamily: 'monospace' }} /></Field>
          <p className="small muted" style={{ wordBreak: 'break-all' }}>Lien de configuration : <a href={setup.otpauth_uri}>{setup.otpauth_uri}</a></p>
          <Field label="Code à 6 chiffres"><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required autoFocus /></Field>
          <ErrorBox error={error} />
          <div className="form-actions"><button type="button" className="btn ghost" onClick={() => { reset(); setSetup(null); }}>Annuler</button><button className="btn primary">Activer</button></div>
        </form>
      )}
      {st.enabled && !step && (
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn ghost" onClick={() => setStep('regen')}>Nouveaux codes de récupération</button>
          <button className="btn ghost" onClick={() => setStep('setup')}>Changer d'appareil</button>
          {!st.required && <button className="btn danger" onClick={() => setStep('disable')}>Désactiver</button>}
        </div>
      )}
      {(step === 'disable' || step === 'regen') && (
        <form className="form" onSubmit={step === 'disable' ? disable : regen} style={{ maxWidth: 420 }}>
          {pwd}{factor}<ErrorBox error={error} />
          <div className="form-actions"><button type="button" className="btn ghost" onClick={reset}>Annuler</button>
            <button className={`btn ${step === 'disable' ? 'danger' : 'primary'}`}>{step === 'disable' ? 'Désactiver la double authentification' : 'Générer de nouveaux codes'}</button></div>
        </form>
      )}
    </div>
  );
}

/** Écran bloquant : 2FA obligatoire pour le propriétaire tant qu'elle n'est pas activée. */
export function ForcedMfaSetup() {
  const { logout, refresh } = useAuth();
  const [done, setDone] = useState(false);
  return (
    <div className="login-page">
      <div className="login-card" style={{ maxWidth: 620 }}>
        <MfaSettings onDone={() => setDone(true)} />
        <div className="form-actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn ghost" onClick={logout}>Se déconnecter</button>
          {done && <button type="button" className="btn primary" onClick={refresh}>Accéder à la plateforme</button>}
        </div>
      </div>
    </div>
  );
}
