# Bot Temp-Mail Telegram (Cloudflare Workers)

Bot Telegram untuk membuat alamat email sementara (*temp mail*), di mana seluruh email yang masuk langsung diteruskan ke chat Telegram secara *real-time* — lengkap dengan ekstraksi otomatis kode OTP / verifikasi, fitur 1-tap copy, tautan konfirmasi, pembersihan total tag HTML, dan penerusan lampiran file.

Berjalan di atas **Cloudflare Workers** (serverless) dan **Cloudflare KV**. Sangat cepat, hemat sumber daya, dan gratis untuk penggunaan pribadi maupun tim kecil tanpa perlu mengelola server.

[![Demo Bot Telegram](https://img.shields.io/badge/Demo%20Bot-@VexTempMail__bot-0088cc?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/VexTempMail_bot)

> 🤖 **Coba Sekarang:** Anda dapat langsung mencoba demo bot ini di Telegram: [@VexTempMail_bot](https://t.me/VexTempMail_bot)

---

## Fitur Utama

- **Fokus Kode OTP & Verifikasi**: Otomatis mendeteksi kode OTP (4–8 digit angka, format strip `123-456`, dsb) dan menyajikannya paling atas.
- **Salin Kode 1 Kali Ketuk (1-Tap Copy)**: Kode OTP diformat `<code>OTP</code>` sehingga cukup diketuk 1 kali di HP/PC untuk langsung menyalinnya, ditambah tombol instan `[ 📋 Salin: OTP ]` di keyboard (`copy_text`).
- **Deteksi Tautan Verifikasi Otomatis**: Otomatis mendeteksi tautan konfirmasi pendaftaran/aktivasi akun (`verify`, `confirm`, `token=`) dan menyediakan tombol sekali klik `[ 🔗 Buka Tautan Verifikasi ]`.
- **Pembersihan Total Tag HTML**: Seluruh tag HTML yang mengganggu, header MIME mentah, dan artefak quoted-printable dibersihkan 100% menjadi teks yang rapi dan mudah dibaca.
- **Alamat Kustom & Acak Natural**: Buat alamat dengan nama pilihan sendiri atau otomatis dibuatkan nama natural yang mudah dibaca (kombinasi kata & angka pendek).
- **Masa Aktif Fleksibel**: Pilihan durasi masa aktif alamat (6, 12, 24, 48, hingga 72 jam).
- **Multi-Domain**: Mendukung lebih dari satu domain email sekaligus.
- **Lampiran Lengkap**: PDF, dokumen Office, arsip ZIP, dan file lampiran lainnya otomatis diteruskan sebagai dokumen Telegram.
- **Riwayat & Navigasi Interaktif**: Antarmuka responsif berbasis tombol (*inline keyboard*) dengan paginasi riwayat email tanpa batas pemotongan teks.
- **Panel & Notifikasi Admin**: Notifikasi penggunaan real-time, ringkasan statistik bot (`/stats`), ubah QRIS donasi via chat (`/setqris`), serta manajemen domain (`/adddomain`, `/removedomain`).

---

## Prasyarat Sebelum Mulai

1. **Token Bot Telegram**:
   - Buka [@BotFather](https://t.me/BotFather) di Telegram.
   - Kirim perintah `/newbot`, ikuti petunjuk hingga mendapatkan token bot. Simpan token ini.
2. **Domain Aktif di Cloudflare**:
   - Pastikan DNS domain Anda sudah terhubung dan dikelola di Cloudflare.
   - Buka menu **Email** → **Email Routing** pada domain Anda di dashboard Cloudflare, lalu aktifkan layanannya.

---

## Pilihan Deployment

Pilih salah satu dari 3 cara pemasangan Worker di bawah ini:

### Opsi A: Tombol Deploy Otomatis (Paling Praktis untuk Awam)

Metode tercepat tanpa perlu install software apapun di komputer:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mhdhfzz/tempmail-bot)

1. Klik tombol di atas, lalu login ke Cloudflare.
2. Hubungkan akun GitHub Anda untuk mengonfirmasi deploy. Cloudflare akan otomatis membuat Worker baru di akun Anda.
3. Setelah deploy selesai, lanjut ke [Konfigurasi Setelah Deploy](#konfigurasi-setelah-deploy).

*(Catatan: Jika Anda ingin menggunakan repositori sendiri, fork repo ini terlebih dahulu lalu sesuaikan URL pada tombol di atas).*

---

### Opsi B: Manual via Cloudflare Dashboard (Tanpa GitHub)

1. Buka [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → Buat Worker baru (misal `tempmail-bot`).
2. Klik **Quick Edit**, hapus seluruh kode contoh yang ada, lalu tempel seluruh isi file [`tempmail-bot.js`](tempmail-bot.js).
3. Klik **Save and Deploy**, lalu lanjut ke [Konfigurasi Setelah Deploy](#konfigurasi-setelah-deploy).

---

### Opsi C: Menggunakan Wrangler CLI (Developer)

1. Buat KV Namespace di terminal:
   ```bash
   npx wrangler kv:namespace create TEMPMAIL_KV
   ```
2. Salin nilai `id` KV yang dihasilkan ke dalam file `wrangler.toml`, serta sesuaikan domain:
   ```toml
   [[kv_namespaces]]
   binding = "TEMPMAIL_KV"
   id = "PASTE_ID_KV_DISINI"

   [vars]
   TEMPMAIL_DOMAIN = "domainkamu.com"
   ADMIN_CHAT_ID = "123456789"
   ```
3. Simpan secrets dan deploy:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put WEBHOOK_SECRET
   npx wrangler deploy
   ```
4. Lanjutkan langsung ke [Langkah 3 & 4 pada Konfigurasi Setelah Deploy](#3-arahkan-email-domain-catch-all).

---

## Konfigurasi Setelah Deploy

*(Wajib diselesaikan setelah menjalankan Opsi A atau Opsi B)*

Buka [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → klik Worker bot Anda (`tempmail-bot`).

### 1. Hubungkan Database Penyimpanan (KV)
1. Masuk ke tab **Settings** → **Variables and Secrets** (atau **Bindings**).
2. Periksa bagian **KV Namespace Bindings**:
   - Jika sudah ada binding bernama `TEMPMAIL_KV`, lanjutkan ke langkah berikutnya.
   - Jika belum ada:
     1. Di menu sidebar kiri dashboard, klik **Workers & Pages** → **KV** → **Create a namespace**, beri nama `tempmail-kv`.
     2. Kembali ke Worker Anda → **Settings** → **Variables and Secrets** → **Add binding**.
     3. Variable name: `TEMPMAIL_KV` *(wajib sama persis)*.
     4. KV namespace: pilih `tempmail-kv` yang baru dibuat.
     5. Klik **Save and Deploy**.

### 2. Masukkan Variabel & Secret
Masih di tab **Settings** → **Variables and Secrets**, klik **Add** pada **Environment Variables**:

| Nama Variabel | Jenis | Deskripsi |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **Secret / Encrypted** | Token bot yang Anda peroleh dari @BotFather. |
| `TEMPMAIL_DOMAIN` | **Text / Plaintext** | Domain email Anda (contoh: `domain.com` atau `mail1.com,mail2.com`). |
| `ADMIN_CHAT_ID` | **Text / Plaintext** *(opsional)* | ID Telegram Anda (cek via [@userinfobot](https://t.me/userinfobot)) untuk menerima laporan admin. |
| `WEBHOOK_SECRET` | **Secret / Encrypted** *(opsional)* | String acak bebas untuk memvalidasi keamanan request Telegram. |

Klik **Save and Deploy** untuk menerapkan perubahan.

### 3. Arahkan Email Domain (Catch-all)
Agar setiap email yang dikirim ke domain Anda diteruskan ke Worker bot:
1. Buka dashboard Cloudflare → pilih domain yang Anda gunakan.
2. Masuk ke menu **Email** → **Email Routing** → buka tab **Routing Rules**.
3. Pada baris **Catch-all address**, klik **Edit** (atau aktifkan):
   - **Action**: `Send to a Worker`
   - **Destination**: Pilih Worker bot Anda (`tempmail-bot`)
4. Klik **Save**.

### 4. Aktifkan Webhook Telegram
1. Salin alamat URL Worker Anda dari halaman overview Worker (contoh: `https://tempmail-bot.username.workers.dev`).
2. Buka URL aktivasi webhook berikut di browser (sesuaikan nilai di dalam tanda `<>`):
   ```
   https://api.telegram.org/bot<TOKEN_BOT_KAMU>/setWebhook?url=<URL_WORKER_KAMU>&secret_token=<WEBHOOK_SECRET_KAMU>
   ```
   *(Jika Anda tidak mengisi `WEBHOOK_SECRET`, hapus bagian `&secret_token=...`)*.
3. Jika browser menampilkan respon `{"ok":true,"result":true,"description":"Webhook was set"}`, bot Anda sudah aktif!

### 5. Atur Menu Perintah di BotFather (Opsional)
Agar daftar perintah otomatis muncul di Telegram:
1. Chat [@BotFather](https://t.me/BotFather), kirim `/setcommands`, lalu pilih bot Anda.
2. Tempel daftar berikut:
   ```
   new - Buat alamat email sementara baru
   list - Lihat semua alamat aktif kamu
   inbox - Lihat riwayat semua email yang pernah masuk
   delete - Hapus alamat tertentu
   deleteall - Hapus semua alamat sekaligus
   donasi - Dukung pengembangan bot ini
   help - Bantuan & cara pakai bot
   ```

---

## Daftar Perintah Bot

### Pengguna Umum
- `/start` atau `/help` — Buka menu utama / panduan bantuan bot.
- `/new` atau `/new <nama>` — Buat alamat email sementara baru (acak atau kustom).
- `/list` — Lihat seluruh alamat email yang sedang aktif.
- `/inbox` — Lihat riwayat semua email yang pernah masuk.
- `/delete <alamat>` — Hapus alamat email tertentu.
- `/deleteall` — Hapus seluruh alamat email aktif milik Anda.
- `/donasi` — Tampilkan informasi donasi & QRIS.

### Khusus Admin (Sesuai `ADMIN_CHAT_ID`)
- **Notifikasi Real-Time**: Menerima pesan instan saat ada pengguna baru, pembuatan/penghapusan alamat, dan email masuk.
- `/stats` — Ringkasan metrik bot dalam tabel (total user, alamat aktif, email diteruskan).
- `/setqris` — Perbarui gambar QRIS donasi langsung via chat (cukup kirim foto setelah menjalankan perintah).
- `/domains` — Lihat daftar semua domain yang terhubung.
- `/adddomain <domain>` — Tambahkan domain baru tanpa perlu deploy ulang.
- `/removedomain <domain>` — Hapus domain dari daftar sistem.

---

## Detail Teknis

- **Ekstraksi OTP & Tautan Verifikasi**: Menggunakan pola regex cerdas dengan sistem deteksi berlapis (kata kunci konteks, format alfanumerik, format angka berdiri sendiri, serta penyaring *false positive* seperti tahun dan kode status).
- **Pembersihan HTML**: Menghapus seluruh tag HTML bersarang, skrip, dan gaya, serta mendekode *Quoted-Printable* dan entitas UTF-8 menjadi teks polos yang bersih.
- **Telegram 1-Tap Copy**: Memanfaatkan tag `<code>` bawaan Telegram yang mendukung salin 1 ketukan pada aplikasi Android, iOS, dan Desktop, didukung tombol interaktif `copy_text` Telegram Bot API 7.0+.
- **Penerusan File Dokumen**: File lampiran (PDF, arsip, gambar) diteruskan utuh menggunakan `sendDocument` ke chat pengguna.
