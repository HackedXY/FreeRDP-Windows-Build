export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const badRequest = (m, d) => new HttpError(400, m, d);
export const unauthorized = (m = 'Authentification requise') => new HttpError(401, m);
export const forbidden = (m = 'Accès non autorisé') => new HttpError(403, m);
export const notFound = (m = 'Élément introuvable') => new HttpError(404, m);
export const conflict = (m) => new HttpError(409, m);

/** Enveloppe un handler async pour transmettre les erreurs à Express. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Valide req.body (ou autre) avec un schéma zod. */
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw badRequest('Données invalides : ' + details.map((d) => `${d.field || 'champ'} — ${d.message}`).join(' ; '), details);
  }
  return r.data;
}
