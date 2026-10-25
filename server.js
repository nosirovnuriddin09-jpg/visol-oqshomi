/**
 * Visol Oqshomi - Production-ready Backend & Telegram Mini App Server
 * Express.js + Telegraf Bot + SQLite
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Telegraf, Markup } = require('telegraf');
const QRCode = require('qrcode');
const db = require('./database');
const clickService = require('./payments/click.service');
const paymeService = require('./payments/payme.service');

// Configuration
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL || 'https://visol-oqshomi.onrender.com';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || null;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6JN6cT8qet4kdBzHnB9hX4tRgnhy3xwRfFAA6pyUa2Oww';

// Helper: Ask Gemini AI for wedding questions and wishes
async function askGeminiAI(userMessage) {
  if (!GEMINI_API_KEY) return null;
  const s = getSettings();
  const systemPrompt = `Siz "${s.groom_name} va ${s.bride_name} — ${s.event_type}" tantanali to'yining aqlli va muloyim AI yordamchisisiz.
To'y tafsilotlari:
- Kuyov va Kelin: ${s.groom_name} va ${s.bride_name}
- Tadbir: ${s.event_type}
- Sana: ${s.day_number}-${s.month_name}, ${s.year} (${s.day_of_week})
- Boshlanish vaqti: ${s.event_time}
- To'yxona: ${s.venue_name}
- Manzil: ${s.venue_address}
- Taklif etuvchilar: ${s.family_names}
- Dress-kod: Black Tie / Kechki Libos

Foydalanuvchi sizga murojaat qilmoqda. Unga o'zbek tilida juda samimiy, madaniyatli, to'y kayfiyatida va qisqa-londa javob bering. Agar manzil, sana yoki dastur haqida so'rasa, yuqoridagi ma'lumotlarga asoslanib javob bering. Agar taklifnoma olishni so'rasa, pastdagi "🎟️ Ro'yxatdan O'tish" tugmasini bosishni taklif qiling. Agar tabrik yozsa, minnatdorchilik bildiring.`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: userMessage }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
      })
    });
    const data = await res.json();
    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text.trim();
    }
  } catch (err) {
    console.warn('[Gemini AI] Notice:', err.message);
  }
  return null;
}

// Settings File Management
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('[Settings] Error reading settings.json:', err.message);
  }
  return {
    groom_name: "Kuyov",
    bride_name: "Kelin",
    event_type: "Nikoh toʻyi",
    event_date: "2026-11-15",
    event_time: "18:00",
    day_of_week: "Yakshanba",
    day_number: "15",
    month_name: "Noyabr",
    year: "2026",
    venue_name: "Tantanalar Saroyi",
    venue_address: "Toshkent shahri",
    map_url: "https://maps.google.com",
    family_names: "To'y egalari va xonadon ahillari",
    music_loop_start: 0,
    music_loop_end: 166
  };
}

function saveSettings(data) {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Initialize Express App
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static Mini App frontend
app.use(express.static(path.join(__dirname, 'public')));

// Helper: Generate unique ticket ID format: #VO-XXXX-XXXX
function generateUniqueTicketId() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let hash = '';
  for (let i = 0; i < 4; i++) {
    hash += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const randNum = Math.floor(1000 + Math.random() * 9000);
  return `#VO-${hash}-${randNum}`;
}

// -------------------------------------------------------------
// TELEGRAF TELEGRAM BOT SETUP
// -------------------------------------------------------------
let bot = null;
let isBotActive = false;

// Helper: Reliably set Telegram Chat Menu Button via raw callApi with proper JSON serialization
async function updateChatMenuButton(chatId, text, url) {
  if (!bot || !isBotActive || !WEBAPP_URL || !WEBAPP_URL.startsWith('https://')) return;
  try {
    const payload = {
      menu_button: JSON.stringify({
        type: 'web_app',
        text: text || "Taklif noma",
        web_app: { url: url || WEBAPP_URL }
      })
    };
    if (chatId) {
      payload.chat_id = chatId;
    }
    await bot.telegram.callApi('setChatMenuButton', payload);
  } catch (err) {
    console.warn('[Telegram Bot] Menu button update warning:', err.message);
  }
}

function setupBotCommands(botInstance) {
  // Bot /start command
  botInstance.start(async (ctx) => {
    const user = ctx.from;
    const firstName = user?.first_name || 'Hurmatli mehmon';
    const s = getSettings();

    // Check if user already registered
    const existing = db.getParticipantByTelegramId(user?.id);

    const eventType = existing?.event_type || s.event_type || "Nikoh toʻyi";
    const coupleText = existing?.couple_names || `${s.groom_name} va ${s.bride_name}`;
    const eventTitle = `${coupleText} — ${eventType}`;
    const eventDate = existing?.event_date_time || `${s.day_number}-${s.month_name}, ${s.year} • ${s.event_time}`;
    const eventVenue = (existing?.venue_name || existing?.venue_address)
      ? [existing.venue_name, existing.venue_address].filter(Boolean).join(', ')
      : `${s.venue_name}, ${s.venue_address}`;

    let welcomeText = `✨ <b>Assalomu alaykum va xush kelibsiz, ${firstName}!</b> ✨\n\n`;
    welcomeText += `Sizni muhtaram <b>"${eventTitle}"</b> tantanali marosimiga lutfan taklif etamiz.\n\n`;
    welcomeText += `📅 <b>Sana:</b> ${eventDate} (${s.day_of_week})\n`;
    welcomeText += `📍 <b>Manzil:</b> ${eventVenue}\n`;
    welcomeText += `👨‍👩‍👧‍👦 <b>Taklif etuvchilar:</b> ${s.family_names}\n\n`;

    const regUrl = `${WEBAPP_URL}/index.html`;
    const inviteUrl = existing ? `${WEBAPP_URL}/invite.html?ticket=${encodeURIComponent(existing.unique_ticket_id.replace('#', ''))}` : null;

    if (existing) {
      welcomeText += `🎫 <b>Sizning VIP Chiptangiz:</b> <code>${existing.unique_ticket_id}</code> (${existing.guests_count} kishi)\n`;
      welcomeText += `🔗 <b>Shaxsiy Taklifnoma Silkasi:</b>\n<code>${inviteUrl}</code>\n\n`;
      welcomeText += `<i>(Silkani nusxalash uchun ustiga bosing)</i>\n\n`;
      welcomeText += `Ro'yxatdan o'tish yoki ma'lumotlarni o'zgartirish uchun quyidagi tugmani bosing:`;
    } else {
      welcomeText += `Ushbu quvonchli kunimizda biz bilan birga bo'lishingiz uchun quyidagi tugma orqali ro'yxatdan o'ting va shaxsiy raqamli taklifnomangizni qabul qilib oling:`;
    }

    // Inline keyboard: "Ro'yxatdan O'tish" opens the Mini App registration form (index.html)
    const buttons = [
      [
        Markup.button.webApp("🎟️ Ro'yxatdan O'tish", regUrl)
      ]
    ];

    if (existing && inviteUrl) {
      buttons.push([
        Markup.button.webApp("💌 Taklifnomani Ochish", inviteUrl),
        Markup.button.url("🌐 Brauzerda", inviteUrl)
      ]);
      buttons.push([
        Markup.button.url("✈️ Mehmonga Ulashish", `https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent(`Assalomu alaykum! Sizni to'yimizga taklif etamiz. Shaxsiy taklifnomangiz:`)}`)
      ]);
    }

    buttons.push([
      Markup.button.callback("📜 Dastur va Tafsilotlar", "view_details"),
      Markup.button.callback("📍 Manzil va Xarita", "view_location")
    ]);

    const keyboard = Markup.inlineKeyboard(buttons);

    // Auto update user's Chat Menu Button to latest active WebApp URL
    if (user?.id) {
      updateChatMenuButton(user.id, "Taklif noma", regUrl);
    }

    await ctx.replyWithHTML(welcomeText, keyboard);
  });

  // Command: /admin - Open admin settings panel
  botInstance.command(['admin', 'settings'], async (ctx) => {
    const adminUrl = `${WEBAPP_URL}/admin.html`;
    await ctx.replyWithHTML(
      `⚙️ <b>To'y Ma'lumotlarini Boshqarish Paneli:</b>\n\n` +
      `Kelin-kuyov ismlari, to'y sanasi, to'yxona va boshqa barcha ma'lumotlarni kiritish va o'zgartirish uchun quyidagi tugmani bosing:\n\n` +
      `🔗 <a href="${adminUrl}">${adminUrl}</a>`,
      Markup.inlineKeyboard([
        [Markup.button.webApp("⚙️ Ma'lumotlarni Kiritish / Sozlash", adminUrl)],
        [Markup.button.url("🌐 Brauzerda Ochish", adminUrl)]
      ])
    );
  });

  // Command: /myticket - Retrieve user's digital ticket
  botInstance.command('myticket', async (ctx) => {
    const telegramId = ctx.from?.id;
    const ticket = db.getParticipantByTelegramId(telegramId);

    if (!ticket) {
      return ctx.replyWithHTML(
        `Siz hali ro'yxatdan o'tmagansiz.\nTaklifnoma olish uchun quyidagi tugmani bosing:`,
        Markup.inlineKeyboard([
          [Markup.button.webApp("🎟️ Ro'yxatdan o'tish", WEBAPP_URL)]
        ])
      );
    }

    await sendTicketToUser(ctx.chat.id, ticket);
  });

  // Command: /help
  botInstance.command('help', async (ctx) => {
    const helpText = `ℹ️ <b>Taklifnoma Bot Yordamchisi</b>\n\n` +
      `• /start - Botni ishga tushirish va taklifnoma olish\n` +
      `• /myticket - O'zingizning shaxsiy chiptangizni olish\n` +
      `• /admin - To'y ma'lumotlarini o'zgartirish paneli\n` +
      `• /help - Ushbu yordam xabari\n\n` +
      `Savollar bo'yicha tadbir tashkilotchilariga murojaat qilishingiz mumkin.`;
    await ctx.replyWithHTML(helpText);
  });

  // Action handler: Dastur va Tafsilotlar
  botInstance.action('view_details', async (ctx) => {
    await ctx.answerCbQuery();
    const s = getSettings();
    const detailsText = `📜 <b>Tadbir Tafsilotlari:</b>\n\n` +
      `💍 <b>Kelin va Kuyov:</b> ${s.groom_name} va ${s.bride_name}\n` +
      `🎉 <b>Tadbir:</b> ${s.event_type}\n` +
      `📅 <b>Sana:</b> ${s.day_number}-${s.month_name}, ${s.year} (${s.day_of_week})\n` +
      `⏰ <b>Boshlanish vaqti:</b> ${s.event_time}\n` +
      `🏛️ <b>To'yxona:</b> ${s.venue_name}\n` +
      `📍 <b>Manzil:</b> ${s.venue_address}\n` +
      `👨‍👩‍👧‍👦 <b>Taklif etuvchilar:</b> ${s.family_names}\n\n` +
      `Quyidagi tugma orqali taklifnoma olishingiz mumkin:`;

    await ctx.replyWithHTML(
      detailsText,
      Markup.inlineKeyboard([[Markup.button.webApp("🎟️ Ro'yxatdan o'tish", WEBAPP_URL)]])
    );
  });

  // Action handler: Manzil va Xarita
  botInstance.action('view_location', async (ctx) => {
    await ctx.answerCbQuery();
    const s = getSettings();
    const locText = `📍 <b>Tadbir Manzili:</b>\n\n` +
      `🏛️ <b>${s.venue_name}</b>\n` +
      `📌 ${s.venue_address}\n\n` +
      `👨‍👩‍👧‍👦 <b>Taklif etuvchilar:</b> ${s.family_names}`;

    const buttons = [];
    if (s.map_url) {
      buttons.push([Markup.button.url("🗺️ Xaritada ko'rish (Navigatsiya)", s.map_url)]);
    }
    buttons.push([Markup.button.webApp("🎟️ Ro'yxatdan o'tish", WEBAPP_URL)]);

    await ctx.replyWithHTML(locText, Markup.inlineKeyboard(buttons));
  });

  // Intelligent Gemini AI Conversation Handler
  botInstance.on('text', async (ctx) => {
    const text = ctx.message?.text;
    if (!text || text.startsWith('/')) return; // ignore slash commands

    try {
      await ctx.sendChatAction('typing');
      const aiReply = await askGeminiAI(text);
      if (aiReply) {
        await ctx.reply(aiReply, {
          reply_to_message_id: ctx.message.message_id
        });
      }
    } catch (e) {
      console.warn('[Bot Text Handler]:', e.message);
    }
  });
}

// -------------------------------------------------------------
// HELPER: SEND CONFIRMATION AND TICKET TO TELEGRAM USER
// -------------------------------------------------------------
async function sendTicketToUser(telegramId, ticket) {
  if (!bot || !isBotActive || !telegramId) return false;

  try {
    const s = getSettings();
    const eventType = ticket.event_type || s.event_type || "Nikoh toʻyi";
    const coupleText = ticket.couple_names || `${s.groom_name} va ${s.bride_name}`;
    const eventTitle = `${coupleText} — ${eventType}`;
    const eventDate = ticket.event_date_time || `${s.day_number}-${s.month_name}, ${s.year} • ${s.event_time}`;
    const eventVenue = (ticket.venue_name || ticket.venue_address)
      ? [ticket.venue_name, ticket.venue_address].filter(Boolean).join(', ')
      : `${s.venue_name}, ${s.venue_address}`;

    const cleanTicketId = ticket.unique_ticket_id.replace('#', '');
    const inviteUrl = `${WEBAPP_URL}/invite.html?ticket=${encodeURIComponent(cleanTicketId)}`;

    // Generate QR Code Buffer
    const verificationUrl = `${WEBAPP_URL}/api/ticket/${encodeURIComponent(cleanTicketId)}`;
    const qrBuffer = await QRCode.toBuffer(verificationUrl, {
      errorCorrectionLevel: 'H',
      type: 'png',
      margin: 2,
      scale: 8,
      color: {
        dark: '#0b0f19',
        light: '#ffffff'
      }
    });

    // Formatted VIP Invitation Message
    let caption = `✨ <b>RASMIY ELEKTRON TAKLIFNOMA</b> ✨\n\n`;
    caption += `Hurmatli <b>${ticket.full_name}</b>!\n\n`;
    caption += `Sizning <b>"${eventTitle}"</b> tantanali marosimiga tashrifingiz rasman tasdiqlandi.\n\n`;
    caption += `🎫 <b>Chipta ID:</b> <code>${ticket.unique_ticket_id}</code>\n`;
    caption += `👥 <b>Mehmonlar soni:</b> ${ticket.guests_count} kishi\n`;
    caption += `📅 <b>Sana & Vaqt:</b> ${eventDate} (${s.day_of_week})\n`;
    caption += `📍 <b>Manzil:</b> ${eventVenue}\n`;
    caption += `👨‍👩‍👧‍👦 <b>Taklif etuvchilar:</b> ${s.family_names}\n\n`;
    if (ticket.comment) {
      caption += `💬 <b>Tilakingiz:</b> <i>"${ticket.comment}"</i>\n\n`;
    }
    caption += `🔗 <b>Shaxsiy Taklifnoma Silkasi:</b>\n<code>${inviteUrl}</code>\n\n`;
    caption += `<i>(Silkani nusxalash uchun ustiga bosing)</i>\n\n`;
    caption += `Sizni orziqib kutib qolamiz! ✨`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.webApp("💌 Taklifnomani Ochish", inviteUrl),
        Markup.button.url("🌐 Brauzerda Ko'rish", inviteUrl)
      ],
      [
        Markup.button.url("✈️ Mehmonga Ulashish", `https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent(`Assalomu alaykum! Sizni to'yimizga taklif etamiz. Shaxsiy taklifnomangiz:`)}`)
      ]
    ]);

    // Send Photo with Caption and Action Buttons
    await bot.telegram.sendPhoto(telegramId, { source: qrBuffer }, {
      caption: caption,
      parse_mode: 'HTML',
      ...keyboard
    });

    // Update user chat menu button to their personalized ticket
    if (telegramId) {
      updateChatMenuButton(telegramId, "💌 Taklifnoma", inviteUrl);
    }

    console.log(`[Notification] Successfully sent VIP invitation to Telegram ID: ${telegramId}`);
    return true;
  } catch (err) {
    console.warn(`[Notification] Could not send message to Telegram ID ${telegramId}:`, err.message);
    return false;
  }
}

// -------------------------------------------------------------
// API ENDPOINTS
// -------------------------------------------------------------

/**
 * POST /api/register
 * Handles guest registration from the Telegram Mini App
 */
