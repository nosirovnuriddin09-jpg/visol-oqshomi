/**
 * Payme Payment Provider Service
 * Implements Payme Merchant API (JSON-RPC 2.0 protocol)
 * Docs: https://developer.help.paycom.uz/
 */

const db = require('../database');

class PaymeService {
  constructor() {
    this.merchantId = process.env.PAYME_MERCHANT_ID || '';
    this.secretKey = process.env.PAYME_SECRET_KEY || '';
  }

  /**
   * Verify HTTP Basic Auth from Payme
   * Header: "Authorization: Basic Base64('Paycom:' + PAYME_SECRET_KEY)"
   */
  authenticate(req) {
    if (!this.secretKey) return true; // Dev mode fallback
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Basic ')) return false;

    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const [login, key] = credentials.split(':');

    return key === this.secretKey;
  }

  /**
   * Generate Payme Checkout URL
   * Base64 of "m=MERCHANT_ID;ac.ticket_id=TICKET_ID;a=AMOUNT_IN_TIYIN"
   */
  generatePaymentUrl({ ticketId, amount }) {
    const amtTiyin = Math.round((parseFloat(amount) || 0) * 100);
    const mId = this.merchantId;
    const cleanTicket = String(ticketId).replace('#', '');
    const paramStr = `m=${mId};ac.ticket_id=${cleanTicket};a=${amtTiyin}`;
    const base64 = Buffer.from(paramStr).toString('base64');
    return `https://checkout.paycom.uz/${base64}`;
  }

  /**
   * Standard JSON-RPC Error Formatter
   */
  formatError(id, code, uzMsg, ruMsg, data = null) {
    return {
      jsonrpc: '2.0',
      id: id || null,
      error: {
        code,
        message: {
          uz: uzMsg,
          ru: ruMsg || uzMsg,
          en: uzMsg
        },
        data
      }
    };
  }

  /**
   * Handle incoming Payme JSON-RPC 2.0 Webhook
   */
  async handleWebhook(req, res, notifyCallback) {
    // 1. Verify Basic Auth
    if (!this.authenticate(req)) {
      console.warn('[Payme Webhook] Authentication failed');
      return res.json(this.formatError(req.body?.id, -32504, 'Avtorizatsiya xatosi', 'Ошибка авторизации'));
    }

    const { id, method, params } = req.body || {};
    console.log(`[Payme Webhook] Method: ${method}, id: ${id}`);

    try {
      switch (method) {
        case 'CheckPerformTransaction':
          return res.json(await this.checkPerformTransaction(id, params));

        case 'CreateTransaction':
          return res.json(await this.createTransaction(id, params));

        case 'PerformTransaction':
          return res.json(await this.performTransaction(id, params, notifyCallback));

        case 'CancelTransaction':
          return res.json(await this.cancelTransaction(id, params));

        case 'CheckTransaction':
          return res.json(await this.checkTransaction(id, params));

        case 'GetStatement':
          return res.json(await this.getStatement(id, params));

        default:
          return res.json(this.formatError(id, -32601, 'Metod topilmadi', 'Метод не найден'));
      }
    } catch (err) {
      console.error('[Payme Handler Error]:', err);
      return res.json(this.formatError(id, -31008, 'Ichki xatolik yuz berdi', 'Внутренняя ошибка'));
    }
  }

