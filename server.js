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
const BUILD_VERSION = Date.now();
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '-5542867358';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6JN6cT8qet4kdBzHnB9hX4tRgnhy3xwRfFAA6pyUa2Oww';

// Active payment message tracking per user to allow deleting previous message when new orders arrive
const userPaymentMessages = new Map();

// Active interactive wizard states for creating invitations via bot
// key: userId (string), value: { step: string, data: object }
const userWizardStates = new Map();

// Helper: Get readable display name of design
function getDesignDisplayName(design) {
  const d = String(design || 'visol').toLowerCase();
  if (d === 'enikoh' || d === 'e-nikoh' || d === 'e_nikoh') {
    return '💍 "E-Nikoh Oqshomi"';
  }
  return '✨ "Visol Oqshomi"';
}

// Helper: Generate proper invite URL based on chosen design
function getInvitationUrl(ticket) {
  if (!ticket) return WEBAPP_URL;
  const cleanTicketId = (ticket.unique_ticket_id || ticket.ticket_id || '').replace('#', '');
  const design = String(ticket.design || 'visol').toLowerCase();
  const music = ticket.music || ticket.song || 'music1';

  if (design === 'enikoh' || design === 'e-nikoh' || design === 'e_nikoh') {
    const params = new URLSearchParams({
      ticket: cleanTicketId,
      name: ticket.full_name || ticket.guest_name || '',
      couple: ticket.couple_names || ticket.groom_bride || '',
      date: ticket.event_date_time || ticket.event_date || '',
      venue: ticket.venue_name || ticket.venue_address || '',
      music: music
    });
    if (ticket.family_names || ticket.family) {
      params.set('family', ticket.family_names || ticket.family);
    }
    return `${WEBAPP_URL}/enikoh.html?${params.toString()}`;
  }

  // Default: Visol Oqshomi design
  const visolParams = new URLSearchParams({
    ticket: cleanTicketId,
    music: music
  });
  if (ticket.family_names || ticket.family) {
    visolParams.set('family', ticket.family_names || ticket.family);
  }
  return `${WEBAPP_URL}/invite.html?${visolParams.toString()}`;
}

// Helper: Build Design Selection Inline Keyboard
function getDesignSelectionKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✨ 1) Visol Oqshomi", "design_select:visol"),
      Markup.button.callback("💍 2) E-Nikoh Oqshomi", "design_select:enikoh")
    ],
    [
      Markup.button.url("🌐 E-Nikoh Namunasini Ko'rish", `${WEBAPP_URL}/enikoh.html`)
    ],
    [
      Markup.button.webApp("📱 Mini App orqali yaratish", `${WEBAPP_URL}/index.html?v=${BUILD_VERSION}`)
    ]
  ]);
}

// Helper: Main Persistent Bottom Reply Keyboard for quick user actions
function getMainReplyKeyboard() {
  return Markup.keyboard([
    ["🎟️ Yangi taklifnoma yaratish", "❌ Bekor qilish (Atmen)"],
    ["📋 Mening taklifnomalarim", "📞 Bog'lanish / Yordam"]
  ]).resize();
}

// Helper: Build Unpaid Orders Payment View with Cancellation buttons
function buildUnpaidOrderDetails(userId, firstName = 'Hurmatli mehmon') {
  const unpaidList = db.getUnpaidParticipantsByTelegramId(userId);

  if (!unpaidList || unpaidList.length === 0) {
    return {
      hasUnpaid: false,
      text: `✨ <b>Barcha to'lanmagan taklifnomalaringiz bekor qilindi.</b>\n\nYangi taklifnoma yaratish uchun dizayn tanlang:`,
      keyboard: getDesignSelectionKeyboard()
    };
  }

  const totalSum = unpaidList.reduce((sum, t) => sum + (t.total_price || 2000), 0);
  const formattedTotal = totalSum.toLocaleString('uz-UZ');

  let text = '';
  const inlineButtons = [];

  if (unpaidList.length > 1) {
    text = `🧾 <b>Sizda ${unpaidList.length} ta to'lanmagan taklifnoma mavjud!</b>\n\n`;
    unpaidList.forEach((t, idx) => {
      text += `${idx + 1}. <b>${t.full_name}</b> (<code>${t.unique_ticket_id}</code>, ${getDesignDisplayName(t.design)}) — ${(t.total_price || 2000).toLocaleString('uz-UZ')} so'm\n`;
    });
    text += `\n💰 <b>To'lov uchun umumiy summa: ${formattedTotal} so'm</b>\n`;
    text += `💳 Karta raqami: <code>5614 6814 2617 2270</code> (Uzcard)\n`;
    text += `👤 Karta egasi: <b>Nosirov Nuriddin</b>\n\n`;
    text += `Iltimos, umumiy pulni o'tkazib, <b>bitta umumiy chek rasmini</b> shu botga yuboring.\n\n`;
    text += `<i>💡 Test yoki ortiqcha taklifnomalarni bekor qilish (atmen) uchun quyidagi tugmalardan birini bosing:</i>`;

    // Har bir xat uchun "❌ 1-sini bekor qilish", "❌ 2-sini bekor qilish"... tugmalari (2 tadan)
    for (let i = 0; i < unpaidList.length; i += 2) {
      const row = [];
      const t1 = unpaidList[i];
      const cleanId1 = t1.unique_ticket_id.replace('#', '');
      row.push(Markup.button.callback(`❌ ${i + 1}-sini bekor qilish`, `cancel_ticket:${cleanId1}`));

      if (i + 1 < unpaidList.length) {
        const t2 = unpaidList[i + 1];
        const cleanId2 = t2.unique_ticket_id.replace('#', '');
        row.push(Markup.button.callback(`❌ ${i + 2}-sini bekor qilish`, `cancel_ticket:${cleanId2}`));
      }
      inlineButtons.push(row);
    }

    // Bitta yoki bir nechta xatni raqami bilan va barchasini atmen qilish
    inlineButtons.push([
      Markup.button.callback("✍️ Raqam yozib bekor qilish", "cancel_by_number_prompt"),
      Markup.button.callback("🗑️ Barchasini bekor qilish", "cancel_all_unpaid")
    ]);

  } else {
    // 1 ta to'lanmagan taklifnoma
    const singleTicket = unpaidList[0];
    const cleanId = singleTicket.unique_ticket_id.replace('#', '');

    text = `To'lov uchun summa: <b>${formattedTotal} so'm</b>\n` +
      `Karta raqami: <code>5614 6814 2617 2270</code> (Uzcard)\n` +
      `Karta egasi: <b>Nosirov Nuriddin</b>\n\n` +
      `Iltimos, pulni o'tkazib, chek rasmini shu botga yuboring.`;

    inlineButtons.push([
      Markup.button.callback("❌ Ushbu taklifnomani bekor qilish", `cancel_ticket:${cleanId}`)
    ]);
  }

  inlineButtons.push([
    Markup.button.callback("🎨 Yangi Dizayn Tanlash", "create_new_invite"),
    Markup.button.webApp("📱 Mini App orqali", `${WEBAPP_URL}/index.html`)
  ]);

  return {
    hasUnpaid: true,
    totalSum,
    formattedTotal,
    count: unpaidList.length,
    text,
    keyboard: Markup.inlineKeyboard(inlineButtons),
    unpaidList
  };
}

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

