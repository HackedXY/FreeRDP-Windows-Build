import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { makeContext } from './lib/realtime.js';
import { attachUser, requireAuth } from './lib/auth.js';
import { HttpError } from './lib/errors.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import roleRoutes from './routes/roles.js';
import patientRoutes from './routes/patients.js';
import consultationRoutes from './routes/consultations.js';
import actRoutes from './routes/acts.js';
import paymentRoutes from './routes/payments.js';
import cashRoutes from './routes/cash.js';
import expenseRoutes from './routes/expenses.js';
import pharmacyRoutes from './routes/pharmacy.js';
import supplierRoutes from './routes/suppliers.js';
import labRoutes from './routes/lab.js';
import appointmentRoutes from './routes/appointments.js';
import dashboardRoutes from './routes/dashboard.js';
import reportRoutes from './routes/reports.js';
import { search, alerts, auditRoutes, notifications, settings } from './routes/misc.js';
import { pool } from './db/pool.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        frameSrc: ["'self'", 'blob:'],
        objectSrc: ["'self'", 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Contexte de requête + émission temps réel différée (uniquement si succès)
  app.use((req, res, next) => {
    req.ctx = makeContext({ ip: req.ip, userAgent: req.get('user-agent') || null });
    res.on('finish', () => (res.statusCode < 400 ? req.ctx.flush() : req.ctx.discard()));
    next();
  });

  app.get('/api/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok', time: new Date() }); } catch { res.status(503).json({ status: 'db_unavailable' }); }
  });

  // Protection CSRF : les requêtes d'écriture doivent porter un en-tête personnalisé
  // (impossible à forger depuis un autre site sans CORS, que nous n'autorisons pas).
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.get('X-SBS-Client') || req.headers.authorization) return next();
    next(new HttpError(403, 'Requête refusée (en-tête X-SBS-Client manquant).'));
  });

  app.use('/api', attachUser);
  app.use('/api/auth', authRoutes);
  app.use('/api', requireAuth);
  app.use('/api/users', userRoutes);
  app.use('/api/roles', roleRoutes);
  app.use('/api/patients', patientRoutes);
  app.use('/api/consultations', consultationRoutes);
  app.use('/api/acts', actRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/cash', cashRoutes);
  app.use('/api/expenses', expenseRoutes);
  app.use('/api/pharmacy', pharmacyRoutes);
  app.use('/api/suppliers', supplierRoutes);
  app.use('/api/lab', labRoutes);
  app.use('/api/appointments', appointmentRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/search', search);
  app.use('/api/alerts', alerts);
  app.use('/api/audit', auditRoutes);
  app.use('/api/notifications', notifications);
  app.use('/api/settings', settings);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Ressource inconnue')));

  // Application web (build du frontend)
  if (config.staticDir && fs.existsSync(config.staticDir)) {
    app.use(express.static(config.staticDir, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(config.staticDir, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = err.status || 500;
    let message = err.message;
    if (err.code === '23505') { status = 409; message = 'Doublon : cet élément existe déjà.'; }
    else if (err.code === '23503') { status = 400; message = 'Référence invalide (élément lié introuvable).'; }
    else if (err.code === '23514') { status = 400; message = 'Valeur non autorisée.'; }
    else if (err.code === 'LIMIT_FILE_SIZE') { status = 400; message = 'Fichier trop volumineux (8 Mo max).'; }
    else if (err.type === 'entity.parse.failed') { status = 400; message = 'JSON invalide'; }
    if (status >= 500) {
      console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
      message = 'Erreur interne du serveur';
    }
    res.status(status).json({ error: message, code: err.code && typeof err.code === 'string' && !/^\d/.test(err.code) ? err.code : undefined, details: err.details });
  });
  return app;
}
