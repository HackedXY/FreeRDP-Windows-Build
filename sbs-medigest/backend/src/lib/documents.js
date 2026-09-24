// Documents officiels (PDF A4) : en-tête du cabinet, identification du document,
// code de vérification. Le code est une empreinte HMAC (clé dérivée hors base) du
// type, du numéro et de la date d'émission : il permet au cabinet de confirmer
// l'authenticité d'un document présenté, sans exposer aucune donnée médicale.
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { config } from '../config.js';

const verifyKey = () => crypto.createHmac('sha256', config.dataKey).update('sbs-document-verify-v1').digest();

export const DOC_TYPES = {
  ordonnance: 'Ordonnance',
  certificat: 'Certificat médical',
  compte_rendu: 'Compte rendu d\'examens',
  facture: 'Facture',
};

export function verificationCode(type, number, issuedAt) {
  const iso = new Date(issuedAt).toISOString();
  const h = crypto.createHmac('sha256', verifyKey()).update(`${type}|${number}|${iso}`).digest('hex').toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

export function checkVerificationCode(type, number, issuedAt, code) {
  const a = Buffer.from(verificationCode(type, number, issuedAt));
  const b = Buffer.from(String(code || '').toUpperCase().trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('fr-FR', { timeZone: config.timezone }) : '—');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('fr-FR', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'short' }) : '—');

export function ageOf(birth, at = new Date()) {
  if (!birth) return null;
  const b = new Date(birth); const n = new Date(at);
  let a = n.getFullYear() - b.getFullYear();
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--;
  return a;
}

/**
 * Ouvre un PDF A4 et l'envoie dans la réponse HTTP. `draw(doc, helpers)` dessine le corps.
 * Les réponses ne sont jamais mises en cache (données médicales / financières).
 */
export function sendPdf(res, { filename, clinic, title, type, number, issuedAt, watermark = null }, draw) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 64, left: 50, right: 50 }, bufferPages: true, info: { Title: `${title} ${number}`, Author: clinic.name } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  doc.pipe(res);
  const W = doc.page.width - 100;
  const code = verificationCode(type, number, issuedAt);

  // En-tête : identité du cabinet
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#0f4c81').text(clinic.name, 50, 48, { width: W * 0.62 });
  if (clinic.full_name) doc.font('Helvetica').fontSize(9).fillColor('#333').text(clinic.full_name, { width: W * 0.62 });
  doc.font('Helvetica').fontSize(9).fillColor('#333').text(clinic.address || '', { width: W * 0.62 });
  if (clinic.phone) doc.text(`Tél. ${clinic.phone}`, { width: W * 0.62 });
  if (clinic.registration) doc.text(`Autorisation : ${clinic.registration}`, { width: W * 0.62 });
  // identifiants fiscaux : sur les documents financiers
  if (type === 'facture' && (clinic.tax_id || clinic.rccm)) {
    doc.text([clinic.tax_id && `NIF : ${clinic.tax_id}`, clinic.rccm && `RCCM : ${clinic.rccm}`].filter(Boolean).join(' — '), { width: W * 0.62 });
  }
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text(`N° ${number}`, 50 + W * 0.62, 50, { width: W * 0.38, align: 'right' });
  doc.font('Helvetica').fontSize(9).text(`Date : ${fmtDate(issuedAt)}`, { width: W * 0.38, align: 'right' });
  const top = Math.max(doc.y, 110) + 8;
  doc.moveTo(50, top).lineTo(50 + W, top).lineWidth(1.2).strokeColor('#0f4c81').stroke();
  doc.font('Helvetica-Bold').fontSize(17).fillColor('#111').text(title.toUpperCase(), 50, top + 14, { width: W, align: 'center' });
  if (watermark) doc.font('Helvetica-Bold').fontSize(11).fillColor('#b91c1c').text(watermark, { width: W, align: 'center' }).fillColor('#111');
  doc.moveDown(1);
  doc.font('Helvetica').fontSize(10.5).fillColor('#111');

  const helpers = {
    W,
    row(label, value) {
      doc.font('Helvetica').fontSize(10).fillColor('#555').text(`${label} `, { continued: true })
        .font('Helvetica-Bold').fillColor('#111').text(value ?? '—');
    },
    section(label) {
      doc.moveDown(0.6).font('Helvetica-Bold').fontSize(11).fillColor('#0f4c81').text(label).fillColor('#111');
      doc.moveTo(50, doc.y + 1).lineTo(50 + W, doc.y + 1).lineWidth(0.5).strokeColor('#c9d6e3').stroke();
      doc.moveDown(0.4).font('Helvetica').fontSize(10.5);
    },
    ensureSpace(h) { if (doc.y + h > doc.page.height - 80) doc.addPage(); },
  };
  draw(doc, helpers);

  // Pied de page : identification et code de vérification sur chaque page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // écriture dans la marge basse sans créer de nouvelle page
    const y = doc.page.height - 50;
    doc.moveTo(50, y - 6).lineTo(50 + W, y - 6).lineWidth(0.5).strokeColor('#c9d6e3').stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor('#666')
      .text(`${DOC_TYPES[type] || title} ${number} — émis le ${fmtDateTime(issuedAt)} — code de vérification ${code} — page ${i - range.start + 1}/${range.count}`,
        50, y, { width: W, align: 'center', lineBreak: false });
    doc.text(clinic.legal_mentions || 'Document confidentiel. Authenticité vérifiable auprès du cabinet avec le numéro et le code de vérification.', 50, y + 10, { width: W, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return code;
}
