# ✨ Visol Oqshomi — Telegram Mini App & Shaxsiy Raqamli Taklifnoma Tizimi

Eksklyuziv **"Visol Oqshomi"** tantanali to'y kechasi va maxsus tadbirlar uchun ishlab chiqilgan zamonaviy **Telegram Mini App (Web App)**, **Shaxsiy Raqamli Taklifnoma (invite.html)** hamda **Node.js Express + Telegraf + SQLite** backend ilovasi.

---

## 🌟 Loyiha Arxitekturasi va Yangi Sahifalar

### 1. 📋 Ro'yxatdan O'tish Mini App (`public/index.html`):
- **Dizayn:** Hashamatli to'q ko'k navy (`#080c16` / `#0b0f19`) va qirollik tillarang aksentlari (`#d4af37`), nurli gradientlar.
- **Form maydonlari:**
  - `Ism va familiyangiz` (placeholder: "Masalan: Alisher Navoiy", Telegram hisobidan avtomatik to'ldirish)
  - `Telefon raqamingiz` (placeholder: "+998 90 123 45 67")
  - `Mehmonlar soni` (1 kishi, 2 kishi, 3 kishi, 4 kishi)
  - `Qo'shimcha izoh yoki tilak`
- **Tantanali tugma:** Katta tillarang gradientli "Ro'yxatdan o'tish va Taklifnoma olish" tugmasi.
- **Muvaffaqiyatli topshirish:**
  - Backendga POST so'rovi yuboriladi.
  - Noyob `#VO-2026-XXXX` chipta yaratiladi.
  - Ekranda rang-barang konfetti otiladi va shaxsiy taklifnoma havolasiga (`invite.html?ticket=VO-2026-XXXX`) o'tuvchi katta tugma paydo bo'ladi.

---

### 2. 💌 Shaxsiy Raqamli Taklifnoma Sahifasi (`public/invite.html`):
`https://e-visol-oqshomi.netlify.app/` uslubida yaratilgan, to'liq shaxsiylashtirilgan taklifnoma veb-sahifasi:
- **Muhrli Konvert (Wax Seal Envelope):**
  - Kirishda "Hurmatli [Mehmon Ismi]!" yozuvi bilan hashamatli konvert va aylanuvchi tilla mum muhr (wax seal).
  - Muhr bosilganda, konvert mayin ochilib, tilla barglar (petals burst) va sokin romantik to'y kuylari (audio musiqa) yangraydi.
- **Musiqa boshqaruvi (Audio player):**
  - Yuqori o'ng burchakda musiqani yoqish/o'chirish uchun disk shaklidagi aylanuvchi boshqaruv tugmasi.
- **Shaxsiy Ma'lumotlar:**
  - URL query parameter (`?ticket=VO-2026-XXXX`) orqali bazadan mehmonning to'liq ismi, taklif etilgan mehmonlar soni va chipta ID raqami avtomatik yuklanadi.
- **Jonli Countdown Taymer:**
  - 15-Noyabr, 2026-yil, soat 18:00 gacha qolgan kun, soat, daqiqa va soniyalarni hisoblaydi.
- **To'y Dasturi (Timeline):**
  - 18:00 — Welcome Reception & Skripka
  - 18:45 — Tantanali Kirib Kelish (Nikoh marosimi)
  - 19:30 — Kechki Ziyofat & Qutlovlar
  - 20:30 — Yoshlar Birinchi Valsi (Oq tuman sehri)
  - 22:30 — To'y Torti & Mushakbozlik
- **Dinamik QR-Kod:**
  - Mehmonning kirish chiptasini tekshirish uchun dinamik generatsiya qilinuvchi QR-kod.
- **Manzil & Dress-kod:**
  - "Yulduzlar Qasri" Grand Ball Hall (Yandex Xarita, Google Maps) va Black Tie libos qoidalari.
- **Rasm qilib yuklab olish:**
  - Chiptani yuqori tiniqlikdagi (High-Res PNG) rasm sifatida yuklab olish tugmasi.

---

### 3. ⚡ Backend va Telegram Bot (`server.js` + `database.js`):
- **Telegraf Telegram Boti:**
  - `/start` komandasi: Mehmonni kutib oladi va inline Web App tugmasi orqali Mini App-ni ochadi.
  - Agar mehmon allaqachon ro'yxatdan o'tgan bo'lsa, unga to'g'ridan-to'g'ri o'zining shaxsiy taklifnoma havolasini (`invite.html?ticket=...`) ko'rsatadi.
- **Tezkor Xabarnoma (Instant Bot Notification):**
  - Mehmon ro'yxatdan o'tishi bilanoq, bot uning shaxsiy Telegram lichkasiga QR-kodli rasmiy chiptani hamda uning shaxsiy raqamli taklifnoma havolasini yuboradi.
- **SQLite Saqlash:**
  - `data/database.sqlite` faylida xavfsiz saqlanadi (`id`, `telegram_id`, `full_name`, `phone`, `guests_count`, `comment`, `unique_ticket_id`, `created_at`).

---

## 📁 Loyiha Tuzilishi

```text
toyga taklif/
│
├── public/
│   ├── index.html          # Ro'yxatdan o'tish Telegram Mini App formasi
│   └── invite.html         # Shaxsiy Raqamli Taklifnoma sahifasi (Musiqa, Mum muhr, Dastur, QR-kod)
│
├── data/
│   └── database.sqlite     # SQLite ma'lumotlar bazasi
│
├── .env                    # Konfiguratsiya (Port, Bot Token, WebApp URL)
├── .env.example            # Konfiguratsiya shabloni
├── database.js             # SQLite boshqaruv moduli
├── package.json            # Loyiha sozlamalari
├── server.js               # Express + Telegraf bot serveri
└── README.md               # To'liq yo'riqnoma
```

---

## 🚀 Ishga Tushirish

Serverni ishga tushirish uchun terminalda:
```bash
npm start
```
yoki ishlab chiqish rejimida:
```bash
npm run dev
```

Konsolda quyidagi xabarni ko'rasiz:
```text
====================================================
✨ VISOL OQSHOMI - TELEGRAM MINI APP SERVER IS LIVE!
🌐 Local Web App:     http://localhost:3000
🚀 Public HTTPS URL:  https://sizning-domen.trycloudflare.com
📦 Database:          SQLite (node:sqlite)
🤖 Telegram Bot:      @VisoloqshomiBot (ACTIVE)
====================================================
```

---

## 🔗 Havolalar Formati

- **Ro'yxatdan o'tish formasi:** `https://your-domain.com/index.html`
- **Shaxsiy Taklifnoma:** `https://your-domain.com/invite.html?ticket=VO-2026-XXXX`
- **Chiptani tekshirish API:** `https://your-domain.com/api/ticket/VO-2026-XXXX`
