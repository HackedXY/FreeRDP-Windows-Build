import { Component } from 'react';

/**
 * Garde d'erreur globale : une erreur d'affichage n'efface plus toute l'application
 * (écran blanc). Un message est affiché et l'utilisateur peut réessayer ou revenir
 * à l'accueil. `resetKey` (ex. l'adresse de la page) réinitialise la garde.
 * Aucune donnée (médicale ou autre) n'est affichée ni transmise.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error) {
    // message technique seulement, pour le diagnostic en local
    console.error('Erreur d\'affichage :', error?.message);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" role="alert" style={{ maxWidth: 560, margin: '40px auto', textAlign: 'center' }}>
        <h1 style={{ marginBottom: 8 }}>Un problème d'affichage est survenu</h1>
        <p className="muted">Cette page n'a pas pu s'afficher. Vos données ne sont pas perdues.</p>
        <div className="form-actions" style={{ justifyContent: 'center', marginTop: 16 }}>
          <button type="button" className="btn primary" onClick={() => this.setState({ error: null })}>Réessayer</button>
          <a className="btn ghost" href="/">Retour à l'accueil</a>
        </div>
      </div>
    );
  }
}