app.post('/api/register', async (req, res) => {
  try {
    const { 
      full_name, guest_name, phone, guests_count, comment, telegram_id,
      couple_names, groom_bride, venue_name, venue_address, event_date_time, event_date,
      event_type
    } = req.body;

    const guestFullName = String(full_name || guest_name || '').trim();
    if (!guestFullName || guestFullName.length < 2) {
      return res.status(400).json({ success: false, error: "Ism va familiyangizni to'liq kiriting." });
    }
    if (!phone || String(phone).trim().length < 7) {
      return res.status(400).json({ success: false, error: "Telefon raqamingizni to'liq kiriting." });
    }

    const cleanGuestsCount = Math.max(1, parseInt(guests_count, 10) || 1);
    const cleanTgId = telegram_id ? String(telegram_id).trim() : null;
    const cleanCouple = (couple_names || groom_bride || '').trim() || null;
    const cleanVenueName = (venue_name || '').trim() || null;
    const cleanVenueAddress = (venue_address || '').trim() || null;
    const cleanEventDateTime = (event_date_time || event_date || '').trim() || null;
    const cleanEventType = (event_type || '').trim() || "Nikoh toʻyi";

    // Requirement 1: Unique Entry Creation
    // Ensure that every time a user submits the form with new details,
    // a brand new record is saved in SQLite database with a unique ticket ID.
    // Never reuse old records for new submissions.
    let uniqueTicketId = generateUniqueTicketId();
    let attempts = 0;
    while (db.getParticipantByTicketId(uniqueTicketId) && attempts < 10) {
      uniqueTicketId = generateUniqueTicketId();
      attempts++;
    }

    const ticketRecord = db.createParticipant({
      telegram_id: cleanTgId,
      full_name: guestFullName,
      guest_name: guestFullName,
      phone: String(phone).trim(),
      guests_count: cleanGuestsCount,
      comment: comment ? String(comment).trim() : '',
      unique_ticket_id: uniqueTicketId,
      ticket_id: uniqueTicketId,
      couple_names: cleanCouple,
      groom_bride: cleanCouple,
      venue_name: cleanVenueName,
      venue_address: cleanVenueAddress,
      event_date_time: cleanEventDateTime,
      event_date: cleanEventDateTime,
      event_type: cleanEventType
    });

    console.log(`[Registration] Brand new unique invitation created: ${ticketRecord.full_name} (${ticketRecord.unique_ticket_id})`);

    // Instant Bot Notification: Send invitation card replica to user's Telegram chat
    if (cleanTgId && bot && isBotActive) {
      sendTicketToUser(cleanTgId, ticketRecord).catch((e) => {
        console.warn('[Notification Error]:', e.message);
      });
    }

    // Optional: Notify organizer / admin chat
    if (ADMIN_CHAT_ID && bot && isBotActive && !existing) {
      const adminMsg = `🔔 <b>Yangi Mehmon Ro'yxatdan O'tdi!</b>\n\n` +
        `👤 <b>Ism:</b> ${ticketRecord.full_name}\n` +
        `📞 <b>Telefon:</b> ${ticketRecord.phone}\n` +
        `👥 <b>Mehmonlar soni:</b> ${ticketRecord.guests_count} kishi\n` +
        `🎫 <b>Chipta ID:</b> <code>${ticketRecord.unique_ticket_id}</code>\n` +
        `💬 <b>Tilak:</b> ${ticketRecord.comment || "—"}`;

      bot.telegram.sendMessage(ADMIN_CHAT_ID, adminMsg, { parse_mode: 'HTML' }).catch(() => {});
    }

    const cleanTicketId = (ticketRecord.unique_ticket_id || ticketRecord.ticket_id || '').replace('#', '');
    const inviteUrl = `${WEBAPP_URL}/invite.html?ticket=${encodeURIComponent(cleanTicketId)}`;

    return res.status(200).json({
      success: true,
      message: "Ro'yxatdan o'tish muvaffaqiyatli yakunlandi!",
      ticket: ticketRecord,
      invitation: ticketRecord,
      ticket_id: ticketRecord.unique_ticket_id,
      invite_url: inviteUrl
    });

  } catch (error) {
    console.error('[API Error /api/register]:', error);
    return res.status(500).json({
      success: false,
      error: "Serverda kutilmagan xatolik yuz berdi. Iltimos qaytadan urinib ko'ring."
    });
  }
});