  /**
   * 1. CheckPerformTransaction: Validate ticket and amount
   */
  async checkPerformTransaction(id, params) {
    const ticketId = params?.account?.ticket_id;
    const amount = params?.amount; // in tiyin

    if (!ticketId) {
      return this.formatError(id, -31050, 'Chipta kiritilmagan', 'Чек или билет не указан', 'ticket_id');
    }

    const participant = db.getParticipantByTicketId(ticketId);
    if (!participant) {
      return this.formatError(id, -31050, 'Chipta topilmadi', 'Билет не найден', 'ticket_id');
    }

    if (!amount || amount <= 0) {
      return this.formatError(id, -31001, 'Noto‘g‘ri summa', 'Неверная сумма');
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        allow: true
      }
    };
  }

  /**
   * 2. CreateTransaction: Create or retrieve existing transaction
   */
  async createTransaction(id, params) {
    const paymeTransId = params?.id;
    const time = params?.time;
    const amount = params?.amount;
    const ticketId = params?.account?.ticket_id;

    // Check if transaction with this Payme ID already exists
    let transaction = db.getTransactionByTransId(paymeTransId);

    if (transaction) {
      // Check if state is created
      if (transaction.state === 1) {
        // Check timeout (12 hours = 43,200,000 ms)
        if (Date.now() - transaction.create_time > 43200000) {
          db.updateTransaction(paymeTransId, { state: -1, status: 'canceled', reason: 4 });
          return this.formatError(id, -31008, 'Tranzaksiya muddati o‘tgan', 'Время транзакции истекло');
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            create_time: transaction.create_time,
            transaction: transaction.trans_id,
            state: transaction.state
          }
        };
      } else {
        return this.formatError(id, -31008, 'Tranzaksiya bajarib bo‘lingan yoki bekor qilingan', 'Транзакция уже завершена или отменена');
      }
    }

    // Verify account before creating
    const participant = db.getParticipantByTicketId(ticketId);
    if (!participant) {
      return this.formatError(id, -31050, 'Chipta topilmadi', 'Билет не найден', 'ticket_id');
    }

    // Create new transaction in DB
    const amountUzs = amount / 100;
    transaction = db.createTransaction({
      provider: 'payme',
      trans_id: paymeTransId,
      merchant_trans_id: String(ticketId),
      amount: amountUzs,
      state: 1,
      status: 'pending',
      telegram_id: participant.telegram_id,
      ticket_id: participant.unique_ticket_id,
      create_time: time || Date.now(),
      raw_payload: params
    });

    return {
      jsonrpc: '2.0',
      id,
      result: {
        create_time: transaction.create_time,
        transaction: transaction.trans_id,
        state: 1
      }
    };
  }

  /**
   * 3. PerformTransaction: Finalize payment and trigger Telegram notification
   */
  async performTransaction(id, params, notifyCallback) {
    const paymeTransId = params?.id;
    const transaction = db.getTransactionByTransId(paymeTransId);

    if (!transaction) {
      return this.formatError(id, -31003, 'Tranzaksiya topilmadi', 'Транзакция не найдена');
    }

    if (transaction.state === 1) {
      const performTime = Date.now();
      db.updateTransaction(paymeTransId, {
        state: 2,
        status: 'paid',
        perform_time: performTime
      });

      console.log(`[Payme Perform] Payment successful for ticket ${transaction.ticket_id}! Amount: ${transaction.amount} UZS`);

      // Trigger Telegram notification
      if (typeof notifyCallback === 'function') {
        try {
          const participant = db.getParticipantByTicketId(transaction.ticket_id);
          notifyCallback({
            provider: 'Payme',
            transId: transaction.trans_id,
            ticketId: transaction.ticket_id,
            amount: transaction.amount,
            telegramId: transaction.telegram_id || participant?.telegram_id,
            guestName: participant?.full_name || participant?.guest_name || 'Mehmon'
          });
        } catch (e) {
          console.warn('[Payme Notification Warning]:', e.message);
        }
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          transaction: transaction.trans_id,
          perform_time: performTime,
          state: 2
        }
      };
    }

    if (transaction.state === 2) {
      // Idempotent success response
      return {
        jsonrpc: '2.0',
        id,
        result: {
          transaction: transaction.trans_id,
          perform_time: transaction.perform_time,
          state: 2
        }
      };
    }

    return this.formatError(id, -31008, 'Tranzaksiyani bajarib bo‘lmaydi', 'Невозможно выполнить операцию');
  }

  /**
   * 4. CancelTransaction: Handle refund or cancellation
   */
  async cancelTransaction(id, params) {
    const paymeTransId = params?.id;
    const reason = params?.reason;
    const transaction = db.getTransactionByTransId(paymeTransId);

    if (!transaction) {
      return this.formatError(id, -31003, 'Tranzaksiya topilmadi', 'Транзакция не найдена');
    }

    const cancelTime = Date.now();

    if (transaction.state === 1) {
      db.updateTransaction(paymeTransId, {
        state: -1,
        status: 'canceled',
        cancel_time: cancelTime,
        reason
      });
      return {
        jsonrpc: '2.0',
        id,
        result: {
          transaction: transaction.trans_id,
          cancel_time: cancelTime,
          state: -1
        }
      };
    }

    if (transaction.state === 2) {
      db.updateTransaction(paymeTransId, {
        state: -2,
        status: 'refunded',
        cancel_time: cancelTime,
        reason
      });
      return {
        jsonrpc: '2.0',
        id,
        result: {
          transaction: transaction.trans_id,
          cancel_time: cancelTime,
          state: -2
        }
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        transaction: transaction.trans_id,
        cancel_time: transaction.cancel_time || cancelTime,
        state: transaction.state
      }
    };
  }

  /**
   * 5. CheckTransaction: Status check
   */
  async checkTransaction(id, params) {
    const paymeTransId = params?.id;
    const transaction = db.getTransactionByTransId(paymeTransId);

    if (!transaction) {
      return this.formatError(id, -31003, 'Tranzaksiya topilmadi', 'Транзакция не найдена');
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        create_time: transaction.create_time,
        perform_time: transaction.perform_time,
        cancel_time: transaction.cancel_time,
        transaction: transaction.trans_id,
        state: transaction.state,
        reason: transaction.reason
      }
    };
  }

  /**
   * 6. GetStatement: Report of transactions in range
   */
  async getStatement(id, params) {
    const from = params?.from;
    const to = params?.to;
    const all = db.getAllTransactions(100);
    const filtered = all
      .filter(t => t.provider === 'payme' && t.create_time >= from && t.create_time <= to)
      .map(t => ({
        id: t.trans_id,
        time: t.create_time,
        amount: Math.round(t.amount * 100),
        account: { ticket_id: t.ticket_id },
        create_time: t.create_time,
        perform_time: t.perform_time,
        cancel_time: t.cancel_time,
        transaction: t.trans_id,
        state: t.state,
        reason: t.reason
      }));

    return {
      jsonrpc: '2.0',
      id,
      result: {
        transactions: filtered
      }
    };
  }
}

module.exports = new PaymeService();
