/**
 * Click Payment Provider Service
 * Implements Click Merchant API (Prepare & Complete actions)
 * Docs: https://docs.click.uz/
 */

const crypto = require('crypto');
const db = require('../database');

class ClickService {
  constructor() {
    this.serviceId = process.env.CLICK_SERVICE_ID || '';
    this.merchantId = process.env.CLICK_MERCHANT_ID || '';
    this.secretKey = process.env.CLICK_SECRET_KEY || '';
  }

  /**
   * Compute MD5 signature for Click requests
   */
  generateMd5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
  }

  /**
   * Verify signature for Prepare action (action = 0)
   */
  verifyPrepareSign({ click_trans_id, service_id, merchant_trans_id, amount, action, sign_time, sign_string }) {
    if (!this.secretKey) return true; // If no secret key configured in dev, skip check
    const text = `${click_trans_id}${service_id}${this.secretKey}${merchant_trans_id}${amount}${action}${sign_time}`;
    const hash = this.generateMd5(text);
    return hash.toLowerCase() === String(sign_string).toLowerCase();
  }

  /**
   * Verify signature for Complete action (action = 1)
   */
  verifyCompleteSign({ click_trans_id, service_id, merchant_trans_id, merchant_prepare_id, amount, action, sign_time, sign_string }) {
    if (!this.secretKey) return true;
    const text = `${click_trans_id}${service_id}${this.secretKey}${merchant_trans_id}${merchant_prepare_id}${amount}${action}${sign_time}`;
    const hash = this.generateMd5(text);
    return hash.toLowerCase() === String(sign_string).toLowerCase();
  }

  /**
   * Generate Click Payment URL for user to pay
   */
  generatePaymentUrl({ ticketId, amount, returnUrl }) {
    const sId = this.serviceId;
    const mId = this.merchantId;
    const amt = parseFloat(amount) || 0;
    const ret = returnUrl || '';
    return `https://my.click.uz/services/pay?service_id=${sId}&merchant_id=${mId}&amount=${amt}&transaction_param=${encodeURIComponent(ticketId)}&return_url=${encodeURIComponent(ret)}`;
  }

  /**
   * Handle incoming Click Webhook
   */
  async handleWebhook(req, res, notifyCallback) {
    const body = req.body || {};
    const {
      click_trans_id,
      service_id,
      click_paydoc_id,
      merchant_trans_id,
      merchant_prepare_id,
      amount,
      action,
      error,
      error_note,
      sign_time,
      sign_string
    } = body;

    const actionNum = parseInt(action, 10);
    const amountNum = parseFloat(amount);

    console.log(`[Click Webhook] Received action: ${actionNum}, click_trans_id: ${click_trans_id}, merchant_trans_id: ${merchant_trans_id}`);

    // Action 0: PREPARE
    if (actionNum === 0) {
      // 1. Verify sign
      if (!this.verifyPrepareSign({ click_trans_id, service_id, merchant_trans_id, amount, action, sign_time, sign_string })) {
        console.warn('[Click Prepare] Sign verification failed!');
        return res.json({
          click_trans_id,
          merchant_trans_id,
          merchant_prepare_id: null,
          error: -1,
          error_note: 'SIGN CHECK FAILED!'
        });
      }

      // 2. Validate participant/ticket
      const participant = db.getParticipantByTicketId(merchant_trans_id);
      if (!participant) {
        console.warn(`[Click Prepare] Ticket not found: ${merchant_trans_id}`);
        return res.json({
          click_trans_id,
          merchant_trans_id,
          merchant_prepare_id: null,
          error: -5,
          error_note: 'Foydalanuvchi yoki chipta topilmadi'
        });
      }

      // 3. Check amount
      if (isNaN(amountNum) || amountNum <= 0) {
        return res.json({
          click_trans_id,
          merchant_trans_id,
          merchant_prepare_id: null,
          error: -2,
          error_note: 'Noto‘g‘ri summa'
        });
      }

      // 4. Check if transaction already exists
      let transaction = db.getTransactionByTransId(String(click_trans_id));
      if (!transaction) {
        transaction = db.createTransaction({
          provider: 'click',
          trans_id: String(click_trans_id),
          merchant_trans_id: String(merchant_trans_id),
          amount: amountNum,
          state: 1,
          status: 'pending',
          telegram_id: participant.telegram_id,
          ticket_id: participant.unique_ticket_id,
          create_time: Date.now(),
          raw_payload: body
        });
      }

      // Success response for Prepare
      return res.json({
        click_trans_id,
        merchant_trans_id,
        merchant_prepare_id: transaction.id,
        error: 0,
        error_note: 'Success'
      });
    }

    // Action 1: COMPLETE
    if (actionNum === 1) {
      // 1. Verify sign
      if (!this.verifyCompleteSign({ click_trans_id, service_id, merchant_trans_id, merchant_prepare_id, amount, action, sign_time, sign_string })) {
        console.warn('[Click Complete] Sign verification failed!');
        return res.json({
          click_trans_id,
          merchant_trans_id,
          merchant_confirm_id: null,
          error: -1,
          error_note: 'SIGN CHECK FAILED!'
        });
      }

      const transaction = db.getTransactionByTransId(String(click_trans_id));
      if (!transaction) {
        return res.json({
          click_trans_id,
          merchant_trans_id,
          merchant_confirm_id: null,
          error: -6,
          error_note: 'Tranzaksiya topilmadi'
        });
      }

      // Check if Click reported an error
      if (parseInt(error, 10) < 0) {
        db.updateTransaction(String(click_trans_id), {
          status: 'canceled',
          state: -1,
          cancel_time: Date.now(),
          reason: error
        });
        return res.json({
          click_trans_id,
          merchant_trans_id,
          merchant_confirm_id: transaction.id,
          error: -9,
          error_note: 'Tranzaksiya bekor qilindi'
        });
      }

      // Check if already paid
      if (transaction.status === 'paid' || transaction.state === 2) {
        return res.json({
          click_trans_id,
          merchant_trans_id,
          merchant_confirm_id: transaction.id,
          error: 0,
          error_note: 'Already paid'
        });
      }

      // Mark transaction as paid
      const updatedTx = db.updateTransaction(String(click_trans_id), {
        status: 'paid',
        state: 2,
        perform_time: Date.now()
      });

      console.log(`[Click Complete] Payment successful for ticket ${merchant_trans_id}! Amount: ${amountNum} UZS`);

      // Trigger Telegram notification
      if (typeof notifyCallback === 'function') {
        try {
          const participant = db.getParticipantByTicketId(merchant_trans_id);
          notifyCallback({
            provider: 'Click',
            transId: String(click_trans_id),
            ticketId: merchant_trans_id,
            amount: amountNum,
            telegramId: transaction.telegram_id || participant?.telegram_id,
            guestName: participant?.full_name || participant?.guest_name || 'Mehmon'
          });
        } catch (e) {
          console.warn('[Click Notification Warning]:', e.message);
        }
      }

      return res.json({
        click_trans_id,
        merchant_trans_id,
        merchant_confirm_id: transaction.id,
        error: 0,
        error_note: 'Success'
      });
    }

    // Unknown action
    return res.json({
      click_trans_id,
      merchant_trans_id,
      error: -3,
      error_note: 'Action not found'
    });
  }
}

module.exports = new ClickService();