/**
 * Universal Invitation / Ticket Retrieval Handler
 * Supports both /api/invitation/:ticket and /api/ticket/:ticketId
 */
function handleGetInvitation(req, res) {
  const ticketParam = req.params.ticket || req.params.ticketId;
  const ticket = db.getParticipantByTicketId(ticketParam);

  if (!ticket) {
    return res.status(404).json({
      success: false,
      valid: false,
      error: "Bunday raqamli chipta / taklifnoma topilmadi."
    });
  }

  const cleanTicketId = (ticket.unique_ticket_id || ticket.ticket_id || '').replace('#', '');
  const inviteUrl = `${WEBAPP_URL}/invite.html?ticket=${encodeURIComponent(cleanTicketId)}`;

  const invitationData = {
    id: ticket.id,
    ticket_id: ticket.unique_ticket_id || ticket.ticket_id,
    unique_ticket_id: ticket.unique_ticket_id || ticket.ticket_id,
    guest_name: ticket.full_name || ticket.guest_name,
    full_name: ticket.full_name || ticket.guest_name,
    groom_bride: ticket.couple_names || ticket.groom_bride,
    couple_names: ticket.couple_names || ticket.groom_bride,
    venue_name: ticket.venue_name,
    venue_address: ticket.venue_address,
    event_date: ticket.event_date_time || ticket.event_date,
    event_date_time: ticket.event_date_time || ticket.event_date,
    event_type: ticket.event_type || "Nikoh toʻyi",
    phone: ticket.phone,
    guests_count: ticket.guests_count,
    comment: ticket.comment,
    created_at: ticket.created_at,
    invite_url: inviteUrl,
    status: "VIP TASDIQLANDI"
  };

  return res.json({
    success: true,
    valid: true,
    ticket: invitationData,
    invitation: invitationData
  });
}

