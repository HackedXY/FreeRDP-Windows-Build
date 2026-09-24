// Client HTTP minimal : cookie de session httpOnly + en-tête anti-CSRF
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Erreur ${status}`);
    this.status = status;
    this.code = body?.code;
    this.details = body?.details;
  }
}

let onUnauthorized = () => {};
let onPasswordChange = () => {};
export function setAuthHandlers(h) { onUnauthorized = h.onUnauthorized; onPasswordChange = h.onPasswordChange; }

async function request(method, url, body, opts = {}) {
  const headers = { 'X-SBS-Client': 'web', ...(opts.headers || {}) };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`/api${url}`, { method, headers, body: payload, credentials: 'same-origin' });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && !url.startsWith('/auth/login')) onUnauthorized();
    if (err.code === 'PASSWORD_CHANGE_REQUIRED') onPasswordChange();
    throw err;
  }
  return data;
}

export const api = {
  get: (url, params) => {
    const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString() : '';
    return request('GET', url + qs);
  },
  post: (url, body, opts) => request('POST', url, body ?? {}, opts),
  put: (url, body) => request('PUT', url, body),
  del: (url, body) => request('DELETE', url, body ?? {}),
};
