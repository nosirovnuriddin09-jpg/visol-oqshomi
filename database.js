/**
 * Database Module for Visol Oqshomi Mini App
 * Manages SQLite persistence for registered wedding/gala participants.
 * Automatically utilizes Node 22+ built-in node:sqlite, better-sqlite3, or sqlite3,
 * with a resilient JSON backup layer if needed.
 */

const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_FILE = path.join(DB_DIR, 'database.sqlite');
const BACKUP_JSON = path.join(DB_DIR, 'participants.json');

class DatabaseManager {
  constructor() {
    this.driver = null;
    this.db = null;
    this.init();
  }

  init() {
    // 1. Try Node 22+ built-in node:sqlite
    try {
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(DB_FILE);
      this.driver = 'node:sqlite';
      this.initSchemaBuiltIn();
      console.log(`[Database] Connected successfully using built-in Node.js SQLite (${DB_FILE})`);
      return;
    } catch (err) {
      // Not on Node 22+ or node:sqlite not available
    }

    // 2. Try better-sqlite3
    try {
      const Database = require('better-sqlite3');
      this.db = new Database(DB_FILE);
      this.driver = 'better-sqlite3';
      this.initSchemaBetterSqlite();
      console.log(`[Database] Connected successfully using better-sqlite3 (${DB_FILE})`);
      return;
    } catch (err) {
      // better-sqlite3 not installed or native error
    }

    // 3. Resilient File-backed JSON store fallback
    console.warn(`[Database] SQLite native drivers unavailable. Falling back to persistent JSON storage (${BACKUP_JSON})`);
    this.driver = 'json';
    if (!fs.existsSync(BACKUP_JSON)) {
      fs.writeFileSync(BACKUP_JSON, JSON.stringify([], null, 2), 'utf-8');
    }
  }