app.get('/api/invitation/:ticket', handleGetInvitation);
app.get('/api/ticket/:ticketId', handleGetInvitation);

/**
 * GET /api/user-ticket/:telegramId
 * Find ticket by Telegram User ID
 */
app.get('/api/user-ticket/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  const ticket = db.getParticipantByTelegramId(telegramId);

  if (!ticket) {
    return res.status(404).json({ success: false, error: "Chipta topilmadi." });
  }

  return res.json({ success: true, ticket });
});

/**
 * GET /api/stats
 * Event stats summary for organizers
 */
app.get('/api/stats', (req, res) => {
  const stats = db.getStats();
  const recent = db.getAllParticipants(10, 0);
  return res.json({
    success: true,
    event: EVENT_TITLE,
    date: EVENT_DATE,
    stats,
    recent_guests: recent.map((r) => ({
      ticket_id: r.unique_ticket_id,
      name: r.full_name,
      guests: r.guests_count,
      created_at: r.created_at
    }))
  });
});

/**
 * GET /api/guests
 * Retrieve all registered guests and stats for admin management
 */
app.get('/api/guests', (req, res) => {
  try {
    const guests = db.getAllParticipants(1000, 0);
    const stats = db.getStats();
    res.json({
      success: true,
      stats,
      guests
    });
  } catch (err) {
    console.error('[API /api/guests error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/guests
 * Create or update a guest manually from the Admin panel
 */
app.post('/api/guests', (req, res) => {
  try {
    const { id, full_name, phone, guests_count, comment } = req.body;
    if (!full_name || full_name.trim().length < 2) {
      return res.status(400).json({ success: false, error: "Ism va familiyani kiriting." });
    }
    if (!phone || phone.trim().length < 7) {
      return res.status(400).json({ success: false, error: "Telefon raqamini kiriting." });
    }

    if (id) {
      // Update existing guest
      const updated = db.updateParticipant(id, { full_name, phone, guests_count, comment });
      if (!updated) {
        return res.status(404).json({ success: false, error: "Mehmon topilmadi." });
      }
      return res.json({ success: true, message: "Mehmon ma'lumotlari yangilandi!", guest: updated });
    } else {
      // Create new guest
      let uniqueTicketId = generateUniqueTicketId();
      while (db.getParticipantByTicketId(uniqueTicketId)) {
        uniqueTicketId = generateUniqueTicketId();
      }
      const created = db.createParticipant({
        telegram_id: null,
        full_name: full_name.trim(),
        phone: phone.trim(),
        guests_count: Math.max(1, parseInt(guests_count, 10) || 1),
        comment: comment ? comment.trim() : '',
        unique_ticket_id: uniqueTicketId
      });
      return res.json({ success: true, message: "Yangi mehmon muvaffaqiyatli qo'shildi!", guest: created });
    }
  } catch (err) {
    console.error('[API POST /api/guests error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/guests/:id
 * Delete a guest from the database
 */
app.delete('/api/guests/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.deleteParticipant(id);
    res.json({ success: true, message: "Mehmon o'chirildi." });
  } catch (err) {
    console.error('[API DELETE /api/guests error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/settings
 * Return current wedding / event settings
 */
app.get('/api/settings', (req, res) => {
  const settings = getSettings();
  res.json({
    success: true,
    settings
  });
});

/**
 * POST /api/settings
 * Update wedding / event settings from Admin panel
 */
app.post('/api/settings', (req, res) => {
  try {
    const current = getSettings();
    const updated = {
      ...current,
      ...req.body
    };

    if (updated.music_loop_start !== undefined) {
      updated.music_loop_start = Number(updated.music_loop_start) || 0;
    }
    if (updated.music_loop_end !== undefined) {
      updated.music_loop_end = Number(updated.music_loop_end) || 166;
    }

    saveSettings(updated);
    console.log(`[Settings] Updated successfully: ${updated.groom_name} & ${updated.bride_name}`);

    res.json({
      success: true,
      message: "To'y ma'lumotlari muvaffaqiyatli saqlandi!",
      settings: updated
    });
  } catch (err) {
    console.error('[Settings] Error saving settings:', err);
    res.status(500).json({
      success: false,
      error: "Sozlamalarni saqlashda xatolik yuz berdi."
    });
  }
});

// -------------------------------------------------------------
// PAYMENT GATEWAYS: CLICK & PAYME WEBHOOKS
// -------------------------------------------------------------

/**
 * Helper: Send instant Telegram notification to user & admin upon successful payment
 */
async function sendPaymentSuccessNotification({ provider, transId, ticketId, amount, telegramId, guestName }) {
  if (!bot || !isBotActive) return;

  const cleanTicketId = String(ticketId || '').replace('#', '');
  const inviteUrl = `${WEBAPP_URL}/invite.html?ticket=${encodeURIComponent(cleanTicketId)}`;

  const formattedAmount = (amount || 0).toLocaleString('uz-UZ');
  let caption = `🎉 <b>TO‘LOV MUVAFFAQIYATLI QABUL QILINDI!</b> 🎉\n\n`;
  caption += `Hurmatli <b>${guestName || 'Mehmon'}</b>!\n`;
  caption += `Sizning <b>"${provider}"</b> orqali amalga oshirgan to‘lovingiz rasman tasdiqlandi.\n\n`;
  caption += `💳 <b>To‘lov tizimi:</b> ${provider}\n`;
  caption += `💰 <b>To‘langan summa:</b> ${formattedAmount} so‘m\n`;
  caption += `🧾 <b>Tranzaksiya ID:</b> <code>${transId}</code>\n`;
  if (ticketId) {
    caption += `🎫 <b>Chipta / Taklifnoma:</b> <code>${ticketId}</code>\n`;
  }
  caption += `⭐ <b>Holat:</b> VIP Tasdiqlandi ✅\n\n`;
  caption += `Elektron taklifnomangizni ko‘rish uchun quyidagi tugmani bosing:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.webApp("💌 Taklifnomani Ochish", inviteUrl)],
    [Markup.button.url("🌐 Brauzerda Ko'rish", inviteUrl)]
  ]);

  if (telegramId) {
    try {
      await bot.telegram.sendMessage(telegramId, caption, {
        parse_mode: 'HTML',
        ...keyboard
      });
      console.log(`[Payment] Success notification sent to Telegram user: ${telegramId}`);
    } catch (err) {
      console.warn(`[Payment] Could not notify user ${telegramId}:`, err.message);
    }
  }

  // Admin Notification
  if (ADMIN_CHAT_ID) {
    try {
      const adminMsg = `💰 <b>YANGI TO‘LOV QABUL QILINDI!</b>\n\n` +
        `👤 <b>Mijoz:</b> ${guestName || '—'}\n` +
        `💳 <b>Tizim:</b> ${provider}\n` +
        `💵 <b>Summa:</b> ${formattedAmount} so‘m\n` +
        `🎫 <b>Chipta ID:</b> <code>${ticketId || '—'}</code>\n` +
        `🧾 <b>Tranzaksiya:</b> <code>${transId}</code>`;
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, adminMsg, { parse_mode: 'HTML' });
    } catch {}
  }
}

/**
 * POST /api/click/webhook
 * Handles Click Prepare & Complete webhook requests
 */
app.post('/api/click/webhook', async (req, res) => {
  await clickService.handleWebhook(req, res, sendPaymentSuccessNotification);
});

/**
 * POST /api/payme/webhook
 * Handles Payme JSON-RPC 2.0 merchant webhook requests
 */
app.post('/api/payme/webhook', async (req, res) => {
  await paymeService.handleWebhook(req, res, sendPaymentSuccessNotification);
});

/**
 * GET /api/payment/generate-url
 * Generate Click / Payme checkout link
 * Query: ?provider=click|payme&ticketId=VO-XXX&amount=50000
 */
app.get('/api/payment/generate-url', (req, res) => {
  const { provider, ticketId, amount } = req.query;
  const prov = String(provider || 'click').toLowerCase();
  const amt = parseFloat(amount) || 50000;
  const tId = String(ticketId || '').trim();

  if (!tId) {
    return res.status(400).json({ success: false, error: "Chipta ID kiritilmagan." });
  }

  let paymentUrl = '';
  if (prov === 'click') {
    paymentUrl = clickService.generatePaymentUrl({
      ticketId: tId,
      amount: amt,
      returnUrl: `${WEBAPP_URL}/invite.html?ticket=${encodeURIComponent(tId.replace('#', ''))}`
    });
  } else if (prov === 'payme') {
    paymentUrl = paymeService.generatePaymentUrl({
      ticketId: tId,
      amount: amt
    });
  } else {
    return res.status(400).json({ success: false, error: "Noma'lum to'lov provayderi (click yoki payme tanlang)." });
  }

  return res.json({
    success: true,
    provider: prov,
    ticketId: tId,
    amount: amt,
    payment_url: paymentUrl
  });
});

/**
 * GET /api/payment/transactions
 * Get recent transactions for Admin
 */
app.get('/api/payment/transactions', (req, res) => {
  try {
    const transactions = db.getAllTransactions(100);
    res.json({ success: true, count: transactions.length, transactions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    database_driver: db.driver,
    bot_active: isBotActive,
    webapp_url: WEBAPP_URL
  });
});

// Fallback route: serve index.html for any unhandled page request
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -------------------------------------------------------------
// START SERVER AND BOT
// -------------------------------------------------------------
let server = null;

async function startApp() {
  // Initialize Telegram Bot
  if (BOT_TOKEN && BOT_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN' && BOT_TOKEN !== 'your_telegram_bot_token_here') {
    try {
      bot = new Telegraf(BOT_TOKEN);
      setupBotCommands(bot);

      // Verify token with getMe
      const botInfo = await bot.telegram.getMe();
      bot.botInfo = botInfo;
      isBotActive = true;
      console.log(`[Telegram Bot] Authenticated successfully as @${botInfo.username}`);

      // Start long polling
      bot.launch({ dropPendingUpdates: true }).catch((err) => {
        console.warn('[Telegram Bot] Polling warning:', err.message);
      });
      console.log(`[Telegram Bot] Polling started: actively listening for Telegram users!`);

      // Automatically configure Chat Menu Button
      await updateChatMenuButton(null, "Taklif noma", WEBAPP_URL);
      console.log(`[Telegram Bot] Chat Menu Button linked to: ${WEBAPP_URL}`);
    } catch (botErr) {
      console.warn('[Telegram Bot] Failed to initialize bot with BOT_TOKEN:', botErr.message);
      isBotActive = false;
    }
  } else {
    console.log('[Telegram Bot] Notice: BOT_TOKEN is not configured yet in .env');
  }

  // Start Express Server
  server = app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`✨ VISOL OQSHOMI - TELEGRAM MINI APP SERVER IS LIVE!`);
    console.log(`🌐 Local Web App:     http://localhost:${PORT}`);
    if (WEBAPP_URL && WEBAPP_URL.startsWith('https://')) {
      console.log(`🚀 Public HTTPS URL:  ${WEBAPP_URL}`);
    }
    console.log(`📦 Database:          SQLite (${db.driver})`);
    console.log(`🤖 Telegram Bot:      ${isBotActive ? `@${bot?.botInfo?.username} (ACTIVE)` : 'Inactive'}`);
    console.log(`====================================================`);
  });
}

// Graceful termination handling
function handleGracefulShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}. Closing gracefully...`);
  if (bot && isBotActive) {
    try {
      bot.stop(signal);
    } catch {}
  }
  if (server) {
    server.close(() => {
      console.log('[Shutdown] Server closed successfully.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

process.once('SIGINT', () => handleGracefulShutdown('SIGINT'));
process.once('SIGTERM', () => handleGracefulShutdown('SIGTERM'));

startApp();