// Keep-alive / Health-check endpoint for UptimeRobot, Render, and monitors
app.get(['/ping', '/health'], (req, res) => {
  res.status(200).json({
    status: 'ok',
    app: 'visol-oqshomi',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Serve static Mini App frontend with anti-cache headers for Telegram WebApps
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path === '') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
  }
}));

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
        web_app: { url: url || `${WEBAPP_URL}/index.html?v=${BUILD_VERSION}` }
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
  // Helper to send design choices to user
  const sendDesignSelection = async (ctx, customIntro) => {
    const s = getSettings();
    const intro = customIntro || 
      `🎨 <b>Taklifnoma uchun dizayn variantini tanlang:</b>\n\n` +
      `1️⃣ <b>"Visol Oqshomi"</b> — Hashamatli qirollik uslubidagi eksklyuziv to'y taklifnomasi.\n` +
      `2️⃣ <b>"E-Nikoh Oqshomi"</b> — Zamonaviy va nafis elektron taklifnoma dizayni.\n` +
      `🔗 Havolasi: ${WEBAPP_URL}/enikoh.html\n\n` +
      `<i>O'zingizga ma'qul dizayn tugmasini bosing:</i>`;

    await ctx.replyWithHTML(intro, getDesignSelectionKeyboard());
  };

  // Bot /start command
  botInstance.start(async (ctx) => {
    const user = ctx.from;
    const userId = String(user?.id);
    const firstName = user?.first_name || 'Hurmatli mehmon';
    const s = getSettings();

    // Set persistent bottom reply keyboard for easy access to "Atmen" and "Create"
    await ctx.reply(`Assalomu alaykum, ${firstName}!`, getMainReplyKeyboard()).catch(() => {});

    // Check existing tickets for this user
    const unpaidList = db.getUnpaidParticipantsByTelegramId(userId);
    const pendingVerList = db.getPendingVerificationParticipantsByTelegramId(userId);
    const paidList = db.getPaidParticipantsByTelegramId(userId);

    const regUrl = `${WEBAPP_URL}/index.html?v=${BUILD_VERSION}`;

    // 1. Agar foydalanuvchida to'lanmagan buyurtma bo'lsa, to'lov ma'lumotlarini va atmen tugmalarini chiqaramiz
    if (unpaidList.length > 0) {
      const unpaidView = buildUnpaidOrderDetails(userId, firstName);
      await ctx.replyWithHTML(unpaidView.text, unpaidView.keyboard);
    } else if (pendingVerList.length > 0) {
      // 2. Chek adminga yuborilgan va tekshiruv jarayonida
      let pendingText = `⏳ <b>Chekingiz qabul qilingan va tekshirilmoqda (${pendingVerList.length} ta taklifnoma).</b>\n\n` +
        `Admin uni tekshirib, 1 soat ichida taklifnomangiz havolasini yuboradi. Iltimos, kuting.\n\n` +
        `Yana boshqa taklifnoma yaratmoqchi bo'lsangiz, quyidagi tugmani bosing:`;

      await ctx.replyWithHTML(pendingText, Markup.inlineKeyboard([
        [Markup.button.callback("✨ Yangi Taklifnoma Yaratish", "create_new_invite")]
      ]));

    } else if (paidList.length > 0) {
      // 3. Tasdiqlangan taklifnomalar mavjud
      let successListText = `🎉 <b>Assalomu alaykum, ${firstName}!</b>\n\n` +
        `Sizning tasdiqlangan rasmiy taklifnomalaringiz:\n\n`;

      const inviteButtons = [];
      paidList.forEach((p, idx) => {
        const invUrl = getInvitationUrl(p);
        const dName = getDesignDisplayName(p.design);
        successListText += `${idx + 1}. <b>${p.full_name}</b> (${dName})\n🔗 <code>${invUrl}</code>\n\n`;
        inviteButtons.push([
          Markup.button.url(`💌 ${p.full_name.slice(0, 15)} taklifnomasi`, invUrl),
          Markup.button.url("🌐 Ochish", invUrl)
        ]);
      });

      inviteButtons.push([
        Markup.button.callback("✨ Yangi Taklifnoma Yaratish", "create_new_invite"),
        Markup.button.webApp("📱 Mini App", regUrl)
      ]);

      await ctx.replyWithHTML(successListText, Markup.inlineKeyboard(inviteButtons));

    } else {
      // 4. Yangi foydalanuvchi — Dizayn tanlash bosqichini taqdim etish
      const welcomeText = 
        `✨ <b>Assalomu alaykum va xush kelibsiz, ${firstName}!</b> ✨\n\n` +
        `To'y va tantanalaringiz uchun eng chiroyli raqamli elektron taklifnomalarni tayyorlab beramiz.\n\n` +
        `🎨 <b>1. Dizayn tanlash bosqichi:</b>\n` +
        `O'zingizga yoqqan dizayn variantini tanlang:\n\n` +
        `1️⃣ <b>"Visol Oqshomi"</b> — Hashamatli qirollik uslubidagi oltin rangli dizayn\n` +
        `2️⃣ <b>"E-Nikoh Oqshomi"</b> — Nafis va zamonaviy to'y taklifnomasi dizayni\n` +
        `🔗 <i>E-Nikoh namunasi: ${WEBAPP_URL}/enikoh.html</i>\n\n` +
        `Kerakli dizayn tugmasini bosing:`;

      await ctx.replyWithHTML(welcomeText, getDesignSelectionKeyboard());
    }

    // Auto update user's Chat Menu Button to latest active WebApp URL
    if (user?.id) {
      updateChatMenuButton(user.id, "Taklif noma", regUrl);
    }
  });

  // Commands to start creating invitation
  botInstance.command(['create', 'new', 'taklifnoma', 'dizayn'], async (ctx) => {
    userWizardStates.delete(String(ctx.from.id));
    await sendDesignSelection(ctx);
  });

  // Action: Create new invite button clicked
  botInstance.action('create_new_invite', async (ctx) => {
    await ctx.answerCbQuery();
    userWizardStates.delete(String(ctx.from.id));
    await sendDesignSelection(ctx);
  });

  // Action: Select design (Visol Oqshomi or E-Nikoh Oqshomi) -> Ask to choose music
  botInstance.action(/^design_select:(visol|enikoh)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const design = ctx.match[1];
    const userId = String(ctx.from.id);
    const designDisplayName = getDesignDisplayName(design);
    const s = getSettings();

    // Initialize creation wizard for this user
    userWizardStates.set(userId, {
      step: 'waiting_music',
      data: {
        design,
        music: 'music1',
        event_type: s.event_type || 'Nikoh toʻyi',
        couple_names: `${s.groom_name} va ${s.bride_name}`,
        event_date_time: `${s.day_number}-${s.month_name}, ${s.year} • ${s.event_time}`,
        venue_name: `${s.venue_name}, ${s.venue_address}`
      }
    });

    const musicPrompt = 
      `🎨 <b>Tanlangan dizayn:</b> <b>${designDisplayName}</b>\n\n` +
      `🎵 <b>Taklifnoma uchun qo'shiqni tanlang:</b>\n\n` +
      `1️⃣ <b>"Kelibdi"</b> — Sho'x va tantanali klassik to'y qo'shig'i\n` +
      `2️⃣ <b>"Jon qizim"</b> — Nafis va ta'sirli qiz uzatish taronasi\n\n` +
      `<i>O'zingizga ma'qul qo'shiq tugmasini bosing:</i>`;

    await ctx.replyWithHTML(musicPrompt, Markup.inlineKeyboard([
      [
        Markup.button.callback("🎵 1) Kelibdi", "music_select:music1"),
        Markup.button.callback("👰 2) Jon qizim", "music_select:music2")
      ],
      [Markup.button.callback("🔙 Yaratishni to'xtatish", "cancel_wizard")]
    ]));
  });

  // Action: Select music
  botInstance.action(/^music_select:(music1|music2)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const musicChoice = ctx.match[1];
    const userId = String(ctx.from.id);
    const state = userWizardStates.get(userId);
    if (!state) return;

    state.data.music = musicChoice;
    state.step = 'waiting_fullname';

    const musicTitle = musicChoice === 'music2' ? '"Jon qizim"' : '"Kelibdi"';
    const step1Prompt = 
      `🎶 <b>Tanlangan qo'shiq:</b> <b>${musicTitle}</b>\n\n` +
      `Endi taklifnoma ma'lumotlarini kiritamiz.\n\n` +
      `1️⃣ <b>Ism va familiyangizni</b> (yoki taklifnomada ko'rinadigan mehmon/taklif etuvchi ismini) kiriting:\n` +
      `<i>(Masalan: Akmal Razzoqov yoki Alisher va Ziyoda)</i>`;

    await ctx.replyWithHTML(step1Prompt, Markup.inlineKeyboard([
      [Markup.button.callback("🔙 Yaratishni to'xtatish", "cancel_wizard")]
    ]));
  });

  // Action: Cancel specific unpaid ticket by ticket ID
  botInstance.action(/^cancel_ticket:(.+)$/, async (ctx) => {
    try {
      const ticketId = ctx.match[1];
      const userId = String(ctx.from.id);

      const beforeList = db.getUnpaidParticipantsByTelegramId(userId);
      const targetTicket = beforeList.find(t => 
        t.unique_ticket_id.replace('#', '') === ticketId.replace('#', '')
      );
      const oldCount = beforeList.length;
      const oldSum = beforeList.reduce((sum, t) => sum + (t.total_price || 2000), 0);

      db.deleteParticipantByTicketId(ticketId);
      await ctx.answerCbQuery("Taklifnoma bekor qilindi ❌").catch(() => {});

      const afterList = db.getUnpaidParticipantsByTelegramId(userId);
      const newCount = afterList.length;
      const newSum = afterList.reduce((sum, t) => sum + (t.total_price || 2000), 0);

      const ticketName = targetTicket ? targetTicket.full_name : 'Taklifnoma';

      let confirmMsg = `🗑️ <b>"${ticketName}" taklifnomasi bekor qilindi!</b>\n\n`;
      if (newCount > 0) {
        confirmMsg += `📊 <b>Hisob-kitob yangilandi:</b>\n` +
          `• Oldin: <b>${oldCount} ta</b> taklifnoma (${oldSum.toLocaleString('uz-UZ')} so'm)\n` +
          `• <b>Hozir: ${newCount} ta taklifnoma qoldi (${newSum.toLocaleString('uz-UZ')} so'm bo'ldi)</b>\n\n` +
          `💰 <b>To'lov uchun yangi summa: ${newSum.toLocaleString('uz-UZ')} so'm</b>\n` +
          `💳 Karta raqami: <code>5614 6814 2617 2270</code> (Uzcard)\n` +
          `👤 Karta egasi: <b>Nosirov Nuriddin</b>\n\n` +
          `<i>💡 Yana boshqa taklifnomani bekor qilish uchun quyidagi tugmalardan birini bosing:</i>`;
      } else {
        confirmMsg += `✨ <b>Barcha to'lanmagan taklifnomalaringiz bekor qilindi!</b>\n` +
          `To'lov summasi: <b>0 so'm</b> bo'ldi.\n\n` +
          `Yangi taklifnoma yaratish uchun quyidagi dizaynlardan birini tanlang:`;
      }

      const view = buildUnpaidOrderDetails(userId, ctx.from.first_name);

      await ctx.replyWithHTML(confirmMsg, newCount > 0 ? view.keyboard : getDesignSelectionKeyboard());

      try {
        await ctx.editMessageText(confirmMsg, {
          parse_mode: 'HTML',
          ...(newCount > 0 ? view.keyboard : getDesignSelectionKeyboard())
        });
      } catch (e) {}
    } catch (err) {
      console.warn('[Cancel Ticket Error]:', err.message);
      ctx.answerCbQuery("Xatolik yuz berdi").catch(() => {});
    }
  });

  // Action: Cancel all unpaid tickets at once
  botInstance.action('cancel_all_unpaid', async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      const beforeList = db.getUnpaidParticipantsByTelegramId(userId);
      const oldCount = beforeList.length;
      const oldSum = beforeList.reduce((sum, t) => sum + (t.total_price || 2000), 0);

      db.deleteAllUnpaidParticipants(userId);
      await ctx.answerCbQuery("Barcha taklifnomalar bekor qilindi 🗑️").catch(() => {});

      const confirmMsg = `🗑️ <b>Barcha to'lanmagan taklifnomalaringiz (${oldCount} ta — ${oldSum.toLocaleString('uz-UZ')} so'm) bekor qilindi!</b>\n\n` +
        `To'lov summasi: <b>0 so'm</b> bo'ldi.\n\n` +
        `Yangi taklifnoma yaratish uchun dizayn tanlang:`;

      await ctx.replyWithHTML(confirmMsg, getDesignSelectionKeyboard());

      try {
        await ctx.editMessageText(confirmMsg, {
          parse_mode: 'HTML',
          ...getDesignSelectionKeyboard()
        });
      } catch (e) {}
    } catch (err) {
      console.warn('[Cancel All Unpaid Error]:', err.message);
      ctx.answerCbQuery("Xatolik yuz berdi").catch(() => {});
    }
  });

  // Action: Prompt user to type which item number(s) to cancel
  botInstance.action('cancel_by_number_prompt', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const userId = String(ctx.from.id);
      const unpaidList = db.getUnpaidParticipantsByTelegramId(userId);

      if (!unpaidList || unpaidList.length === 0) {
        return ctx.reply("Sizda bekor qilish uchun to'lanmagan taklifnoma yo'q.");
      }

      const totalSum = unpaidList.reduce((sum, t) => sum + (t.total_price || 2000), 0);

      userWizardStates.set(userId, {
        step: 'waiting_cancel_indices'
      });

      let prompt = `🧾 <b>Sizda ${unpaidList.length} ta to'lanmagan taklifnoma mavjud!</b>\n` +
        `💰 <b>Umumiy summa: ${totalSum.toLocaleString('uz-UZ')} so'm</b>\n\n` +
        `🗑️ <b>Qaysi taklifnomalarni bekor qilmoqchisiz?</b>\n\n`;
      unpaidList.forEach((t, idx) => {
        prompt += `${idx + 1}. <b>${t.full_name}</b> (<code>${t.unique_ticket_id}</code>, ${getDesignDisplayName(t.design)}) — ${(t.total_price || 2000).toLocaleString('uz-UZ')} so'm\n`;
      });
      prompt += `\nBekor qilmoqchi bo'lgan taklifnoma raqamini yozing:\n` +
        `• Bitta xat uchun: <code>2</code>\n` +
        `• Bir nechta xat uchun: <code>1, 3</code> yoki <code>2 4</code>\n` +
        `• Barchasini bekor qilish uchun: <code>hammasi</code> deb yozing.`;

      await ctx.replyWithHTML(prompt, Markup.inlineKeyboard([
        [Markup.button.callback("❌ Chiqish", "cancel_index_input")]
      ]));
    } catch (e) {
      console.warn('[Cancel By Number Prompt Error]:', e.message);
    }
  });

  // Action: Exit number cancel mode
  botInstance.action('cancel_index_input', async (ctx) => {
    await ctx.answerCbQuery("Chiqildi");
    const userId = String(ctx.from.id);
    userWizardStates.delete(userId);
    const view = buildUnpaidOrderDetails(userId, ctx.from.first_name);
    await ctx.replyWithHTML(view.text, view.keyboard);
  });

  // Commands to cancel/manage unpaid tickets
  botInstance.command(['cancel', 'atmen', 'ochirish'], async (ctx) => {
    const userId = String(ctx.from.id);
    userWizardStates.delete(userId);
    const view = buildUnpaidOrderDetails(userId, ctx.from.first_name);
    await ctx.replyWithHTML(view.text, view.keyboard);
  });

  // Action: Cancel creation wizard
  botInstance.action('cancel_wizard', async (ctx) => {
    await ctx.answerCbQuery("To'xtatildi").catch(() => {});
    const userId = String(ctx.from.id);
    userWizardStates.delete(userId);

    const unpaidList = db.getUnpaidParticipantsByTelegramId(userId);
    if (unpaidList && unpaidList.length > 0) {
      const view = buildUnpaidOrderDetails(userId, ctx.from.first_name);
      await ctx.replyWithHTML(
        `🛑 <b>Yangi taklifnoma yaratish to'xtatildi.</b>\n\n` +
        `Sizda avvaldan yaratilgan to'lanmagan taklifnomalar mavjud:\n\n` + view.text,
        view.keyboard
      );
    } else {
      await ctx.replyWithHTML(
        `❌ Taklifnoma yaratish to'xtatildi.\n\nYangi taklifnoma yaratish uchun dizayn tanlang:`,
        getDesignSelectionKeyboard()
      );
    }
  });

  // Action: Skip wizard fields
  botInstance.action('skip_couple', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from.id);
    const state = userWizardStates.get(userId);
    if (!state) return;
    const s = getSettings();
    state.step = 'waiting_family';
    await ctx.replyWithHTML(
      `3️⃣ <b>Taklif etuvchilar / Oila nomini</b> kiriting:\n<i>(Taklifnoma so'ngida «Hurmat va ehtirom ila...» qatorida chiqadi, masalan: Saidovlar oilasi yoki To'y egalari)</i>`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`⏭️ Standart qoldirish (${s.family_names || "To'y egalari"})`, "skip_family")],
        [Markup.button.callback("🔙 Yaratishni to'xtatish", "cancel_wizard")]
      ])
    );
  });

  botInstance.action('skip_family', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from.id);
    const state = userWizardStates.get(userId);
    if (!state) return;
    const s = getSettings();
    state.data.family_names = s.family_names || "To'y egalari va xonadon ahillari";
    state.step = 'waiting_date';
    await ctx.replyWithHTML(
      `4️⃣ <b>To'y sanasi va vaqtini</b> kiriting:\n<i>(Masalan: 2026-11-20 18:00)</i>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("⏭️ Standart sanani qoldirish", "skip_date")],
        [Markup.button.callback("🔙 Yaratishni to'xtatish", "cancel_wizard")]
      ])
    );
  });

  botInstance.action('skip_date', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from.id);
    const state = userWizardStates.get(userId);
    if (!state) return;
    state.step = 'waiting_venue';
    await ctx.replyWithHTML(
      `4️⃣ <b>To'yxona nomi va manzilini</b> kiriting:\n<i>(Masalan: "Yulduzlar Qasri", Toshkent shahri)</i>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("⏭️ Standart manzilni qoldirish", "skip_venue")],
        [Markup.button.callback("🔙 Yaratishni to'xtatish", "cancel_wizard")]
      ])
    );
  });

  botInstance.action('skip_venue', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from.id);
    const state = userWizardStates.get(userId);
    if (!state) return;
    state.step = 'waiting_phone';
    await ctx.replyWithHTML(
      `5️⃣ <b>Bog'lanish uchun telefon raqamingizni</b> kiriting:\n<i>(Masalan: +998901234567)</i>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Yaratishni to'xtatish", "cancel_wizard")]
      ])
    );
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
          [Markup.button.webApp("🎟️ Ro'yxatdan o'tish", `${WEBAPP_URL}/index.html?v=${BUILD_VERSION}`)]
        ])
      );
    }

    if (ticket.payment_status !== 'paid') {
      const unpaidView = buildUnpaidOrderDetails(telegramId, ticket.full_name);
      return ctx.replyWithHTML(
        `⏳ <b>Taklifnomangiz (<code>${ticket.unique_ticket_id}</code>) to'lovi hali tasdiqlanmagan.</b>\n\n` +
        `Taklifnoma havolasi va QR-kodi faqat to'lov cheki yuborilib, admin tasdiqlaganidan so'ng taqdim etiladi.\n\n` +
        unpaidView.text,
        unpaidView.keyboard
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
      `• /contact - Taklifnoma buyurtma qilish va aloqa\n` +
      `• /id - Ushbu chat yoki guruhning ID raqamini ko'rish\n` +
      `• /help - Ushbu yordam xabari\n\n` +
      `<b>📞 Taklifnoma buyurtma qilish uchun:</b>\n` +
      `• Telefon: +998(94)912-56-51\n` +
      `• Telegram: @nuri1ddin\n` +
      `• Telegram Bot: @VisoloqshomiBot`;
    await ctx.replyWithHTML(helpText);
  });

  // Command: /contact, /zakaz, /boglanish
  botInstance.command(['contact', 'zakaz', 'boglanish'], async (ctx) => {
    const contactText = `✨ <b>Taklifnoma buyurtma qilish uchun bog'laning:</b>\n\n` +
      `📞 <b>Telefon:</b> +998(94)912-56-51\n` +
      `👤 <b>Telegram:</b> @nuri1ddin\n` +
      `🤖 <b>Telegram Bot:</b> @VisoloqshomiBot\n\n` +
      `<i>To'y va marosimlaringiz uchun eng chiroyli elektron taklifnomalarni tayyorlab beramiz!</i>`;
    await ctx.replyWithHTML(contactText, {
      ...Markup.inlineKeyboard([
        [
          Markup.button.url('👤 Telegram: @nuri1ddin', 'https://t.me/nuri1ddin')
        ]
      ])
    });
  });

  // Command: /id or /chatid - Easily get group ID
  botInstance.command(['id', 'chatid'], async (ctx) => {
    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;
    await ctx.replyWithHTML(
      `🆔 <b>Ushbu guruh / chat ID raqami:</b>\n<code>${chatId}</code>\n\n` +
      `<i>(Turi: ${chatType})</i>\n\n` +
      `Ushbu raqamni nusxalab, Render.com dagi <b>ADMIN_CHAT_ID</b> ga qo'yishingiz mumkin.`
    );
  });

  // When bot is added to a group, automatically greet and display the Group ID
  botInstance.on('new_chat_members', async (ctx) => {
    const newMembers = ctx.message?.new_chat_members || [];
    const isThisBot = newMembers.some(m => m.id === botInstance.botInfo?.id);
    if (isThisBot) {
      await ctx.replyWithHTML(
        `👋 <b>Assalomu alaykum! Bot guruhga muvaffaqiyatli qo'shildi.</b>\n\n` +
        `🆔 <b>Guruh ID raqami:</b>\n<code>${ctx.chat.id}</code>\n\n` +
        `Ushbu raqamni Render.com dagi <b>ADMIN_CHAT_ID</b> ga kiritib qo'ying!`
      );
    }
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
      Markup.inlineKeyboard([[Markup.button.webApp("🎟️ Ro'yxatdan o'tish", `${WEBAPP_URL}/index.html?v=${BUILD_VERSION}`)]])
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
    buttons.push([Markup.button.webApp("🎟️ Ro'yxatdan o'tish", `${WEBAPP_URL}/index.html?v=${BUILD_VERSION}`)]);

    await ctx.replyWithHTML(locText, Markup.inlineKeyboard(buttons));
  });

  // -------------------------------------------------------------
  // RECEIPT SUBMISSION & ADMIN APPROVAL FLOW
  // -------------------------------------------------------------

  // 2. Chek rasmini qabul qilish va mijozga javob
  botInstance.on('photo', async (ctx) => {
    const user = ctx.from;
    const userId = String(user.id);
    const username = user.username ? `@${user.username}` : "Mavjud emas";
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || "Mijoz";

    // 2.1 Mijoz chek rasmini yuborganda, bot unga darhol quyidagi javobni beradi:
    await ctx.reply(
      "✅ Chekingiz qabul qilindi! Admin uni tekshirib, 1 soat ichida taklifnomangiz havolasini yuboradi. Iltimos, kuting."
    );

    // Rasmni olish
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const fileId = photo.file_id;

    // Chek yuborilganligi sababli botning eski to'lov so'rash xabarini o'chirish
    const prevMsgId = userPaymentMessages.get(userId) || db.getLastPaymentMsgId(userId);
    if (prevMsgId) {
      botInstance.telegram.deleteMessage(userId, prevMsgId).catch(() => {});
      userPaymentMessages.delete(userId);
    }

    // Mijozning barcha to'lanmagan buyurtmalarini topish
    let pendingTickets = db.getUnpaidParticipantsByTelegramId(userId);
    if (!pendingTickets || pendingTickets.length === 0) {
      pendingTickets = db.getPendingParticipantsByTelegramId(userId);
      if (!pendingTickets || pendingTickets.length === 0) {
        const last = db.getParticipantByTelegramId(userId);
        if (last) pendingTickets = [last];
      }
    }

    // Agar foydalanuvchida hali buyurtma bo'lmasa, chek kelgani sababli avtomatik buyurtma yaratamiz
    if (!pendingTickets || pendingTickets.length === 0) {
      let uniqueTicketId = generateUniqueTicketId();
      while (db.getParticipantByTicketId(uniqueTicketId)) {
        uniqueTicketId = generateUniqueTicketId();
      }
      const s = getSettings();
      const autoTicket = db.createParticipant({
        telegram_id: userId,
        full_name: fullName,
        guest_name: fullName,
        phone: "Noma'lum",
        guests_count: 1,
        couple_names: `${s.groom_name} va ${s.bride_name}`,
        groom_bride: `${s.groom_name} va ${s.bride_name}`,
        venue_name: s.venue_name,
        venue_address: s.venue_address,
        event_date_time: `${s.day_number}-${s.month_name}, ${s.year} • ${s.event_time}`,
        event_date: s.event_date,
        event_type: s.event_type || 'Nikoh toʻyi',
        design: 'visol',
        quantity: 1,
        total_price: 2000,
        payment_status: 'pending_verification',
        receipt_file_id: fileId,
        unique_ticket_id: uniqueTicketId,
        username: user.username || null
      });
      pendingTickets = [autoTicket];
    } else {
      // Barcha buyurtmalarni tekshirishga o'tkazish
      for (const t of pendingTickets) {
        db.updateParticipantPaymentStatus(t.unique_ticket_id, {
          payment_status: 'pending_verification',
          receipt_file_id: fileId,
          username: user.username || null
        });
      }
    }

    const totalTicketsCount = pendingTickets.length;
    const totalAmount = pendingTickets.reduce((sum, t) => sum + (t.total_price || 2000), 0);
    const formattedTotalAmount = totalAmount.toLocaleString('uz-UZ');
    const cleanTicketId = `TG_${userId}`;

    // Tanlangan dizaynni aniqlash
    const primaryDesign = pendingTickets[0]?.design || 'visol';
    const designDisplayName = getDesignDisplayName(primaryDesign);
    const primaryPhone = pendingTickets[0]?.phone || "Noma'lum";

    // 2.2 Chek rasmi, mijoz ma'lumotlari va u tanlagan dizaynni maxsus admin guruhiga yuborish
    const adminChatId = ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
    if (adminChatId) {
      let ticketsListText = '';
      if (pendingTickets.length > 1) {
        ticketsListText = pendingTickets.map((t, idx) => `  ${idx + 1}. <b>${t.full_name}</b> (<code>${t.unique_ticket_id}</code>, ${getDesignDisplayName(t.design)}) — ${(t.total_price || 2000).toLocaleString('uz-UZ')} so'm`).join('\n');
      } else if (pendingTickets.length === 1) {
        ticketsListText = `<code>${pendingTickets[0].unique_ticket_id}</code> (${pendingTickets[0].full_name})`;
      } else {
        ticketsListText = `Yangi buyurtma`;
      }

      const adminCaption = `🧾 <b>YANGI TO‘LOV CHEKI QABUL QILINDI!</b>\n\n` +
        `👤 <b>Mijoz:</b> ${fullName}\n` +
        `📱 <b>Telegram ID:</b> <code>${userId}</code>\n` +
        `🌐 <b>Username:</b> ${username}\n` +
        `📞 <b>Telefon:</b> ${primaryPhone}\n` +
        `🎨 <b>Tanlangan dizayn:</b> <b>${designDisplayName}</b>\n` +
        `💌 <b>Taklifnomalar soni:</b> ${totalTicketsCount} ta\n` +
        `💰 <b>Umumiy to‘lov summasi:</b> <b>${formattedTotalAmount} so'm</b>\n` +
        `🎫 <b>Chiptalar:</b>\n${ticketsListText}\n` +
        `⏰ <b>Vaqt:</b> ${new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}\n\n` +
        `Chekni tekshirib, quyidagi tugma orqali tasdiqlang:`;

      const adminKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            totalTicketsCount > 1 ? `✅ Barcha (${totalTicketsCount} ta) ni Tasdiqlash` : `✅ Tasdiqlash`,
            `approve_payment:${cleanTicketId}`
          )
        ]
      ]);

      try {
        await botInstance.telegram.sendPhoto(adminChatId, fileId, {
          caption: adminCaption,
          parse_mode: 'HTML',
          ...adminKeyboard
        });
        console.log(`[Receipt] Successfully forwarded receipt to admin chat: ${adminChatId}`);
      } catch (err) {
        console.warn(`[Receipt] Failed to send receipt to admin chat ${adminChatId}:`, err.message);
      }
    } else {
      console.warn('[Receipt] Warning: ADMIN_CHAT_ID is not set in .env!');
    }
  });

  // 3. Admin guruhida tasdiqlash va mijozga havola yuborish
  botInstance.action(/^approve_payment:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Tasdiqlanmoqda...");
      const rawTicketId = ctx.match[1];
      const admin = ctx.from;
      const adminName = admin.username ? `@${admin.username}` : (admin.first_name || 'Admin');

      let ticketsToApprove = [];
      let targetTgId = null;

      if (rawTicketId.startsWith('TG_')) {
        targetTgId = rawTicketId.replace('TG_', '');
        ticketsToApprove = db.getPendingParticipantsByTelegramId(targetTgId);
        if (!ticketsToApprove || ticketsToApprove.length === 0) {
          ticketsToApprove = db.getPendingVerificationParticipantsByTelegramId(targetTgId);
        }
        if (!ticketsToApprove || ticketsToApprove.length === 0) {
          ticketsToApprove = db.getUnpaidParticipantsByTelegramId(targetTgId);
        }
        if (!ticketsToApprove || ticketsToApprove.length === 0) {
          const all = db.getAllParticipantsByTelegramId(targetTgId);
          ticketsToApprove = all.filter(t => t.payment_status !== 'paid');
        }
      } else {
        const singleTicket = db.getParticipantByTicketId(rawTicketId);
        if (singleTicket) {
          targetTgId = singleTicket.telegram_id;
          if (targetTgId) {
            ticketsToApprove = db.getPendingParticipantsByTelegramId(targetTgId);
          }
          if (!ticketsToApprove || ticketsToApprove.length === 0) {
            ticketsToApprove = [singleTicket];
          }
        }
      }

      // Agar bazada chipta umuman topilmasa ham, admin bosganda tasdiqlanib mijozga taklifnoma generatsiya qilinadi
      if (!ticketsToApprove || ticketsToApprove.length === 0) {
        if (targetTgId) {
          let uniqueTicketId = generateUniqueTicketId();
          while (db.getParticipantByTicketId(uniqueTicketId)) {
            uniqueTicketId = generateUniqueTicketId();
          }
          const s = getSettings();
          const autoTicket = db.createParticipant({
            telegram_id: targetTgId,
            full_name: 'Hurmatli mehmon',
            guest_name: 'Hurmatli mehmon',
            phone: "Noma'lum",
            guests_count: 1,
            couple_names: `${s.groom_name} va ${s.bride_name}`,
            groom_bride: `${s.groom_name} va ${s.bride_name}`,
            venue_name: s.venue_name,
            venue_address: s.venue_address,
            event_date_time: `${s.day_number}-${s.month_name}, ${s.year} • ${s.event_time}`,
            event_date: s.event_date,
            event_type: s.event_type || 'Nikoh toʻyi',
            design: 'visol',
            quantity: 1,
            total_price: 2000,
            payment_status: 'paid',
            unique_ticket_id: uniqueTicketId
          });
          ticketsToApprove = [autoTicket];
        } else {
          return ctx.reply(`⚠️ Tasdiqlash uchun chipta yoki mijoz ID topilmadi!`);
        }
      }

      // To'lovni tasdiqlash (status: 'paid')
      for (const t of ticketsToApprove) {
        db.updateParticipantPaymentStatus(t.unique_ticket_id, {
          payment_status: 'paid'
        });
      }

      // Admin guruhidagi xabarni yangilash (tasdiqlanganligini ko'rsatish)
      try {
        const origCaption = ctx.callbackQuery.message.caption || '';
        const updatedCaption = `${origCaption}\n\n━━━━━━━━━━━━━━━━━━━━\n✅ <b>TO‘LOV TASDIQLANDI!</b> (${ticketsToApprove.length} ta taklifnoma)\n👨‍💼 <b>Admin:</b> ${adminName}\n⏰ <b>Vaqt:</b> ${new Date().toLocaleTimeString('uz-UZ', { timeZone: 'Asia/Tashkent' })}\n🚀 <i>Mijozga barcha taklifnoma havolalari yuborildi.</i>`;
        await ctx.editMessageCaption(updatedCaption, { parse_mode: 'HTML' });
      } catch (e) {
        console.warn('[Edit Admin Caption]:', e.message);
      }

      // Mijozning shaxsiy chatiga uning tanlagan dizayniga mos ravishda tayyor taklifnoma havolasini yuborish
      if (targetTgId) {
        if (ticketsToApprove.length === 1) {
          const ticket = ticketsToApprove[0];
          const inviteUrl = getInvitationUrl(ticket);
          const designDisplayName = getDesignDisplayName(ticket.design);

          const clientSuccessMsg = 
            `🎉 <b>Xushxabar! To'lovingiz tasdiqlandi!</b>\n\n` +
            `Hurmatli <b>${ticket.full_name}</b>!\n` +
            `Siz tanlagan <b>${designDisplayName}</b> dizaynidagi taklifnomangiz muvaffaqiyatli tasdiqlandi va tayyor bo'ldi.\n\n` +
            `🔗 <b>Sizning shaxsiy taklifnoma havolangiz:</b>\n` +
            `<code>${inviteUrl}</code>\n\n` +
            `Quyidagi tugmalar orqali taklifnomangizni ochishingiz va mehmonlaringizga yuborishingiz mumkin:`;

          const clientKeyboard = Markup.inlineKeyboard([
            [
              Markup.button.url("💌 Taklifnomani Ochish", inviteUrl),
              Markup.button.url("🌐 Brauzerda Ko'rish", inviteUrl)
            ],
            [
              Markup.button.url("✈️ Mehmonga Ulashish", `https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent(`Assalomu alaykum! Sizni to'yimizga taklif etamiz. Shaxsiy taklifnomangiz: `)}`)
            ]
          ]);

          await botInstance.telegram.sendMessage(targetTgId, clientSuccessMsg, {
            parse_mode: 'HTML',
            ...clientKeyboard
          });

          // Rasmiy taklifnoma chiptasi va QR kodni ham yuborish
          await sendTicketToUser(targetTgId, ticket);
        } else {
          // Bir nechta taklifnomalar tasdiqlandi!
          const primaryName = ticketsToApprove[0].full_name;
          let multiSuccessMsg = 
            `🎉 <b>Xushxabar! Barcha (${ticketsToApprove.length} ta) to'lovlaringiz tasdiqlandi!</b>\n\n` +
            `Hurmatli <b>${primaryName}</b>!\n` +
            `Siz yaratgan barcha <b>${ticketsToApprove.length} ta</b> taklifnoma muvaffaqiyatli tasdiqlandi va tayyor bo'ldi:\n\n`;

          const inlineButtons = [];

          ticketsToApprove.forEach((t, idx) => {
            const inviteUrl = getInvitationUrl(t);
            const designDisplayName = getDesignDisplayName(t.design);
            multiSuccessMsg += `${idx + 1}️⃣ <b>${t.full_name}</b> (${designDisplayName}):\n🔗 <code>${inviteUrl}</code>\n\n`;

            inlineButtons.push([
              Markup.button.url(`💌 ${idx + 1}. Taklifnomani Ochish`, inviteUrl),
              Markup.button.url(`🌐 Brauzerda`, inviteUrl)
            ]);
          });

          inlineButtons.push([
            Markup.button.callback("✨ Yangi Taklifnoma Yaratish", "create_new_invite"),
            Markup.button.webApp("📱 Mini App", `${WEBAPP_URL}/index.html?v=${BUILD_VERSION}`)
          ]);

          await botInstance.telegram.sendMessage(targetTgId, multiSuccessMsg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(inlineButtons)
          });

          // Har bir tasdiqlangan chipta uchun VIP QR kodli chiptani yuborish
          for (const t of ticketsToApprove) {
            await sendTicketToUser(targetTgId, t);
          }
        }
        console.log(`[Approved] Successfully delivered ${ticketsToApprove.length} invitations to user ${targetTgId}`);
      }
    } catch (err) {
      console.error('[Approve Payment Error]:', err);
      ctx.reply(`❌ Xatolik: ${err.message}`).catch(() => {});
    }
  });

  // Text message handler: handles wizard steps or AI assistant
  botInstance.on('text', async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (!text || text.startsWith('/')) return; // ignore slash commands

    const userId = String(ctx.from.id);
    const state = userWizardStates.get(userId);
    const lowerText = text.toLowerCase();

    // 1. Agar foydalanuvchi "atmen", "atemn", "bekor", "ochir", "o'chir" deb yozsa:
    const isCancelRequest = lowerText.includes('atmen') || 
                            lowerText.includes('atemn') || 
                            lowerText.includes('otmen') || 
                            lowerText.includes('bekor') || 
                            lowerText.includes('ochir') || 
                            lowerText.includes("o'chir") || 
                            lowerText.includes('cancel');

    if (isCancelRequest) {
      userWizardStates.delete(userId);
      const unpaidList = db.getUnpaidParticipantsByTelegramId(userId);

      if (!unpaidList || unpaidList.length === 0) {
        return ctx.replyWithHTML(
          `✨ Sizda bekor qilish uchun to'lanmagan taklifnoma yo'q.\n\nYangi taklifnoma yaratish uchun quyidagi tugmani bosing:`,
          getDesignSelectionKeyboard()
        );
      }

      const totalSum = unpaidList.reduce((sum, t) => sum + (t.total_price || 2000), 0);

      userWizardStates.set(userId, { step: 'waiting_cancel_indices' });

      let prompt = `🧾 <b>Sizda ${unpaidList.length} ta to'lanmagan taklifnoma mavjud!</b>\n` +
        `💰 <b>Umumiy to'lov summasi: ${totalSum.toLocaleString('uz-UZ')} so'm</b>\n\n` +
        `🗑️ <b>Qaysi taklifnomalarni bekor qilmoqchisiz?</b>\n\n`;
      unpaidList.forEach((t, idx) => {
        prompt += `${idx + 1}. <b>${t.full_name}</b> (<code>${t.unique_ticket_id}</code>, ${getDesignDisplayName(t.design)}) — ${(t.total_price || 2000).toLocaleString('uz-UZ')} so'm\n`;
      });
      prompt += `\nBekor qilish uchun:\n` +
        `• <b>Pastdagi "❌ 1-sini bekor qilish" tugmasini bosing</b>\n` +
        `• Yoki raqamini yozing (masalan: <code>2</code> yoki <code>1, 3</code>)\n` +
        `• Hammasini o'chirish uchun: <code>hammasi</code> deb yozing:`;

      const cancelButtons = [];
      for (let i = 0; i < unpaidList.length; i += 2) {
        const row = [];
        row.push(Markup.button.callback(`❌ ${i + 1}-sini bekor qilish`, `cancel_ticket:${unpaidList[i].unique_ticket_id.replace('#', '')}`));
        if (i + 1 < unpaidList.length) {
          row.push(Markup.button.callback(`❌ ${i + 2}-sini bekor qilish`, `cancel_ticket:${unpaidList[i + 1].unique_ticket_id.replace('#', '')}`));
        }
        cancelButtons.push(row);
      }
      cancelButtons.push([
        Markup.button.callback("🗑️ Barchasini bekor qilish", "cancel_all_unpaid"),
        Markup.button.callback("❌ Chiqish", "cancel_index_input")
      ]);

      return ctx.replyWithHTML(prompt, Markup.inlineKeyboard(cancelButtons));
    }

    // 2. Pastki doimiy menyu tugmalari
    if (lowerText.includes('taklifnoma yaratish') || lowerText.includes('yangi taklifnoma')) {
      userWizardStates.delete(userId);
      return sendDesignSelection(ctx);
    }

    if (lowerText.includes('mening taklifnomalarim') || lowerText.includes('chiptalarim')) {
      const paidList = db.getPaidParticipantsByTelegramId(userId);
      const unpaidList = db.getUnpaidParticipantsByTelegramId(userId);
      if (paidList.length === 0 && unpaidList.length === 0) {
        return ctx.replyWithHTML("Sizda hali taklifnomalar yo'q. Yangi taklifnoma yaratish uchun dizayn tanlang:", getDesignSelectionKeyboard());
      }
      let myText = `📋 <b>Sizning taklifnomalaringiz:</b>\n\n`;
      if (unpaidList.length > 0) {
        myText += `⏳ <b>To'lanmagan (${unpaidList.length} ta):</b>\n`;
        unpaidList.forEach((t, i) => myText += `${i + 1}. ${t.full_name} (${t.unique_ticket_id})\n`);
        myText += `\n`;
      }
      if (paidList.length > 0) {
        myText += `✅ <b>Tasdiqlangan (${paidList.length} ta):</b>\n`;
        paidList.forEach((t, i) => myText += `${i + 1}. ${t.full_name} (${t.unique_ticket_id})\n🔗 ${getInvitationUrl(t)}\n\n`);
      }
      return ctx.replyWithHTML(myText, Markup.inlineKeyboard([
        [Markup.button.callback("❌ To'lanmaganlarni bekor qilish", "cancel_by_number_prompt")],
        [Markup.button.callback("✨ Yangi Taklifnoma", "create_new_invite")]
      ]));
    }

    if (lowerText.includes("bog'lanish") || lowerText.includes("boglanish") || lowerText.includes("yordam")) {
      return ctx.replyWithHTML(
        `📞 <b>Aloqa va Yordam:</b>\n\n` +
        `• Telefon: +998(94)912-56-51\n` +
        `• Telegram: @nuri1ddin\n` +
        `• Bot: @VisoloqshomiBot\n\n` +
        `<i>Taklifnoma buyurtma qilish va savollaringiz bo'yicha bog'lanishingiz mumkin.</i>`,
        Markup.inlineKeyboard([[Markup.button.url("👤 Telegram: @nuri1ddin", "https://t.me/nuri1ddin")]])
      );
    }

    // Agar foydalanuvchi taklifnoma yaratish yoki bekor qilish bosqichida bo'lsa
    if (state) {
      // 0. Qaysi taklifnomalarni bekor qilish so'ralgan holat
      if (state.step === 'waiting_cancel_indices') {
        const cleanText = text.toLowerCase().trim();
        const unpaidList = db.getUnpaidParticipantsByTelegramId(userId);

        if (!unpaidList || unpaidList.length === 0) {
          userWizardStates.delete(userId);
          const view = buildUnpaidOrderDetails(userId, ctx.from.first_name);
          return ctx.replyWithHTML(view.text, view.keyboard);
        }

        const oldSum = unpaidList.reduce((sum, t) => sum + (t.total_price || 2000), 0);
        const oldCount = unpaidList.length;

        if (cleanText === 'hammasi' || cleanText === 'barchasi' || cleanText === 'all') {
          db.deleteAllUnpaidParticipants(userId);
          userWizardStates.delete(userId);
          const confirmMsg = `🗑️ <b>Barcha to'lanmagan taklifnomalaringiz (${oldCount} ta — ${oldSum.toLocaleString('uz-UZ')} so'm) bekor qilindi!</b>\n\n` +
            `To'lov summasi: <b>0 so'm</b> bo'ldi.\n\n` +
            `Yangi taklifnoma yaratish uchun dizayn tanlang:`;
          return ctx.replyWithHTML(confirmMsg, getDesignSelectionKeyboard());
        }

        // Matndan barcha raqamlarni ajratib olish (masalan: "2" yoki "1, 3" yoki "2 4 5")
        const matches = text.match(/\d+/g);
        if (!matches || matches.length === 0) {
          return ctx.replyWithHTML(
            `⚠️ Iltimos, bekor qilmoqchi bo'lgan taklifnoma raqamini yozing (masalan: <code>2</code> yoki <code>1, 3</code>):`,
            Markup.inlineKeyboard([[Markup.button.callback("❌ Chiqish", "cancel_index_input")]])
          );
        }

        const numbers = matches.map(m => parseInt(m, 10)).filter(n => n >= 1 && n <= unpaidList.length);
        if (numbers.length === 0) {
          return ctx.replyWithHTML(
            `⚠️ Noto'g'ri raqam kiritildi. Ro'yxatdagi 1 dan ${unpaidList.length} gacha bo'lgan raqamni kiriting:`,
            Markup.inlineKeyboard([[Markup.button.callback("❌ Chiqish", "cancel_index_input")]])
          );
        }

        const uniqueIndices = [...new Set(numbers)];
        const ticketsToDelete = uniqueIndices.map(idx => unpaidList[idx - 1]).filter(Boolean);

        for (const t of ticketsToDelete) {
          db.deleteParticipantByTicketId(t.unique_ticket_id);
        }

        userWizardStates.delete(userId);

        const afterList = db.getUnpaidParticipantsByTelegramId(userId);
        const newCount = afterList.length;
        const newSum = afterList.reduce((sum, t) => sum + (t.total_price || 2000), 0);

        const deletedListText = ticketsToDelete.map((t, i) => `${i + 1}. <b>${t.full_name}</b> (<code>${t.unique_ticket_id}</code>)`).join('\n');
        
        let confirmMsg = `✅ <b>${ticketsToDelete.length} ta taklifnoma bekor qilindi:</b>\n\n${deletedListText}\n\n`;
        if (newCount > 0) {
          confirmMsg += `📊 <b>Hisob-kitob yangilandi:</b>\n` +
            `• Oldin: <b>${oldCount} ta</b> taklifnoma (${oldSum.toLocaleString('uz-UZ')} so'm)\n` +
            `• <b>Hozir: ${newCount} ta taklifnoma qoldi (${newSum.toLocaleString('uz-UZ')} so'm bo'ldi)</b>\n\n` +
            `💰 <b>To'lov uchun yangi summa: ${newSum.toLocaleString('uz-UZ')} so'm</b>\n` +
            `💳 Karta: <code>5614 6814 2617 2270</code> (Uzcard)\n` +
            `👤 Karta egasi: <b>Nosirov Nuriddin</b>`;
        } else {
          confirmMsg += `✨ <b>Barcha to'lanmagan taklifnomalaringiz bekor qilindi!</b>\n` +
            `To'lov summasi: <b>0 so'm</b> bo'ldi.`;
        }

        const view = buildUnpaidOrderDetails(userId, ctx.from.first_name);
        return ctx.replyWithHTML(confirmMsg, newCount > 0 ? view.keyboard : getDesignSelectionKeyboard());
      }

      const s = getSettings();

      // Step 1: Ism-familiya kiritildi
      if (state.step === 'waiting_fullname') {
        state.data.full_name = text;
        state.step = 'waiting_couple';

        const promptText = `Rahmat, <b>${text}</b>!\n\n` +
          `2️⃣ <b>Kelin va kuyov ismlarini</b> kiriting:\n` +
          `<i>(Masalan: Farrux va Sevara)</i>`;

        return ctx.replyWithHTML(promptText, Markup.inlineKeyboard([
          [Markup.button.callback(`⏭️ Standart qoldirish (${s.groom_name} va ${s.bride_name})`, "skip_couple")],
          [Markup.button.callback("🔙 Yaratishni to'xtatish", "cancel_wizard")]
        ]));
      }

      // Step 2: Kelin-kuyov kiritildi
      if (state.step === 'waiting_couple') {
        state.data.couple_names = text;
        state.step = 'waiting_family';

        const promptText = `3️⃣ <b>Taklif etuvchilar / Oila nomini</b> kiriting:\n` +
          `<i>(Taklifnoma so'ngida «Hurmat va ehtirom ila...» qatorida chiqadi, masalan: Saidovlar oilasi yoki To'y egalari)</i>`;

        return ctx.replyWithHTML(promptText, Markup.inlineKeyboard([
          [Markup.button.callback(`⏭️ Standart qoldirish (${s.family_names || "To'y egalari"})`, "skip_family")],
          [Markup.button.callback("🔙 Yaratishni to'xtatish", "cancel_wizard")]
        ]));
      }

      // Step 3: Taklif etuvchilar / Oila nomi kiritildi
      if (state.step === 'waiting_family') {
        state.data.family_names = text;
        state.step = 'waiting_date';

        const promptText = `4️⃣ <b>To'y sanasi va vaqtini</b> kiriting:\n` +
          `<i>(Masalan: 2026-11-20 18:00)</i>`;

        return ctx.replyWithHTML(promptText, Markup.inlineKeyboard([
          [Markup.button.callback("⏭️ Standart sanani qoldirish", "skip_date")],
          [Markup.button.callback("🔙 Yaratishni to'xtatish", "cancel_wizard")]
        ]));
      }

      // Step 3: Sana kiritildi
      if (state.step === 'waiting_date') {
        state.data.event_date_time = text;
        state.step = 'waiting_venue';

        const promptText = `4️⃣ <b>To'yxona nomi va manzilini</b> kiriting:\n` +
          `<i>(Masalan: "Yulduzlar Qasri", Toshkent shahri)</i>`;

        return ctx.replyWithHTML(promptText, Markup.inlineKeyboard([
          [Markup.button.callback("⏭️ Standart manzilni qoldirish", "skip_venue")],
          [Markup.button.callback("🔙 Yaratishni to'xtatish", "cancel_wizard")]
        ]));
      }

      // Step 4: To'yxona kiritildi
      if (state.step === 'waiting_venue') {
        state.data.venue_name = text;
        state.step = 'waiting_phone';

        const promptText = `5️⃣ <b>Bog'lanish uchun telefon raqamingizni</b> kiriting:\n` +
          `<i>(Masalan: +998901234567)</i>`;

        return ctx.replyWithHTML(promptText, Markup.inlineKeyboard([
          [Markup.button.callback("🔙 Yaratishni to'xtatish", "cancel_wizard")]
        ]));
      }

      // Step 5: Telefon raqam kiritildi -> Nechta taklifnoma ekanini so'rash
      if (state.step === 'waiting_phone') {
        state.data.phone = text;
        state.step = 'waiting_quantity';

        const promptText = `6️⃣ <b>Nechta taklifnoma yasamoqchisiz?</b>\n\n` +
          `💰 <b>Donasi 2 000 so'mdan hisoblanadi.</b>\n\n` +
          `<i>(Iltimos, kerakli taklifnomalar sonini kiriting, masalan: 1, 5, 10, 50):</i>`;

        return ctx.replyWithHTML(promptText, Markup.inlineKeyboard([
          [Markup.button.callback("🔙 Yaratishni to'xtatish", "cancel_wizard")]
        ]));
      }

      // Step 6: Taklifnomalar soni kiritildi -> Narxni hisoblash va to'lov rekvizitlarini yuborish
      if (state.step === 'waiting_quantity') {
        const qty = parseInt(text, 10);
        if (isNaN(qty) || qty < 1) {
          return ctx.replyWithHTML(
            `⚠️ Iltimos, faqat musbat butun son kiriting (masalan: 1, 5, 10, 50):`
          );
        }

        state.data.quantity = qty;
        const pricePerUnit = 2000;
        const totalAmount = qty * pricePerUnit;
        const formattedAmount = totalAmount.toLocaleString('uz-UZ');

        // Yangi unikal chipta yaratish
        let uniqueTicketId = generateUniqueTicketId();
        let attempts = 0;
        while (db.getParticipantByTicketId(uniqueTicketId) && attempts < 10) {
          uniqueTicketId = generateUniqueTicketId();
          attempts++;
        }

        const ticketRecord = db.createParticipant({
          telegram_id: userId,
          full_name: state.data.full_name,
          guest_name: state.data.full_name,
          phone: state.data.phone,
          guests_count: 1,
          couple_names: state.data.couple_names || `${s.groom_name} va ${s.bride_name}`,
          groom_bride: state.data.couple_names || `${s.groom_name} va ${s.bride_name}`,
          venue_name: state.data.venue_name || s.venue_name,
          venue_address: state.data.venue_name || s.venue_address,
          event_date_time: state.data.event_date_time || `${s.day_number}-${s.month_name}, ${s.year} • ${s.event_time}`,
          event_date: state.data.event_date_time || s.event_date,
          event_type: state.data.event_type || 'Nikoh toʻyi',
          design: state.data.design,
          music: state.data.music || 'music1',
          family_names: state.data.family_names || s.family_names || "To'y egalari va xonadon ahillari",
          quantity: qty,
          total_price: totalAmount,
          payment_status: 'pending_payment',
          unique_ticket_id: uniqueTicketId,
          username: ctx.from.username || null
        });

        // Jarayon yakunlandi, stateni o'chiramiz
        userWizardStates.delete(userId);

        console.log(`[Bot Wizard] Created order: ${ticketRecord.full_name} (${ticketRecord.unique_ticket_id}), Design: ${ticketRecord.design}, Qty: ${qty}, Sum: ${totalAmount}`);

        // Oldingi to'lov xabari bo'lsa o'chirish
        const prevMsgId = userPaymentMessages.get(userId) || db.getLastPaymentMsgId(userId);
        if (prevMsgId) {
          botInstance.telegram.deleteMessage(userId, prevMsgId).catch(() => {});
        }

        // TALAB 2: Narxni avtomatik hisoblash va to'lov xabarini yuborish (tagida atmen tugmalari bilan)
        const unpaidView = buildUnpaidOrderDetails(userId, ctx.from.first_name);
        const sentMsg = await ctx.replyWithHTML(unpaidView.text, unpaidView.keyboard);
        if (sentMsg && sentMsg.message_id) {
          userPaymentMessages.set(userId, sentMsg.message_id);
          db.setPaymentMsgId(userId, sentMsg.message_id);
        }

        // Admin guruhiga bildirishnoma
        const adminChatId = ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
        if (adminChatId) {
          const adminOrderNotice = `🔔 <b>YANGI BUYURTMA QABUL QILINDI!</b>\n\n` +
            `👤 <b>Mijoz:</b> ${ticketRecord.full_name}\n` +
            `📞 <b>Telefon:</b> ${ticketRecord.phone}\n` +
            `🎨 <b>Dizayn:</b> <b>${getDesignDisplayName(ticketRecord.design)}</b>\n` +
            `💌 <b>Taklifnomalar soni:</b> ${qty} ta\n` +
            `💰 <b>Summa:</b> ${formattedAmount} so'm\n` +
            `🎫 <b>Chipta ID:</b> <code>${ticketRecord.unique_ticket_id}</code>\n` +
            `📱 <b>Telegram ID:</b> <code>${userId}</code>\n` +
            `⏳ <i>Mijoz to'lov chekini yuborishi kutilmoqda...</i>`;

          botInstance.telegram.sendMessage(adminChatId, adminOrderNotice, { parse_mode: 'HTML' }).catch(() => {});
        }

        return;
      }
    }

    // Wizard holatida bo'lmasa — Gemini AI savollarga javob beradi
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
    const inviteUrl = getInvitationUrl(ticket);
    const designDisplayName = getDesignDisplayName(ticket.design);

    // Generate QR Code Buffer
    const verificationUrl = inviteUrl;
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
    caption += `👨‍👩‍👧‍👦 <b>Taklif etuvchilar:</b> ${ticket.family_names || s.family_names}\n\n`;
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
      event_type, design, quantity, music, song, family_names, family
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
    const cleanDesign = design ? String(design).toLowerCase().trim() : 'visol';
    const cleanQuantity = Math.max(1, parseInt(quantity, 10) || 1);
    const cleanFamily = (family_names || family || '').trim() || null;

    // Requirement 1: Unique Entry Creation
    let uniqueTicketId = generateUniqueTicketId();
    let attempts = 0;
    while (db.getParticipantByTicketId(uniqueTicketId) && attempts < 10) {
      uniqueTicketId = generateUniqueTicketId();
      attempts++;
    }

    // Narx: har bitta taklifnoma donasi 2 000 so'mdan hisoblanadi
    const pricePerInvite = 2000;
    const totalAmount = cleanQuantity * pricePerInvite;
    const formattedAmount = totalAmount.toLocaleString('uz-UZ');

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
      event_type: cleanEventType,
      design: cleanDesign,
      quantity: cleanQuantity,
      music: (music || song || 'music1').toLowerCase().trim(),
      family_names: cleanFamily,
      payment_status: 'pending_payment',
      total_price: totalAmount
    });

    console.log(`[Registration] New order created: ${ticketRecord.full_name} (${ticketRecord.unique_ticket_id}), Design: ${cleanDesign}, Qty: ${cleanQuantity}, Total: ${totalAmount} UZS`);

    // Unpaid tickets for this user (including this newly registered one)
    const unpaidTickets = cleanTgId ? db.getUnpaidParticipantsByTelegramId(cleanTgId) : [ticketRecord];
    const totalUnpaidCount = unpaidTickets.length;
    const totalUnpaidAmount = unpaidTickets.reduce((sum, t) => sum + (t.total_price || pricePerInvite), 0);
    const formattedTotalAmount = totalUnpaidAmount.toLocaleString('uz-UZ');

    // 1. Narxni avtomatik hisoblash va bot orqali foydalanuvchiga to'lov ma'lumotlarini yuborish
    if (cleanTgId && bot && isBotActive) {
      // Oldingi yuborilgan to'lov so'rash xabarini o'chirish (agar mavjud bo'lsa)
      const prevMsgId = userPaymentMessages.get(String(cleanTgId)) || db.getLastPaymentMsgId(cleanTgId);
      if (prevMsgId) {
        bot.telegram.deleteMessage(cleanTgId, prevMsgId).catch((delErr) => {
          console.warn('[Delete Previous Payment Msg Warning]:', delErr.message);
        });
      }

      const unpaidView = buildUnpaidOrderDetails(cleanTgId, guestFullName);

      bot.telegram.sendMessage(cleanTgId, unpaidView.text, {
        parse_mode: 'HTML',
        ...unpaidView.keyboard
      })
        .then((sentMsg) => {
          if (sentMsg && sentMsg.message_id) {
            userPaymentMessages.set(String(cleanTgId), sentMsg.message_id);
            db.setPaymentMsgId(cleanTgId, sentMsg.message_id);
          }
        })
        .catch((e) => {
          console.warn('[Payment Message Warning]:', e.message);
        });
    }

    // Admin guruhiga yangi buyurtma haqida xabarnoma
    const adminChatId = ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;
    if (adminChatId && bot && isBotActive) {
      const adminOrderMsg = `🔔 <b>YANGI BUYURTMA KELIB TUSHDI!</b>\n\n` +
        `👤 <b>Mijoz:</b> ${ticketRecord.full_name}\n` +
        `📞 <b>Telefon:</b> ${ticketRecord.phone}\n` +
        `🎨 <b>Dizayn:</b> <b>${getDesignDisplayName(cleanDesign)}</b>\n` +
        `💌 <b>Taklifnomalar soni:</b> ${cleanQuantity} ta\n` +
        `💰 <b>To'lov summasi:</b> ${formattedTotalAmount} so'm\n` +
        `🎫 <b>Oxirgi chipta ID:</b> <code>${ticketRecord.unique_ticket_id}</code>\n` +
        `📱 <b>Telegram ID:</b> <code>${cleanTgId || 'Nomaʼlum'}</code>\n` +
        `⏳ <i>Mijoz chek yuborishi kutilmoqda...</i>`;

      bot.telegram.sendMessage(adminChatId, adminOrderMsg, { parse_mode: 'HTML' }).catch(() => {});
    }

    const inviteUrl = ticketRecord.payment_status === 'paid' ? getInvitationUrl(ticketRecord) : null;

    return res.status(200).json({
      success: true,
      payment_required: ticketRecord.payment_status !== 'paid',
      status: ticketRecord.payment_status || 'pending_payment',
      design: cleanDesign,
      design_name: getDesignDisplayName(cleanDesign),
      quantity: cleanQuantity,
      price_per_unit: pricePerInvite,
      total_price: totalAmount,
      formatted_amount: formattedAmount,
      total_unpaid_count: totalUnpaidCount,
      total_unpaid_price: totalUnpaidAmount,
      formatted_total_amount: formattedTotalAmount,
      card_number: "5614 6814 2617 2270",
      card_owner: "Nosirov Nuriddin",
      message: `To'lov uchun summa: ${formattedTotalAmount} so'm. Chek rasmini botga yuboring.`,
      ticket: {
        id: ticketRecord.id,
        unique_ticket_id: ticketRecord.unique_ticket_id,
        ticket_id: ticketRecord.unique_ticket_id,
        full_name: ticketRecord.full_name,
        guest_name: ticketRecord.full_name,
        couple_names: ticketRecord.couple_names,
        event_type: ticketRecord.event_type,
        event_date_time: ticketRecord.event_date_time,
        venue_name: ticketRecord.venue_name,
        venue_address: ticketRecord.venue_address,
        guests_count: ticketRecord.guests_count,
        design: ticketRecord.design,
        payment_status: ticketRecord.payment_status,
        total_price: ticketRecord.total_price
      },
      invitation: {
        id: ticketRecord.id,
        unique_ticket_id: ticketRecord.unique_ticket_id,
        ticket_id: ticketRecord.unique_ticket_id,
        full_name: ticketRecord.full_name,
        payment_status: ticketRecord.payment_status
      },
      ticket_id: ticketRecord.unique_ticket_id,
      invite_url: null // To'lov tasdiqlanmaguncha havola taqdim etilmaydi
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

  // To'lov holatini tekshirish: admin tasdiqlamagan bo'lsa kirish taqiqlanadi
  if (ticket.payment_status && ticket.payment_status !== 'paid') {
    return res.status(403).json({
      success: false,
      valid: false,
      payment_required: true,
      payment_status: ticket.payment_status,
      ticket_id: ticket.unique_ticket_id || ticket.ticket_id,
      error: "Ushbu taklifnoma to'lovi hali tasdiqlanmagan. Iltimos, to'lov chekini botga yuboring va admin tasdiqlashini kuting."
    });
  }

  const cleanTicketId = (ticket.unique_ticket_id || ticket.ticket_id || '').replace('#', '');
  const inviteUrl = getInvitationUrl(ticket);

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
    design: ticket.design || 'visol',
    design_name: getDesignDisplayName(ticket.design),
    quantity: ticket.quantity || 1,
    music: ticket.music || 'music1',
    song: ticket.music || 'music1',
    phone: ticket.phone,
    guests_count: ticket.guests_count,
    comment: ticket.comment,
    family: ticket.family_names || ticket.family || '',
    family_names: ticket.family_names || ticket.family || '',
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

  const safeTicket = { ...ticket };
  if (safeTicket.payment_status !== 'paid') {
    delete safeTicket.invite_url;
    safeTicket.invite_url = null;
  }

  return res.json({ success: true, ticket: safeTicket });
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
    const { id, full_name, phone, guests_count, comment, music, family_names, family } = req.body;
    if (!full_name || full_name.trim().length < 2) {
      return res.status(400).json({ success: false, error: "Ism va familiyani kiriting." });
    }
    if (!phone || phone.trim().length < 7) {
      return res.status(400).json({ success: false, error: "Telefon raqamini kiriting." });
    }

    const cleanFamily = (family_names || family || '').trim() || null;

    if (id) {
      // Update existing guest
      const updated = db.updateParticipant(id, { full_name, phone, guests_count, comment, music, family_names: cleanFamily });
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
        unique_ticket_id: uniqueTicketId,
        music: music || 'music1',
        family_names: cleanFamily
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
  // Start Express Server first
  server = app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`✨ VISOL OQSHOMI - TELEGRAM MINI APP SERVER IS LIVE!`);
    console.log(`🌐 Local Web App:     http://localhost:${PORT}`);
    if (WEBAPP_URL && WEBAPP_URL.startsWith('https://')) {
      console.log(`🚀 Public HTTPS URL:  ${WEBAPP_URL}`);
    }
    console.log(`📦 Database:          SQLite (${db.driver})`);
    console.log(`====================================================`);

    // Self-ping every 10 minutes to prevent Render free-tier idle spin down
    if (WEBAPP_URL && WEBAPP_URL.startsWith('https://')) {
      const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes
      setInterval(async () => {
        try {
          const pingUrl = `${WEBAPP_URL}/ping`;
          await fetch(pingUrl);
          console.log(`[Keep-Alive] Pinged ${pingUrl} at ${new Date().toLocaleTimeString()}`);
        } catch (err) {
          console.warn('[Keep-Alive] Ping warning:', err.message);
        }
      }, PING_INTERVAL);
    }
  });

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
      await updateChatMenuButton(null, "Taklif noma", `${WEBAPP_URL}/index.html?v=${BUILD_VERSION}`);
      console.log(`[Telegram Bot] Chat Menu Button linked to: ${WEBAPP_URL}/index.html?v=${BUILD_VERSION}`);
    } catch (botErr) {
      console.warn('[Telegram Bot] Notice initializing bot with BOT_TOKEN:', botErr.message);
      isBotActive = false;
    }
  } else {
    console.log('[Telegram Bot] Notice: BOT_TOKEN is not configured yet in .env');
  }
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
