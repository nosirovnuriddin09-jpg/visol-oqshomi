/**
 * bulk_invite.js
 * Bulk Invitation Generation Module for Visol Oqshomi
 * 
 * Handles admin-only bulk creation of up to 200+ personalized invitation links.
 * Does NOT generate QR codes — only produces URL links.
 * Reuses the same db.createParticipant + getInvitationUrl logic as single invitations.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// -------------------------------------------------------
// Parse a guest name list from raw text (plain text, CSV, or XLSX-exported TSV)
// Returns: { names: string[], errors: { line: number, raw: string, reason: string }[] }
// -------------------------------------------------------
function parseGuestNames(rawText) {
  const names = [];
  const errors = [];

  if (!rawText || typeof rawText !== 'string') {
    return { names, errors };
  }

  // Split on newlines (handle \r\n, \r, \n)
  const lines = rawText.split(/\r?\n|\r/);

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;
    // Strip leading/trailing whitespace and common CSV delimiters (comma-first column, etc.)
    let cleaned = line.trim();

    // Skip empty lines
    if (!cleaned) return;

    // If line looks like a CSV row, take the first non-empty column
    // e.g. "Alisher Karimov, +998901234567"  → "Alisher Karimov"
    if (cleaned.includes(',')) {
      cleaned = cleaned.split(',')[0].trim();
    }
    // Tab-separated: take first column
    if (cleaned.includes('\t')) {
      cleaned = cleaned.split('\t')[0].trim();
    }

    // Remove surrounding quotes (from CSV exports)
    cleaned = cleaned.replace(/^["']|["']$/g, '').trim();

    // Skip empty after cleaning
    if (!cleaned) return;

    // Skip obvious header rows
    const lowerCleaned = cleaned.toLowerCase();
    if (
      lowerCleaned === 'name' ||
      lowerCleaned === 'ism' ||
      lowerCleaned === 'ism-familiya' ||
      lowerCleaned === 'full name' ||
      lowerCleaned === 'mehmon ismi' ||
      lowerCleaned === 'mehmon' ||
      lowerCleaned === 'guest name' ||
      lowerCleaned === 'no' ||
      lowerCleaned === '#'
    ) {
      return; // skip header
    }

    // Basic sanity: name should be at least 2 chars and not purely numeric
    if (cleaned.length < 2) {
      errors.push({ line: lineNumber, raw: line, reason: 'Juda qisqa ism (2 ta belgidan kam)' });
      return;
    }
    if (/^\d+$/.test(cleaned)) {
      errors.push({ line: lineNumber, raw: line, reason: 'Raqamdan iborat satr (ism emas)' });
      return;
    }

    names.push(cleaned);
  });

  return { names, errors };
}

// -------------------------------------------------------
// Generate a unique ticket ID: #VO-XXXX-NNNN
// -------------------------------------------------------
function generateUniqueTicketId(db) {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let attempts = 0;
  while (attempts < 20) {
    let hash = '';
    for (let i = 0; i < 4; i++) {
      hash += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const randNum = Math.floor(1000 + Math.random() * 9000);
    const id = `#VO-${hash}-${randNum}`;
    if (!db.getParticipantByTicketId(id)) {
      return id;
    }
    attempts++;
  }
  // Fallback with timestamp
  return `#VO-BLK-${Date.now().toString(36).toUpperCase()}`;
}

// -------------------------------------------------------
// Core: Create one invitation record (admin, pre-paid)
// eventData fields must match db.createParticipant signature
// -------------------------------------------------------
function createOneInvitation(db, { guestName, eventData, adminTelegramId }) {
  const uniqueTicketId = generateUniqueTicketId(db);
  const record = db.createParticipant({
    telegram_id: adminTelegramId || null,
    full_name: guestName,
    guest_name: guestName,
    phone: '',
    guests_count: 1,
    comment: '',
    unique_ticket_id: uniqueTicketId,
    ticket_id: uniqueTicketId,
    couple_names: eventData.couple_names || '',
    groom_bride: eventData.couple_names || '',
    venue_name: eventData.venue_name || '',
    venue_address: eventData.venue_address || '',
    event_date_time: eventData.event_date_time || '',
    event_date: eventData.event_date_time || '',
    event_type: eventData.event_type || 'Nikoh to\'yi',
    design: eventData.design || 'visol',
    music: eventData.music || 'music1',
    family_names: eventData.family_names || '',
    quantity: 1,
    total_price: 0,
    // Admin bulk orders are pre-approved — bypass payment
    payment_status: 'paid',
    username: null
  });
  return record;
}

// -------------------------------------------------------
// Build result text for Telegram (chunked for 4096-char limit)
// -------------------------------------------------------
function buildResultLines(results, getInvitationUrl) {
  const lines = [];
  results.forEach((r, idx) => {
    if (r.success) {
      const url = getInvitationUrl(r.ticket);
      lines.push(`${idx + 1}. ${r.name} → ${url}`);
    } else {
      lines.push(`${idx + 1}. ❌ ${r.name} — Xato: ${r.error}`);
    }
  });
  return lines;
}

// -------------------------------------------------------
// Split text into chunks of maxLength characters, breaking on newlines
// -------------------------------------------------------
function chunkText(lines, maxLength = 3800) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const toAdd = (current ? '\n' : '') + line;
    if ((current + toAdd).length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += toAdd;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// -------------------------------------------------------
// Save a .txt results file to the data directory
// Returns the file path
// -------------------------------------------------------
function saveResultsFile(results, getInvitationUrl, label) {
  const lines = buildResultLines(results, getInvitationUrl);
  const header = [
    `Visol Oqshomi — Ommaviy Taklifnoma Havolalari`,
    `Tadbir: ${label || 'Maxsus Tadbir'}`,
    `Yaratilgan vaqt: ${new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}`,
    `Jami: ${results.length} ta`,
    `━`.repeat(50),
    ''
  ];
  const content = header.join('\n') + lines.join('\n');
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const filename = `bulk_invites_${Date.now()}.txt`;
  const filepath = path.join(dataDir, filename);
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

// -------------------------------------------------------
// Helper: Check if a user is an authorized admin owner
// Handles numbers, strings, whitespace, surrounding quotes, and comma-separated IDs
// -------------------------------------------------------
function isAdminOwner(userId, configuredAdminId) {
  if (!userId) return false;
  const cleanUser = String(userId).trim();
  const configured = String(
    configuredAdminId !== undefined && configuredAdminId !== null
      ? configuredAdminId
      : (process.env.ADMIN_OWNER_ID || '6770205751')
  ).trim().replace(/['"]/g, '');

  const allowed = configured
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);

  // Guarantee fallback owner 6770205751 is always recognized
  if (!allowed.includes('6770205751')) {
    allowed.push('6770205751');
  }

  return allowed.includes(cleanUser);
}

module.exports = {
  isAdminOwner,
  parseGuestNames,
  generateUniqueTicketId,
  createOneInvitation,
  buildResultLines,
  chunkText,
  saveResultsFile
};