  initSchemaBuiltIn() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT,
        full_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        guests_count INTEGER NOT NULL DEFAULT 1,
        comment TEXT,
        unique_ticket_id TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        couple_names TEXT,
        venue_name TEXT,
        venue_address TEXT,
        event_date_time TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_id ON participants(unique_ticket_id);
      CREATE INDEX IF NOT EXISTS idx_tg_id ON participants(telegram_id);

      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        trans_id TEXT UNIQUE NOT NULL,
        merchant_trans_id TEXT NOT NULL,
        amount REAL NOT NULL,
        state INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        telegram_id TEXT,
        ticket_id TEXT,
        create_time INTEGER DEFAULT 0,
        perform_time INTEGER DEFAULT 0,
        cancel_time INTEGER DEFAULT 0,
        reason INTEGER,
        raw_payload TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_trans_id ON transactions(trans_id);
      CREATE INDEX IF NOT EXISTS idx_trans_merchant ON transactions(merchant_trans_id);
    `);
    this.ensureColumns();
  }

  initSchemaBetterSqlite() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT,
        full_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        guests_count INTEGER NOT NULL DEFAULT 1,
        comment TEXT,
        unique_ticket_id TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        couple_names TEXT,
        venue_name TEXT,
        venue_address TEXT,
        event_date_time TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_id ON participants(unique_ticket_id);
      CREATE INDEX IF NOT EXISTS idx_tg_id ON participants(telegram_id);

      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        trans_id TEXT UNIQUE NOT NULL,
        merchant_trans_id TEXT NOT NULL,
        amount REAL NOT NULL,
        state INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        telegram_id TEXT,
        ticket_id TEXT,
        create_time INTEGER DEFAULT 0,
        perform_time INTEGER DEFAULT 0,
        cancel_time INTEGER DEFAULT 0,
        reason INTEGER,
        raw_payload TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_trans_id ON transactions(trans_id);
      CREATE INDEX IF NOT EXISTS idx_trans_merchant ON transactions(merchant_trans_id);
    `);
    this.ensureColumns();
  }

  ensureColumns() {
    const cols = [
      'couple_names', 
      'venue_name', 
      'venue_address', 
      'event_date_time',
      'ticket_id',
      'groom_bride',
      'guest_name',
      'event_date',
      'event_type',
      'payment_status',
      'total_price',
      'receipt_file_id',
      'username',
      'payment_msg_id'
    ];
    for (const c of cols) {
      try {
        this.db.exec(`ALTER TABLE participants ADD COLUMN ${c} TEXT`);
      } catch {}
    }
  }

  /**
   * Save a newly registered participant
   */
  createParticipant({ telegram_id, full_name, guest_name, phone, guests_count, comment, unique_ticket_id, ticket_id, couple_names, groom_bride, venue_name, venue_address, event_date_time, event_date, event_type, payment_status, total_price, username }) {
    const cleanTgId = telegram_id ? String(telegram_id) : null;
    const cleanFullName = String(full_name || guest_name || '').trim();
    const cleanPhone = String(phone || '').trim();
    const cleanCount = Math.max(1, parseInt(guests_count, 10) || 1);
    const cleanComment = comment ? String(comment).trim() : '';
    const cleanTicketId = String(ticket_id || unique_ticket_id || '').trim();
    const cleanCouple = couple_names || groom_bride ? String(couple_names || groom_bride).trim() : null;
    const cleanVenue = venue_name ? String(venue_name).trim() : null;
    const cleanAddr = venue_address ? String(venue_address).trim() : null;
    const cleanDateTime = event_date_time || event_date ? String(event_date_time || event_date).trim() : null;
    const cleanEventType = event_type ? String(event_type).trim() : 'Nikoh toʻyi';
    const cleanPaymentStatus = payment_status || 'pending_payment';
    const cleanTotalPrice = total_price !== undefined ? parseFloat(total_price) : 2000;
    const cleanUsername = username ? String(username).trim() : null;
    const now = new Date().toISOString();

    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare(`
        INSERT INTO participants (
          telegram_id, full_name, guest_name, phone, guests_count, comment, 
          unique_ticket_id, ticket_id, created_at, 
          couple_names, groom_bride, venue_name, venue_address, event_date_time, event_date,
          event_type, payment_status, total_price, username
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        cleanTgId, cleanFullName, cleanFullName, cleanPhone, cleanCount, cleanComment,
        cleanTicketId, cleanTicketId, now,
        cleanCouple, cleanCouple, cleanVenue, cleanAddr, cleanDateTime, cleanDateTime,
        cleanEventType, cleanPaymentStatus, cleanTotalPrice, cleanUsername
      );
      return this.getParticipantByTicketId(cleanTicketId);
    }

    // JSON fallback
    const list = this.readJson();
    const newEntry = {
      id: list.length + 1,
      telegram_id: cleanTgId,
      full_name: cleanFullName,
      guest_name: cleanFullName,
      phone: cleanPhone,
      guests_count: cleanCount,
      comment: cleanComment,
      unique_ticket_id: cleanTicketId,
      ticket_id: cleanTicketId,
      couple_names: cleanCouple,
      groom_bride: cleanCouple,
      venue_name: cleanVenue,
      venue_address: cleanAddr,
      event_date_time: cleanDateTime,
      event_date: cleanDateTime,
      event_type: cleanEventType,
      payment_status: cleanPaymentStatus,
      total_price: cleanTotalPrice,
      username: cleanUsername,
      created_at: now
    };
    list.push(newEntry);
    this.writeJson(list);
    return newEntry;
  }

  /**
   * Get participant by unique ticket ID (supports with or without '#' prefix)
   */
  getParticipantByTicketId(ticketId) {
    if (!ticketId) return null;
    const cleanId = String(ticketId).trim();
    const withHash = cleanId.startsWith('#') ? cleanId : `#${cleanId}`;
    const withoutHash = cleanId.replace(/^#/, '');

    let row = null;
    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare(`
        SELECT * FROM participants 
        WHERE unique_ticket_id = ? OR unique_ticket_id = ? 
           OR ticket_id = ? OR ticket_id = ?
        ORDER BY id DESC LIMIT 1
      `);
      row = stmt.get(withHash, withoutHash, withHash, withoutHash) || null;
    } else {
      const list = this.readJson();
      row = list.slice().reverse().find((p) => {
        const pid = String(p.unique_ticket_id || p.ticket_id || '').toUpperCase();
        return pid === withHash.toUpperCase() || pid === withoutHash.toUpperCase();
      }) || null;
    }

    if (!row) return null;

    // Return uniform normalized entity with all standard field aliases
    return {
      id: row.id,
      telegram_id: row.telegram_id,
      ticket_id: row.unique_ticket_id || row.ticket_id,
      unique_ticket_id: row.unique_ticket_id || row.ticket_id,
      guest_name: row.full_name || row.guest_name,
      full_name: row.full_name || row.guest_name,
      groom_bride: row.couple_names || row.groom_bride,
      couple_names: row.couple_names || row.groom_bride,
      venue_name: row.venue_name,
      venue_address: row.venue_address,
      event_date: row.event_date_time || row.event_date,
      event_date_time: row.event_date_time || row.event_date,
      event_type: row.event_type || 'Nikoh toʻyi',
      phone: row.phone,
      guests_count: row.guests_count,
      comment: row.comment,
      payment_status: row.payment_status || 'unpaid',
      total_price: row.total_price !== undefined && row.total_price !== null ? parseFloat(row.total_price) : 2000,
      receipt_file_id: row.receipt_file_id || null,
      username: row.username || null,
      created_at: row.created_at
    };
  }

  _formatRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      telegram_id: row.telegram_id,
      ticket_id: row.unique_ticket_id || row.ticket_id,
      unique_ticket_id: row.unique_ticket_id || row.ticket_id,
      guest_name: row.full_name || row.guest_name,
      full_name: row.full_name || row.guest_name,
      groom_bride: row.couple_names || row.groom_bride,
      couple_names: row.couple_names || row.groom_bride,
      venue_name: row.venue_name,
      venue_address: row.venue_address,
      event_date: row.event_date_time || row.event_date,
      event_date_time: row.event_date_time || row.event_date,
      event_type: row.event_type || 'Nikoh toʻyi',
      phone: row.phone,
      guests_count: row.guests_count,
      comment: row.comment,
      payment_status: row.payment_status || 'unpaid',
      total_price: row.total_price !== undefined && row.total_price !== null ? parseFloat(row.total_price) : 2000,
      receipt_file_id: row.receipt_file_id || null,
      username: row.username || null,
      payment_msg_id: row.payment_msg_id || null,
      created_at: row.created_at
    };
  }

  /**
   * Get latest participant by Telegram User ID
   */
  getParticipantByTelegramId(telegramId) {
    if (!telegramId) return null;
    const cleanTgId = String(telegramId).trim();
    let row = null;

    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare('SELECT * FROM participants WHERE telegram_id = ? ORDER BY id DESC LIMIT 1');
      row = stmt.get(cleanTgId) || null;
    } else {
      const list = this.readJson();
      row = list.filter((p) => p.telegram_id === cleanTgId).pop() || null;
    }

    return this._formatRow(row);
  }

  /**
   * Get all unpaid participants for a Telegram ID (pending_payment or unpaid)
   */
  getUnpaidParticipantsByTelegramId(telegramId) {
    if (!telegramId) return [];
    const cleanTgId = String(telegramId).trim();
    let rows = [];

    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare("SELECT * FROM participants WHERE telegram_id = ? AND (payment_status = 'pending_payment' OR payment_status = 'unpaid' OR payment_status IS NULL) ORDER BY id ASC");
      rows = stmt.all ? stmt.all(cleanTgId) : [];
    } else {
      const list = this.readJson();
      rows = list.filter((p) => p.telegram_id === cleanTgId && (!p.payment_status || p.payment_status === 'pending_payment' || p.payment_status === 'unpaid'));
    }

    return rows.map(r => this._formatRow(r));
  }

  /**
   * Get all pending verification participants for a Telegram ID
   */
  getPendingVerificationParticipantsByTelegramId(telegramId) {
    if (!telegramId) return [];
    const cleanTgId = String(telegramId).trim();
    let rows = [];

    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare("SELECT * FROM participants WHERE telegram_id = ? AND payment_status = 'pending_verification' ORDER BY id ASC");
      rows = stmt.all ? stmt.all(cleanTgId) : [];
    } else {
      const list = this.readJson();
      rows = list.filter((p) => p.telegram_id === cleanTgId && p.payment_status === 'pending_verification');
    }

    return rows.map(r => this._formatRow(r));
  }

  /**
   * Get all pending participants for a Telegram ID (unpaid or awaiting verification)
   */
  getPendingParticipantsByTelegramId(telegramId) {
    if (!telegramId) return [];
    const cleanTgId = String(telegramId).trim();
    let rows = [];

    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare("SELECT * FROM participants WHERE telegram_id = ? AND payment_status != 'paid' ORDER BY id ASC");
      rows = stmt.all ? stmt.all(cleanTgId) : [];
    } else {
      const list = this.readJson();
      rows = list.filter((p) => p.telegram_id === cleanTgId && p.payment_status !== 'paid');
    }

    return rows.map(r => this._formatRow(r));
  }

  /**
   * Get all paid participants for a Telegram ID
   */
  getPaidParticipantsByTelegramId(telegramId) {
    if (!telegramId) return [];
    const cleanTgId = String(telegramId).trim();
    let rows = [];

    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare("SELECT * FROM participants WHERE telegram_id = ? AND payment_status = 'paid' ORDER BY id ASC");
      rows = stmt.all ? stmt.all(cleanTgId) : [];
    } else {
      const list = this.readJson();
      rows = list.filter((p) => p.telegram_id === cleanTgId && p.payment_status === 'paid');
    }

    return rows.map(r => this._formatRow(r));
  }

  /**
   * Get all participants for a Telegram ID
   */
  getAllParticipantsByTelegramId(telegramId) {
    if (!telegramId) return [];
    const cleanTgId = String(telegramId).trim();
    let rows = [];

    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare("SELECT * FROM participants WHERE telegram_id = ? ORDER BY id ASC");
      rows = stmt.all ? stmt.all(cleanTgId) : [];
    } else {
      const list = this.readJson();
      rows = list.filter((p) => p.telegram_id === cleanTgId);
    }

    return rows.map(r => this._formatRow(r));
  }

  /**
   * Set payment message ID for all unpaid tickets of a Telegram ID
   */
  setPaymentMsgId(telegramId, msgId) {
    if (!telegramId) return;
    const cleanTgId = String(telegramId).trim();

    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      try {
        const stmt = this.db.prepare("UPDATE participants SET payment_msg_id = ? WHERE telegram_id = ? AND (payment_status = 'pending_payment' OR payment_status = 'unpaid' OR payment_status IS NULL)");
        stmt.run(String(msgId), cleanTgId);
      } catch {}
    } else {
      const list = this.readJson();
      list.forEach(p => {
        if (p.telegram_id === cleanTgId && (!p.payment_status || p.payment_status === 'pending_payment' || p.payment_status === 'unpaid')) {
          p.payment_msg_id = String(msgId);
        }
      });
      this.writeJson(list);
    }
  }

  /**
   * Get last payment message ID for a Telegram ID
   */
  getLastPaymentMsgId(telegramId) {
    if (!telegramId) return null;
    const cleanTgId = String(telegramId).trim();
    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      try {
        const stmt = this.db.prepare("SELECT payment_msg_id FROM participants WHERE telegram_id = ? AND payment_msg_id IS NOT NULL ORDER BY id DESC LIMIT 1");
        const row = stmt.get(cleanTgId);
        return row ? row.payment_msg_id : null;
      } catch {
        return null;
      }
    } else {
      const list = this.readJson();
      const item = list.slice().reverse().find(p => p.telegram_id === cleanTgId && p.payment_msg_id);
      return item ? item.payment_msg_id : null;
    }
  }

  /**
   * Update payment status and receipt for a participant ticket
   */
  updateParticipantPaymentStatus(ticketId, { payment_status, receipt_file_id, username }) {
    const cleanId = String(ticketId).trim();
    const withHash = cleanId.startsWith('#') ? cleanId : `#${cleanId}`;
    const withoutHash = cleanId.replace(/^#/, '');

    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare(`
        UPDATE participants 
        SET payment_status = ?, 
            receipt_file_id = COALESCE(?, receipt_file_id),
            username = COALESCE(?, username)
        WHERE unique_ticket_id = ? OR unique_ticket_id = ? OR ticket_id = ? OR ticket_id = ?
      `);
      stmt.run(
        payment_status, 
        receipt_file_id || null, 
        username || null, 
        withHash, withoutHash, withHash, withoutHash
      );
      return this.getParticipantByTicketId(cleanId);
    }

    const list = this.readJson();
    const item = list.slice().reverse().find(p => {
      const pid = String(p.unique_ticket_id || p.ticket_id || '').toUpperCase();
      return pid === withHash.toUpperCase() || pid === withoutHash.toUpperCase();
    });
    if (item) {
      if (payment_status) item.payment_status = payment_status;
      if (receipt_file_id) item.receipt_file_id = receipt_file_id;
      if (username) item.username = username;
      this.writeJson(list);
      return item;
    }
    return null;
  }

  /**
   * Retrieve all participants
   */
  getAllParticipants(limit = 100, offset = 0) {
    if (this.driver === 'node:sqlite') {
      const stmt = this.db.prepare('SELECT * FROM participants ORDER BY id DESC LIMIT ? OFFSET ?');
      return stmt.all(limit, offset);
    }

    if (this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare('SELECT * FROM participants ORDER BY id DESC LIMIT ? OFFSET ?');
      return stmt.all(limit, offset);
    }

    const list = this.readJson();
    return list.slice().reverse().slice(offset, offset + limit);
  }

  /**
   * Get participant by ID
   */
  getParticipantById(id) {
    if (!id) return null;
    const cleanId = Number(id);
    let row = null;
    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare('SELECT * FROM participants WHERE id = ? LIMIT 1');
      row = stmt.get(cleanId) || null;
    } else {
      const list = this.readJson();
      row = list.find(p => p.id === cleanId) || null;
    }
    if (!row) return null;
    return {
      id: row.id,
      telegram_id: row.telegram_id,
      ticket_id: row.unique_ticket_id || row.ticket_id,
      unique_ticket_id: row.unique_ticket_id || row.ticket_id,
      guest_name: row.full_name || row.guest_name,
      full_name: row.full_name || row.guest_name,
      groom_bride: row.couple_names || row.groom_bride,
      couple_names: row.couple_names || row.groom_bride,
      venue_name: row.venue_name,
      venue_address: row.venue_address,
      event_date: row.event_date_time || row.event_date,
      event_date_time: row.event_date_time || row.event_date,
      event_type: row.event_type || 'Nikoh toʻyi',
      phone: row.phone,
      guests_count: row.guests_count,
      comment: row.comment,
      created_at: row.created_at
    };
  }

  /**
   * Update participant details
   */
  updateParticipant(id, { full_name, phone, guests_count, comment, couple_names, venue_name, venue_address, event_date_time, event_type }) {
    const cleanId = Number(id);
    const existing = this.getParticipantById(cleanId);
    if (!existing) return null;

    const cleanFullName = full_name !== undefined ? String(full_name).trim() : existing.full_name;
    const cleanPhone = phone !== undefined ? String(phone).trim() : existing.phone;
    const cleanCount = guests_count !== undefined ? Math.max(1, parseInt(guests_count, 10) || 1) : existing.guests_count;
    const cleanComment = comment !== undefined ? String(comment).trim() : (existing.comment || '');
    const cleanCouple = couple_names !== undefined ? String(couple_names).trim() : (existing.couple_names || '');
    const cleanVenue = venue_name !== undefined ? String(venue_name).trim() : (existing.venue_name || '');
    const cleanAddr = venue_address !== undefined ? String(venue_address).trim() : (existing.venue_address || '');
    const cleanDateTime = event_date_time !== undefined ? String(event_date_time).trim() : (existing.event_date_time || '');
    const cleanEventType = event_type !== undefined ? String(event_type).trim() : (existing.event_type || 'Nikoh toʻyi');

    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare(`
        UPDATE participants 
        SET full_name = ?, phone = ?, guests_count = ?, comment = ?, couple_names = ?, venue_name = ?, venue_address = ?, event_date_time = ?, event_type = ?
        WHERE id = ?
      `);
      stmt.run(cleanFullName, cleanPhone, cleanCount, cleanComment, cleanCouple, cleanVenue, cleanAddr, cleanDateTime, cleanEventType, cleanId);
      return this.getParticipantById(cleanId);
    }

    const list = this.readJson();
    const index = list.findIndex(p => p.id === cleanId);
    if (index !== -1) {
      list[index].full_name = cleanFullName;
      list[index].phone = cleanPhone;
      list[index].guests_count = cleanCount;
      list[index].comment = cleanComment;
      list[index].couple_names = cleanCouple;
      list[index].venue_name = cleanVenue;
      list[index].venue_address = cleanAddr;
      list[index].event_date_time = cleanDateTime;
      list[index].event_type = cleanEventType;
      this.writeJson(list);
      return list[index];
    }
    return null;
  }

  /**
   * Delete participant by ID
   */
  deleteParticipant(id) {
    const cleanId = Number(id);
    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare('DELETE FROM participants WHERE id = ?');
      stmt.run(cleanId);
      return true;
    }
    const list = this.readJson();
    const filtered = list.filter(p => p.id !== cleanId);
    this.writeJson(filtered);
    return true;
  }

  // -------------------------------------------------------------
  // PAYMENT TRANSACTIONS MANAGEMENT
  // -------------------------------------------------------------

  createTransaction({ provider, trans_id, merchant_trans_id, amount, state = 1, status = 'pending', telegram_id = null, ticket_id = null, create_time = 0, raw_payload = null }) {
    const p = String(provider).toLowerCase();
    const tId = String(trans_id);
    const mId = String(merchant_trans_id);
    const amt = parseFloat(amount) || 0;
    const st = parseInt(state, 10) || 1;
    const stat = String(status || 'pending');
    const tgId = telegram_id ? String(telegram_id) : null;
    const tickId = ticket_id ? String(ticket_id) : null;
    const crTime = parseInt(create_time, 10) || Math.floor(Date.now());
    const payload = raw_payload ? (typeof raw_payload === 'string' ? raw_payload : JSON.stringify(raw_payload)) : null;

    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare(`
        INSERT INTO transactions (
          provider, trans_id, merchant_trans_id, amount, state, status, telegram_id, ticket_id, create_time, raw_payload
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(p, tId, mId, amt, st, stat, tgId, tickId, crTime, payload);
      return this.getTransactionByTransId(tId);
    }

    // JSON fallback
    const list = this.readTransactionsJson();
    const newTx = {
      id: list.length + 1,
      provider: p,
      trans_id: tId,
      merchant_trans_id: mId,
      amount: amt,
      state: st,
      status: stat,
      telegram_id: tgId,
      ticket_id: tickId,
      create_time: crTime,
      perform_time: 0,
      cancel_time: 0,
      reason: null,
      raw_payload: payload,
      created_at: new Date().toISOString()
    };
    list.push(newTx);
    this.writeTransactionsJson(list);
    return newTx;
  }

  getTransactionByTransId(trans_id) {
    const tId = String(trans_id);
    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare('SELECT * FROM transactions WHERE trans_id = ?');
      return stmt.get(tId) || null;
    }
    const list = this.readTransactionsJson();
    return list.find(t => String(t.trans_id) === tId) || null;
  }

  getTransactionByMerchantTransId(merchant_trans_id) {
    const mId = String(merchant_trans_id);
    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare('SELECT * FROM transactions WHERE merchant_trans_id = ? ORDER BY id DESC LIMIT 1');
      return stmt.get(mId) || null;
    }
    const list = this.readTransactionsJson();
    const found = list.filter(t => String(t.merchant_trans_id) === mId);
    return found.length > 0 ? found[found.length - 1] : null;
  }

  updateTransaction(trans_id, updates = {}) {
    const tId = String(trans_id);
    const existing = this.getTransactionByTransId(tId);
    if (!existing) return null;

    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const fields = [];
      const values = [];
      for (const [k, v] of Object.entries(updates)) {
        fields.push(`${k} = ?`);
        values.push(v);
      }
      values.push(tId);
      const sql = `UPDATE transactions SET ${fields.join(', ')} WHERE trans_id = ?`;
      this.db.prepare(sql).run(...values);
      return this.getTransactionByTransId(tId);
    }

    const list = this.readTransactionsJson();
    const idx = list.findIndex(t => String(t.trans_id) === tId);
    if (idx !== -1) {
      list[idx] = { ...list[idx], ...updates };
      this.writeTransactionsJson(list);
      return list[idx];
    }
    return null;
  }

  getAllTransactions(limit = 100) {
    if (this.driver === 'node:sqlite' || this.driver === 'better-sqlite3') {
      const stmt = this.db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT ?');
      return stmt.all(limit);
    }
    const list = this.readTransactionsJson();
    return list.slice(-limit).reverse();
  }

  readTransactionsJson() {
    const TX_FILE = path.join(DB_DIR, 'transactions.json');
    try {
      if (fs.existsSync(TX_FILE)) {
        return JSON.parse(fs.readFileSync(TX_FILE, 'utf-8'));
      }
    } catch {}
    return [];
  }

  writeTransactionsJson(data) {
    const TX_FILE = path.join(DB_DIR, 'transactions.json');
    try {
      fs.writeFileSync(TX_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Database] Failed to write transactions JSON:', err);
    }
  }

  /**
   * Get overall guest and registration statistics
   */
  getStats() {
    if (this.driver === 'node:sqlite') {
      const countStmt = this.db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(guests_count), 0) as total_guests FROM participants');
      const stats = countStmt.get();
      return {
        total_registrations: stats.count || 0,
        total_guests: stats.total_guests || 0
      };
    }

    if (this.driver === 'better-sqlite3') {
      const countStmt = this.db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(guests_count), 0) as total_guests FROM participants');
      const stats = countStmt.get();
      return {
        total_registrations: stats.count || 0,
        total_guests: stats.total_guests || 0
      };
    }

    const list = this.readJson();
    const total_registrations = list.length;
    const total_guests = list.reduce((sum, item) => sum + (parseInt(item.guests_count, 10) || 1), 0);
    return { total_registrations, total_guests };
  }

  readJson() {
    try {
      const data = fs.readFileSync(BACKUP_JSON, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  writeJson(data) {
    try {
      fs.writeFileSync(BACKUP_JSON, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Database] Failed to write JSON backup:', err);
    }
  }
}

module.exports = new DatabaseManager();
