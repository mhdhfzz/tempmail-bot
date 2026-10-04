/**
 * Bot Telegram Temp-Mail (Cloudflare Workers)
 */

const ADDRESS_TTL_SECONDS = 24 * 60 * 60;
const DURATION_OPTIONS_HOURS = [6, 12, 24, 48, 72];
const MAX_ADDRESSES_PER_USER = 12;
const ADDR_PAGE_SIZE = 6;
const MAX_INBOX_HISTORY = 24;
const INBOX_PAGE_SIZE = 6;
const INBOX_TTL_SECONDS = 30 * 24 * 60 * 60;
const PENDING_TTL_SECONDS = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Track and store workerUrl in KV for Telegram WebApp buttons
    if (url.origin && !url.origin.includes('localhost') && !url.origin.includes('127.0.0.1')) {
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(env.TEMPMAIL_KV.put('config:workerUrl', url.origin));
      }
    }

    // Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // Mini App REST API Router
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env, ctx, url);
    }

    // Serve Mini App SPA (HTML/CSS/JS)
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/app' || url.pathname === '/miniapp')) {
      return renderMiniAppResponse(env);
    }

    if (request.method !== 'POST') {
      return new Response('Bot temp-mail aktif.', { status: 200 });
    }

    if (env.WEBHOOK_SECRET) {
      const token = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (token !== env.WEBHOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    ctx.waitUntil(routeUpdate(update, env));
    return new Response('OK', { status: 200 });
  },

  async email(message, env, ctx) {
    try {
      const to = (message.to || '').toLowerCase().trim();

      const mappingRaw = await env.TEMPMAIL_KV.get(`addr:${to}`);
      if (!mappingRaw) {
        if (typeof message.setReject === 'function') {
          message.setReject('Alamat email ini tidak terdaftar atau sudah kadaluarsa.');
        }
        return;
      }

      let mapping;
      try {
        mapping = JSON.parse(mappingRaw);
      } catch {
        return;
      }
      const chatId = mapping.chatId;

      const rawText = await new Response(message.raw).text();
      const parsed = parseRawEmail(rawText);

      const from = parsed.headers['from'] || message.from || '(tidak diketahui)';
      const subject = parsed.headers['subject'] || '(tanpa subjek)';

      // 1. Ekstrak isi teks email murni tanpa tag HTML
      const cleanText = cleanEmailBody(parsed);

      // 2. Ekstrak kode OTP / verifikasi dan tautan konfirmasi
      const { primaryOtp, allOtps, verificationLink } = extractOtpAndLinks(cleanText, subject);

      // 3. Susun header dan info OTP
      let headerHtml =
        `📧 <b>Email Baru Masuk</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `<b>Untuk:</b> <code>${escapeTelegramHtml(to)}</code>\n` +
        `<b>Dari:</b> ${escapeTelegramHtml(from)}\n` +
        `<b>Subjek:</b> <b>${escapeTelegramHtml(subject)}</b>` +
        (parsed.attachments.length ? `\n<b>Lampiran:</b> ${parsed.attachments.length} file` : '') +
        `\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;

      if (primaryOtp) {
        headerHtml +=
          `🔐 <b>KODE VERIFIKASI / OTP:</b>\n` +
          `👉 <code>${escapeTelegramHtml(primaryOtp)}</code>  <i>(Ketuk untuk menyalin)</i>\n`;
        if (allOtps.length > 1) {
          const otherOtps = allOtps.filter((c) => c !== primaryOtp);
          if (otherOtps.length) {
            headerHtml += `<i>Kode lain:</i> ${otherOtps.map((c) => `<code>${escapeTelegramHtml(c)}</code>`).join(', ')}\n`;
          }
        }
        headerHtml += '\n';
      }

      if (verificationLink) {
        headerHtml +=
          `🔗 <b>Tautan Verifikasi:</b>\n` +
          `<a href="${escapeHtmlAttr(verificationLink)}">${escapeTelegramHtml(truncateForButton(verificationLink, 50))}</a>\n\n`;
      }

      const workerUrl = await getWorkerUrl(env);
      const keyboard = emailActionsKeyboard(to, primaryOtp, verificationLink, workerUrl);

      // 4. Kirim teks bersih ke Telegram (pecah pesan jika sangat panjang)
      const bodyText = cleanText || (parsed.attachments.length ? '(Email ini hanya berisi lampiran, tanpa teks)' : '(tidak ada isi pesan)');
      const chunks = splitTextIntoChunks(bodyText, 2500);

      const firstMsgHtml = chunks.length > 1
        ? headerHtml + `📝 <b>Isi Pesan (Bagian 1/${chunks.length}):</b>\n\n${linkifyTelegramHtml(chunks[0])}`
        : headerHtml + `📝 <b>Isi Pesan:</b>\n\n${linkifyTelegramHtml(chunks[0])}`;

      await sendHtmlMessage(env, chatId, firstMsgHtml, keyboard);

      for (let i = 1; i < chunks.length; i++) {
        const partHtml = `<b>(Bagian ${i + 1}/${chunks.length})</b>\n\n${linkifyTelegramHtml(chunks[i])}`;
        await sendHtmlMessage(env, chatId, partHtml);
      }

      // 5. Kirim file lampiran jika ada
      for (const att of parsed.attachments) {
        await sendDocumentToTelegram(env, chatId, att.filename, att.mimeType, att.bytes);
      }

      // 6. Simpan ke riwayat KV
      const snippet = cleanText
        ? cleanText.length > 200
          ? cleanText.slice(0, 200) + '…'
          : cleanText
        : parsed.attachments.length
          ? '(Email ini hanya berisi lampiran, tanpa teks)'
          : '(tidak ada isi pesan)';

      const rawHtml = (parsed.textHtml || (/<[a-z!][\s\S]*>/i.test(parsed.textPlain) ? parsed.textPlain : '') || '').slice(0, 300000);

      await pushInboxEntry(env, chatId, {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        address: to,
        from,
        subject,
        snippet,
        cleanText,
        rawHtml,
        primaryOtp: primaryOtp || null,
        allOtps: allOtps || [],
        verificationLink: verificationLink || null,
        receivedAt: Date.now(),
        hasAttachment: parsed.attachments.length > 0,
      });

      await incrementCounter(env, 'stats:totalEmailsForwarded');
      await notifyAdmin(
        env,
        `📧 Email masuk ke <code>${escapeTelegramHtml(to)}</code> (pemilik: ${formatUserLink(null, chatId)})\n` +
        `Dari: ${escapeTelegramHtml(from)}\n` +
        `Subjek: ${escapeTelegramHtml(subject)}` +
        (primaryOtp ? `\nOTP: <code>${escapeTelegramHtml(primaryOtp)}</code>` : '')
      );
    } catch (err) {
      console.error('Gagal memproses email masuk:', err);
      await notifyAdmin(env, `⚠️ Error memproses email masuk: ${escapeTelegramHtml(err && err.message ? err.message : String(err))}`);
    }
  },
};

// --- Routing Update Telegram ---

async function routeUpdate(update, env) {
  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
    } else if (update.message) {
      await handleTelegramMessage(update.message, env);
    }
  } catch (err) {
    console.error('Gagal memproses update Telegram:', err);
    await notifyAdmin(env, `⚠️ Error memproses update Telegram: ${escapeTelegramHtml(err && err.message ? err.message : String(err))}`);
  }
}

// --- Message Handler ---

async function handleTelegramMessage(msg, env) {
  if (!msg.chat) return;
  const chatId = msg.chat.id;

  if (msg.photo && msg.photo.length) {
    await handleIncomingPhoto(msg, env, chatId);
    return;
  }

  if (!msg.text) return;
  const text = msg.text.trim();
  const firstName = (msg.from && msg.from.first_name) || '';

  await trackUserAndMaybeNotify(env, chatId, msg.from);

  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const arg = parts.slice(1).join(' ').trim();

  switch (command) {
    case '/start':
    case '/help':
    case '/menu': {
      const workerUrl = await getWorkerUrl(env);
      if (command === '/start' && workerUrl) {
        configureTelegramMenuButton(env, workerUrl).catch(() => { });
      }
      const isAdm = isAdmin(env, chatId);
      const view = command === '/help' ? viewHelp(workerUrl, isAdm) : viewMenu(firstName, '', workerUrl);
      await sendView(env, chatId, view);
      break;
    }

    case '/app':
    case '/miniapp': {
      const workerUrl = await getWorkerUrl(env);
      if (!workerUrl) {
        await sendPlainMessage(env, chatId, '⚠️ URL Mini App belum tersimpan. Jalankan /setupapp terlebih dahulu.');
        break;
      }
      const keyboard = {
        inline_keyboard: [
          [{ text: '📱 Buka Mini App Sekarang', web_app: { url: workerUrl } }]
        ]
      };
      await sendHtmlMessage(
        env,
        chatId,
        `📱 <b>VexTempMail Mini App</b>\n\n` +
        `Ketuk tombol di bawah untuk membuka Mini App langsung di Telegram:`,
        keyboard
      );
      break;
    }

    case '/setupapp': {
      if (env.ADMIN_CHAT_ID && !isAdmin(env, chatId)) {
        await sendPlainMessage(env, chatId, '⛔ Perintah ini hanya untuk admin (ADMIN_CHAT_ID).');
        break;
      }

      let workerUrl = (arg && /^https?:\/\//i.test(arg.trim())) ? arg.trim().replace(/\/+$/, '') : null;
      if (workerUrl) {
        await env.TEMPMAIL_KV.put('config:workerUrl', workerUrl);
      } else {
        workerUrl = await getWorkerUrl(env);
      }

      if (!workerUrl) {
        await sendHtmlMessage(
          env,
          chatId,
          '⚠️ URL Worker belum diketahui.\n\nKirim perintah dengan menyertakan URL Worker Anda:\n<code>/setupapp https://nama-worker.username.workers.dev</code>\n\natau buka Web App Anda di browser satu kali.'
        );
        break;
      }

      const success = await configureTelegramMenuButton(env, workerUrl);
      if (success) {
        await sendHtmlMessage(
          env,
          chatId,
          `✅ <b>Tombol Menu Mini App Berhasil Diaktifkan!</b>\n\n` +
          `URL: <code>${escapeTelegramHtml(workerUrl)}</code>\n\n` +
          `Tombol Menu di pojok kiri bawah chat sekarang sudah terhubung ke Mini App Anda.`
        );
      } else {
        await sendPlainMessage(env, chatId, '⚠️ Gagal mengatur tombol Menu Mini App ke Telegram API. Pastikan TELEGRAM_BOT_TOKEN valid.');
      }
      break;
    }

    case '/new':
    case '/newmail': {
      if (!env.TEMPMAIL_DOMAIN) {
        await sendPlainMessage(env, chatId, '⚠️ Bot belum dikonfigurasi (TEMPMAIL_DOMAIN kosong). Hubungi admin.');
        break;
      }

      const current = await getUserAddresses(env, chatId);
      if (current.length >= MAX_ADDRESSES_PER_USER) {
        await sendPlainMessage(
          env,
          chatId,
          `⚠️ Kamu sudah punya ${MAX_ADDRESSES_PER_USER} alamat aktif (maksimal). Hapus salah satu dulu lewat /list.`
        );
        break;
      }

      let alias = null;
      if (arg) {
        alias = sanitizeAlias(arg);
        if (!alias) {
          await sendPlainMessage(
            env,
            chatId,
            '⚠️ Nama alamat tidak valid. Gunakan huruf kecil/angka/titik/strip, 3-20 karakter. Contoh: /new tokosaya'
          );
          break;
        }
      }

      const domains = await getDomainList(env);
      await setPending(env, chatId, { alias, domain: domains.length === 1 ? domains[0] : null });
      if (domains.length > 1) {
        await sendView(env, chatId, viewChooseDomain(alias, domains));
      } else {
        await sendView(env, chatId, viewChooseDuration(alias, domains[0]));
      }
      break;
    }

    case '/list':
    case '/email':
    case '/mine':
      await sendView(env, chatId, viewAddressList(await getUserAddresses(env, chatId), 0));
      break;

    case '/inbox':
    case '/history':
      await sendView(env, chatId, viewInboxList(await getInbox(env, chatId), 0));
      break;

    case '/delete':
    case '/stop': {
      if (arg) {
        const ok = await deleteAddress(env, chatId, arg.toLowerCase());
        await sendPlainMessage(env, chatId, ok ? `🗑️ Alamat ${arg} sudah dihapus.` : 'Alamat tidak ditemukan / bukan milikmu.');
      } else {
        const addresses = await getUserAddresses(env, chatId);
        if (addresses.length === 0) {
          await sendPlainMessage(env, chatId, 'Kamu tidak punya alamat aktif.');
        } else {
          await sendView(env, chatId, viewAddressList(addresses, 0));
        }
      }
      break;
    }

    case '/deleteall':
      await sendView(env, chatId, viewConfirmDeleteAll());
      break;

    case '/donasi':
    case '/donate':
      await sendDonationImage(env, chatId);
      await notifyAdmin(env, `💝 Donasi dibuka oleh ${formatUserLink(msg.from, chatId)}`);
      break;

    case '/adddomain': {
      if (!isAdmin(env, chatId)) {
        await sendView(env, chatId, viewMenu(firstName, 'Perintah tidak dikenali. Pakai tombol di bawah ya 👇'));
        break;
      }
      const newDomain = sanitizeDomain(arg);
      if (!newDomain) {
        await sendPlainMessage(env, chatId, '⚠️ Format domain tidak valid. Contoh: /adddomain mail2.com');
        break;
      }
      const added = await addExtraDomain(env, newDomain);
      await sendPlainMessage(
        env,
        chatId,
        added
          ? `✅ Domain "${newDomain}" ditambahkan. Pastikan Email Routing (catch-all ke Worker ini) sudah aktif untuk domain ini di Cloudflare, kalau belum email ke domain ini tidak akan masuk.`
          : `Domain "${newDomain}" sudah ada di daftar.`
      );
      break;
    }

    case '/removedomain': {
      if (!isAdmin(env, chatId)) {
        await sendView(env, chatId, viewMenu(firstName, 'Perintah tidak dikenali. Pakai tombol di bawah ya 👇'));
        break;
      }
      const targetDomain = sanitizeDomain(arg);
      if (!targetDomain) {
        await sendPlainMessage(env, chatId, '⚠️ Format domain tidak valid. Contoh: /removedomain mail2.com');
        break;
      }
      const removed = await removeExtraDomain(env, targetDomain);
      await sendPlainMessage(
        env,
        chatId,
        removed
          ? `🗑️ Domain "${targetDomain}" dihapus dari daftar tambahan.`
          : `Domain "${targetDomain}" tidak ditemukan di daftar tambahan (kalau domain itu diset lewat TEMPMAIL_DOMAIN, hapus manual dari sana).`
      );
      break;
    }

    case '/domains': {
      if (!isAdmin(env, chatId)) {
        await sendView(env, chatId, viewMenu(firstName, 'Perintah tidak dikenali. Pakai tombol di bawah ya 👇'));
        break;
      }
      const allDomains = await getDomainList(env);
      const text =
        allDomains.length === 0
          ? '⚠️ Belum ada domain yang dikonfigurasi sama sekali.'
          : `🌐 Domain aktif saat ini:\n\n${allDomains.map((d) => `• ${d}`).join('\n')}`;
      await sendPlainMessage(env, chatId, text);
      break;
    }

    case '/setqris': {
      if (!isAdmin(env, chatId)) {
        await sendView(env, chatId, viewMenu(firstName, 'Perintah tidak dikenali. Pakai tombol di bawah ya 👇'));
        break;
      }
      await env.TEMPMAIL_KV.put(`pendingqris:${chatId}`, '1', { expirationTtl: 300 });
      await sendPlainMessage(
        env,
        chatId,
        '🖼️ Oke, sekarang kirim gambar QRIS-nya (kirim sebagai foto biasa, jangan sebagai file/dokumen). Berlaku 5 menit.'
      );
      break;
    }

    case '/stats': {
      if (!isAdmin(env, chatId)) {
        await sendView(env, chatId, viewMenu(firstName, 'Perintah tidak dikenali. Pakai tombol di bawah ya 👇'));
        break;
      }
      const totalUsers = await getCounter(env, 'stats:totalUsers');
      const totalCreated = await getCounter(env, 'stats:totalAddressesCreated');
      const totalEmails = await getCounter(env, 'stats:totalEmailsForwarded');
      const activeInfo = await getActiveAddressCount(env);
      const activeLabel = activeInfo.count === null ? 'tidak diketahui' : `${activeInfo.count}${activeInfo.complete ? '' : '+'}`;
      await sendView(env, chatId, viewAdminStats(totalUsers, totalCreated, activeLabel, totalEmails));
      break;
    }

    case '/admin':
    case '/adminhelp': {
      if (!isAdmin(env, chatId)) {
        await sendView(env, chatId, viewMenu(firstName, 'Perintah tidak dikenali. Pakai tombol di bawah ya 👇'));
        break;
      }
      await sendView(env, chatId, viewAdminHelp());
      break;
    }

    default:
      await sendView(env, chatId, viewMenu(firstName, 'Perintah tidak dikenali. Pakai tombol di bawah ya 👇'));
  }
}

// --- Callback Query Handler ---

async function handleIncomingPhoto(msg, env, chatId) {
  const pendingKey = `pendingqris:${chatId}`;
  const isPending = await env.TEMPMAIL_KV.get(pendingKey);
  if (!isPending || !isAdmin(env, chatId)) return;

  await env.TEMPMAIL_KV.delete(pendingKey);

  try {
    const largest = msg.photo[msg.photo.length - 1];
    const fileInfoRes = await tgApi(env, 'getFile', { file_id: largest.file_id });
    const fileInfo = await fileInfoRes.json();
    if (!fileInfo.ok) throw new Error('Gagal mengambil info file dari Telegram');

    const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`;
    const imageRes = await fetch(fileUrl);
    if (!imageRes.ok) throw new Error('Gagal mengunduh gambar dari Telegram');
    const bytes = await imageRes.arrayBuffer();

    await env.TEMPMAIL_KV.put('assets:qris', bytes);
    await sendPlainMessage(env, chatId, '✅ Gambar QRIS berhasil diperbarui! Tombol Donasi sekarang pakai gambar ini.');
    await notifyAdmin(env, `🖼️ QRIS diperbarui oleh ${formatUserLink(msg.from, chatId)}`);
  } catch (err) {
    console.error('Gagal memproses foto QRIS:', err);
    await sendPlainMessage(env, chatId, '⚠️ Gagal menyimpan gambar QRIS, coba kirim ulang.');
  }
}

async function handleCallbackQuery(query, env) {
  const chatId = query.message && query.message.chat ? query.message.chat.id : null;
  const messageId = query.message ? query.message.message_id : null;
  const data = query.data || '';
  const fromUser = query.from;
  if (!chatId || !messageId) return;

  const edit = (view) => editView(env, chatId, messageId, view);
  const workerUrl = await getWorkerUrl(env);

  try {
    if (data === 'm') {
      await answerCallback(env, query.id);
      await edit(viewMenu('', '', workerUrl));
      return;
    }

    if (data === 'help') {
      await answerCallback(env, query.id);
      const isAdm = isAdmin(env, chatId);
      await edit(viewHelp(workerUrl, isAdm));
      return;
    }

    if (data === 'admin_stats') {
      if (!isAdmin(env, chatId)) {
        await answerCallback(env, query.id, 'Akses khusus admin.', true);
        return;
      }
      await answerCallback(env, query.id);
      const totalUsers = await getCounter(env, 'stats:totalUsers');
      const totalCreated = await getCounter(env, 'stats:totalAddressesCreated');
      const totalEmails = await getCounter(env, 'stats:totalEmailsForwarded');
      const activeInfo = await getActiveAddressCount(env);
      const activeLabel = activeInfo.count === null ? 'tidak diketahui' : `${activeInfo.count}${activeInfo.complete ? '' : '+'}`;
      await edit(viewAdminStats(totalUsers, totalCreated, activeLabel, totalEmails));
      return;
    }

    if (data === 'admin_domains') {
      if (!isAdmin(env, chatId)) {
        await answerCallback(env, query.id, 'Akses khusus admin.', true);
        return;
      }
      await answerCallback(env, query.id);
      const allDomains = await getDomainList(env);
      const text =
        allDomains.length === 0
          ? '⚠️ Belum ada domain yang dikonfigurasi sama sekali.'
          : `🌐 <b>Domain aktif saat ini:</b>\n\n${allDomains.map((d) => `• <code>${escapeTelegramHtml(d)}</code>`).join('\n')}`;
      await edit({
        text,
        fallbackHtml: text,
        keyboard: {
          inline_keyboard: [
            [{ text: '🛠️ Kembali ke Panel Admin', callback_data: 'admin_help' }],
            [{ text: '⬅️ Menu Utama', callback_data: 'm' }],
          ],
        },
      });
      return;
    }

    if (data === 'admin_setqris') {
      if (!isAdmin(env, chatId)) {
        await answerCallback(env, query.id, 'Akses khusus admin.', true);
        return;
      }
      await answerCallback(env, query.id);
      await env.TEMPMAIL_KV.put(`pendingqris:${chatId}`, '1', { expirationTtl: 300 });
      await sendPlainMessage(
        env,
        chatId,
        '🖼️ Oke, sekarang kirim gambar QRIS-nya (kirim sebagai foto biasa, jangan sebagai file/dokumen). Berlaku 5 menit.'
      );
      return;
    }

    if (data === 'admin_setupapp') {
      if (!isAdmin(env, chatId)) {
        await answerCallback(env, query.id, 'Akses khusus admin.', true);
        return;
      }
      await answerCallback(env, query.id);
      const workerUrl = await getWorkerUrl(env);
      if (!workerUrl) {
        await sendHtmlMessage(
          env,
          chatId,
          '⚠️ URL Worker belum diketahui.\n\nKirim perintah dengan menyertakan URL Worker Anda:\n<code>/setupapp https://nama-worker.username.workers.dev</code>\n\natau buka Web App Anda di browser satu kali.'
        );
        return;
      }
      const success = await configureTelegramMenuButton(env, workerUrl);
      if (success) {
        await sendHtmlMessage(
          env,
          chatId,
          `✅ <b>Tombol Menu Mini App Berhasil Diaktifkan!</b>\n\n` +
          `URL: <code>${escapeTelegramHtml(workerUrl)}</code>\n\n` +
          `Tombol Menu di pojok kiri bawah chat sekarang sudah terhubung ke Mini App Anda.`
        );
      } else {
        await sendPlainMessage(env, chatId, '⚠️ Gagal mengatur tombol Menu Mini App ke Telegram API.');
      }
      return;
    }

    if (data === 'admin_help') {
      if (!isAdmin(env, chatId)) {
        await answerCallback(env, query.id, 'Akses khusus admin.', true);
        return;
      }
      await answerCallback(env, query.id);
      await edit(viewAdminHelp());
      return;
    }

    if (data === 'new') {
      if (!env.TEMPMAIL_DOMAIN) {
        await answerCallback(env, query.id, 'Bot belum dikonfigurasi (TEMPMAIL_DOMAIN kosong).', true);
        return;
      }
      const current = await getUserAddresses(env, chatId);
      if (current.length >= MAX_ADDRESSES_PER_USER) {
        await answerCallback(env, query.id, `Maksimal ${MAX_ADDRESSES_PER_USER} alamat aktif. Hapus salah satu dulu.`, true);
        return;
      }
      const domains = await getDomainList(env);
      await setPending(env, chatId, { alias: null, domain: domains.length === 1 ? domains[0] : null });
      await answerCallback(env, query.id);
      if (domains.length > 1) {
        await edit(viewChooseDomain(null, domains));
      } else {
        await edit(viewChooseDuration(null, domains[0]));
      }
      return;
    }

    if (data.startsWith('newdom:')) {
      const domains = await getDomainList(env);
      const idx = parseInt(data.slice(7), 10);
      const domain = domains[idx];
      if (!domain) {
        await answerCallback(env, query.id, 'Domain tidak valid.', true);
        return;
      }
      const pending = (await getPending(env, chatId)) || { alias: null };
      pending.domain = domain;
      await setPending(env, chatId, pending);
      await answerCallback(env, query.id);
      await edit(viewChooseDuration(pending.alias, domain));
      return;
    }

    if (data.startsWith('newdur:')) {
      const hours = parseInt(data.slice(7), 10);
      if (!DURATION_OPTIONS_HOURS.includes(hours)) {
        await answerCallback(env, query.id, 'Pilihan tidak valid.', true);
        return;
      }
      const pending = await getPending(env, chatId);
      const alias = pending ? pending.alias : null;
      const domain = (pending && pending.domain) || (await getRandomDomain(env));
      await clearPending(env, chatId);

      const result = await createNewAddress(env, chatId, alias, hours * 3600, domain);
      if (result.error === 'limit') {
        await answerCallback(env, query.id, `Maksimal ${MAX_ADDRESSES_PER_USER} alamat aktif.`, true);
        await edit(viewMenu('', '', workerUrl));
        return;
      }
      if (result.error === 'taken') {
        await answerCallback(env, query.id, `Alamat "${alias}" baru saja dipakai orang lain. Coba lagi.`, true);
        await edit(viewMenu('', '', workerUrl));
        return;
      }

      const addresses = await getUserAddresses(env, chatId);
      const idx = addresses.findIndex((a) => a.address === result.address);
      await answerCallback(env, query.id, '✅ Alamat baru dibuat');
      await edit(viewAddressCreated(result.address, hours, idx));

      await incrementCounter(env, 'stats:totalAddressesCreated');
      await notifyAdmin(
        env,
        `🆕 ${formatUserLink(fromUser, chatId)} buat alamat <code>${escapeTelegramHtml(result.address)}</code> (${hours} jam)`
      );
      return;
    }

    if (data.startsWith('l:')) {
      const page = parseInt(data.slice(2), 10) || 0;
      await answerCallback(env, query.id);
      await edit(viewAddressList(await getUserAddresses(env, chatId), page));
      return;
    }

    if (data.startsWith('i:')) {
      const page = parseInt(data.slice(2), 10) || 0;
      await answerCallback(env, query.id);
      await edit(viewInboxList(await getInbox(env, chatId), page));
      return;
    }

    if (data.startsWith('d:')) {
      const idx = parseInt(data.slice(2), 10);
      const addresses = await getUserAddresses(env, chatId);
      if (!addresses[idx]) {
        await answerCallback(env, query.id, 'Alamat tidak ditemukan / sudah kadaluarsa.', true);
        await edit(viewAddressList(addresses, 0));
        return;
      }
      await answerCallback(env, query.id);
      await edit(viewAddressDetail(addresses, idx));
      return;
    }

    if (data.startsWith('ext:')) {
      const idx = parseInt(data.slice(4), 10);
      const addresses = await getUserAddresses(env, chatId);
      const target = addresses[idx];
      if (!target) {
        await answerCallback(env, query.id, 'Alamat tidak ditemukan.', true);
        await edit(viewAddressList(addresses, 0));
        return;
      }
      const ok = await extendAddress(env, chatId, target.address);
      await answerCallback(env, query.id, ok ? '⏳ Masa berlaku diperpanjang' : 'Gagal memperpanjang', true);
      const refreshed = await getUserAddresses(env, chatId);
      const newIdx = refreshed.findIndex((a) => a.address === target.address);
      await edit(newIdx >= 0 ? viewAddressDetail(refreshed, newIdx) : viewAddressList(refreshed, 0));

      if (ok) {
        await notifyAdmin(
          env,
          `⏳ ${formatUserLink(fromUser, chatId)} perpanjang <code>${escapeTelegramHtml(target.address)}</code>`
        );
      }
      return;
    }

    if (data === 'extall') {
      const addresses = await getUserAddresses(env, chatId);
      await Promise.all(addresses.map((a) => extendAddress(env, chatId, a.address)));
      await answerCallback(env, query.id, '⏳ Semua alamat diperpanjang', true);
      await edit(viewAddressList(await getUserAddresses(env, chatId), 0));

      await notifyAdmin(
        env,
        `⏳ ${formatUserLink(fromUser, chatId)} perpanjang semua alamat (${addresses.length})`
      );
      return;
    }

    if (data.startsWith('delc:')) {
      const idx = parseInt(data.slice(5), 10);
      const addresses = await getUserAddresses(env, chatId);
      if (!addresses[idx]) {
        await answerCallback(env, query.id, 'Alamat tidak ditemukan.', true);
        await edit(viewAddressList(addresses, 0));
        return;
      }
      await answerCallback(env, query.id);
      await edit(viewConfirmDelete(addresses, idx));
      return;
    }

    if (data.startsWith('deldo:')) {
      const idx = parseInt(data.slice(6), 10);
      const addresses = await getUserAddresses(env, chatId);
      const target = addresses[idx];
      if (!target) {
        await answerCallback(env, query.id, 'Alamat tidak ditemukan.', true);
        await edit(viewAddressList(addresses, 0));
        return;
      }
      await deleteAddress(env, chatId, target.address);
      await answerCallback(env, query.id, '🗑️ Alamat dihapus', true);
      await edit(viewAddressList(await getUserAddresses(env, chatId), 0));

      await notifyAdmin(
        env,
        `🗑️ ${formatUserLink(fromUser, chatId)} hapus <code>${escapeTelegramHtml(target.address)}</code>`
      );
      return;
    }

    if (data === 'dela') {
      await answerCallback(env, query.id);
      await edit(viewConfirmDeleteAll());
      return;
    }

    if (data === 'delado') {
      const beforeCount = (await getUserAddresses(env, chatId)).length;
      await deleteAllAddresses(env, chatId);
      await answerCallback(env, query.id, '🗑️ Semua alamat dihapus', true);
      await edit(viewMenu('', '', workerUrl));

      await notifyAdmin(
        env,
        `🗑️ ${formatUserLink(fromUser, chatId)} hapus semua alamat (${beforeCount})`
      );
      return;
    }

    if (data === 'donasi') {
      await answerCallback(env, query.id);
      await sendDonationImage(env, chatId);
      await notifyAdmin(env, `💝 Donasi dibuka oleh ${formatUserLink(fromUser, chatId)}`);
      return;
    }

    if (data.startsWith('ai:')) {
      const [addrIdxStr, pageStr] = data.slice(3).split(':');
      const addrIdx = parseInt(addrIdxStr, 10);
      const page = parseInt(pageStr, 10) || 0;
      const addresses = await getUserAddresses(env, chatId);
      if (!addresses[addrIdx]) {
        await answerCallback(env, query.id, 'Alamat tidak ditemukan / sudah kadaluarsa.', true);
        await edit(viewAddressList(addresses, 0));
        return;
      }
      const inbox = await getInbox(env, chatId);
      await answerCallback(env, query.id);
      await edit(viewAddressInboxList(addresses, addrIdx, inbox, page));
      return;
    }

    if (data.startsWith('aid:')) {
      const [addrIdxStr, pageStr, fIdxStr, partStr] = data.slice(4).split(':');
      const addrIdx = parseInt(addrIdxStr, 10);
      const page = parseInt(pageStr, 10) || 0;
      const filteredIdx = parseInt(fIdxStr, 10);
      const part = parseInt(partStr, 10) || 0;
      const addresses = await getUserAddresses(env, chatId);
      if (!addresses[addrIdx]) {
        await answerCallback(env, query.id, 'Alamat tidak ditemukan / sudah kadaluarsa.', true);
        await edit(viewAddressList(addresses, 0));
        return;
      }
      const inbox = await getInbox(env, chatId);
      const filtered = inbox.filter((item) => item.address === addresses[addrIdx].address);
      if (!filtered[filteredIdx]) {
        await answerCallback(env, query.id, 'Email tidak ditemukan.', true);
        await edit(viewAddressInboxList(addresses, addrIdx, inbox, page));
        return;
      }
      await answerCallback(env, query.id);
      await edit(viewAddressInboxDetail(addresses, addrIdx, inbox, page, filteredIdx, part));
      return;
    }

    if (data.startsWith('ai_send_all:')) {
      const [addrIdxStr, fIdxStr] = data.slice(12).split(':');
      const addrIdx = parseInt(addrIdxStr, 10);
      const filteredIdx = parseInt(fIdxStr, 10);
      const addresses = await getUserAddresses(env, chatId);
      const addr = addresses[addrIdx];
      if (!addr) {
        await answerCallback(env, query.id, 'Alamat tidak ditemukan.', true);
        return;
      }
      const inbox = await getInbox(env, chatId);
      const filtered = inbox.filter((item) => item.address === addr.address);
      const item = filtered[filteredIdx];
      if (!item) {
        await answerCallback(env, query.id, 'Email tidak ditemukan.', true);
        return;
      }
      await answerCallback(env, query.id, '📨 Mengirim seluruh teks email ke chat...');
      await sendFullEmailToChat(env, chatId, item);
      return;
    }

    if (data.startsWith('inbox_detail:')) {
      const [idxStr, partStr] = data.slice(13).split(':');
      const idx = parseInt(idxStr, 10);
      const part = parseInt(partStr, 10) || 0;
      const inbox = await getInbox(env, chatId);
      if (!inbox[idx]) {
        await answerCallback(env, query.id, 'Riwayat tidak ditemukan.', true);
        await edit(viewInboxList(inbox, 0));
        return;
      }
      await answerCallback(env, query.id);
      await edit(viewInboxDetail(inbox, idx, part));
      return;
    }

    if (data.startsWith('inbox_send_all:')) {
      const idx = parseInt(data.slice(15), 10);
      const inbox = await getInbox(env, chatId);
      const item = inbox[idx];
      if (!item) {
        await answerCallback(env, query.id, 'Email tidak ditemukan.', true);
        return;
      }
      await answerCallback(env, query.id, '📨 Mengirim seluruh teks email ke chat...');
      await sendFullEmailToChat(env, chatId, item);
      return;
    }

    await answerCallback(env, query.id);
  } catch (err) {
    console.error('Gagal menangani callback:', err);
    await answerCallback(env, query.id, 'Terjadi kesalahan, coba lagi.', true);
  }
}

// --- Pending Wizard State ---

async function setPending(env, chatId, data) {
  await env.TEMPMAIL_KV.put(`pending:${chatId}`, JSON.stringify(data), { expirationTtl: PENDING_TTL_SECONDS });
}

async function getPending(env, chatId) {
  const raw = await env.TEMPMAIL_KV.get(`pending:${chatId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function clearPending(env, chatId) {
  await env.TEMPMAIL_KV.delete(`pending:${chatId}`);
}

// --- View Builders ---

function viewMenu(firstName = '', note = '', workerUrl = null) {
  const greeting = firstName ? `Halo, ${firstName} 👋` : 'Halo 👋';
  const desc = 'Buat alamat email sementara dan terima emailnya langsung di chat ini.';
  const blocks = [
    { type: 'section_heading', text: '📬 Bot Temp-Mail' },
  ];
  if (note) {
    blocks.push({ type: 'paragraph', text: note });
  }
  blocks.push({ type: 'paragraph', text: `${greeting}\n${desc}\n\nPilih menu di bawah:` });
  blocks.push({ type: 'divider' });

  const fallbackHtml =
    `📬 <b>Bot Temp-Mail</b>\n\n` +
    (note ? `<i>${escapeTelegramHtml(note)}</i>\n\n` : '') +
    `${escapeTelegramHtml(greeting)}\n\n` +
    `${escapeTelegramHtml(desc)}\n\n` +
    `Pilih menu di bawah:`;

  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: mainMenuKeyboard(workerUrl),
  };
}

function viewHelp(workerUrl = null, isAdm = false) {
  const blocks = [
    { type: 'section_heading', text: '❓ Panduan Penggunaan' },
    {
      type: 'list',
      items: [
        { text: '/new — Buat alamat baru (acak atau custom)' },
        { text: '/new <nama> — Buat alamat dengan nama sendiri' },
        { text: '/list — Lihat semua alamat aktif kamu' },
        { text: '/inbox — Lihat riwayat semua email yang pernah masuk' },
        { text: '/delete <alamat> — Hapus alamat tertentu' },
        { text: '/deleteall — Hapus semua alamat sekaligus' },
        { text: '/donasi — Dukung operasional bot' },
      ],
    },
    { type: 'divider' },
    {
      type: 'block_quotation',
      text:
        `Maksimal ${MAX_ADDRESSES_PER_USER} alamat aktif sekaligus (berlaku 6-72 jam).\n\n` +
        `📥 Cek email per alamat:\nBuka "Alamat Saya" → pilih alamat → "Cek Email Masuk".\n\n` +
        `📱 Mini App:\nBuka Mini App untuk tampilan email asli bergaya Gmail dengan filter OTP otomatis!\n\n` +
        `📎 Lampiran email otomatis dikirim sebagai file terpisah.\n🖼 Gambar email dikirim rapi dalam album foto.`,
    },
  ];

  let fallbackHtml =
    `❓ <b>Panduan Penggunaan</b>\n\n` +
    `<b>Perintah yang tersedia:</b>\n` +
    `• <code>/new</code> — Buat alamat baru (acak/custom)\n` +
    `• <code>/new &lt;nama&gt;</code> — Buat alamat nama sendiri\n` +
    `• <code>/list</code> — Lihat semua alamat aktif kamu\n` +
    `• <code>/inbox</code> — Lihat riwayat semua email\n` +
    `• <code>/delete &lt;alamat&gt;</code> — Hapus alamat tertentu\n` +
    `• <code>/deleteall</code> — Hapus semua alamat sekaligus\n` +
    `• <code>/donasi</code> — Dukung operasional bot\n\n` +
    `<blockquote>Maksimal ${MAX_ADDRESSES_PER_USER} alamat aktif (6-72 jam).\n` +
    `Gunakan Mini App untuk tampilan email asli bergaya Gmail.</blockquote>\n\n` +
    `Atau cukup gunakan tombol navigasi di bawah 👇`;

  if (isAdm) {
    blocks.push({
      type: 'block_quotation',
      text: '🛠️ Mode Admin Aktif:\nKetik /admin untuk melihat panel perintah khusus admin.',
    });
    fallbackHtml += `\n\n🛠️ <b>Mode Admin Aktif:</b>\nKetik <code>/admin</code> untuk melihat panel perintah khusus admin.`;
  }

  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: mainMenuKeyboard(workerUrl),
  };
}

function viewChooseDomain(alias, domains) {
  const blocks = [
    { type: 'section_heading', text: '🌐 Pilih Domain' },
  ];
  if (alias) {
    blocks.push({
      type: 'table',
      is_bordered: true,
      cells: [
        [{ text: 'Nama Alamat', is_header: true }, { text: alias }],
      ],
    });
  }
  blocks.push({ type: 'paragraph', text: 'Alamat ini mau menggunakan domain yang mana?' });

  const fallbackHtml =
    `🌐 <b>Pilih Domain</b>\n\n` +
    (alias ? `Nama alamat: <code>${escapeTelegramHtml(alias)}</code>\n\n` : '') +
    `Alamat ini mau menggunakan domain yang mana?`;

  const rows = domains.map((d, idx) => [{ text: `🌐 ${d}`, callback_data: `newdom:${idx}` }]);
  rows.push([{ text: '❌ Batal', callback_data: 'm' }]);
  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: { inline_keyboard: rows },
  };
}

function viewChooseDuration(alias, domain) {
  const blocks = [
    { type: 'section_heading', text: '🆕 Buat Alamat Baru' },
  ];
  const metaRows = [];
  if (alias) metaRows.push([{ text: 'Nama Alamat', is_header: true }, { text: alias }]);
  if (domain) metaRows.push([{ text: 'Domain', is_header: true }, { text: domain }]);
  if (metaRows.length) {
    blocks.push({
      type: 'table',
      is_bordered: true,
      cells: metaRows,
    });
  }
  blocks.push({ type: 'paragraph', text: 'Pilih masa berlaku untuk alamat ini:' });

  const fallbackHtml =
    `🆕 <b>Buat Alamat Baru</b>\n\n` +
    (alias ? `Nama: <code>${escapeTelegramHtml(alias)}</code>\n` : '') +
    (domain ? `Domain: <code>${escapeTelegramHtml(domain)}</code>\n\n` : '\n') +
    `Pilih masa berlaku untuk alamat ini:`;

  const rows = [];
  for (let i = 0; i < DURATION_OPTIONS_HOURS.length; i += 2) {
    const row = DURATION_OPTIONS_HOURS.slice(i, i + 2).map((h) => ({
      text: `⏳ ${h} jam`,
      callback_data: `newdur:${h}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: '❌ Batal', callback_data: 'm' }]);
  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: { inline_keyboard: rows },
  };
}

function viewAddressCreated(address, ttlHours, idx) {
  const blocks = [
    { type: 'section_heading', text: '✅ Alamat Baru Berhasil Dibuat' },
    {
      type: 'table',
      is_bordered: true,
      is_striped: true,
      cells: [
        [{ text: 'Alamat Email', is_header: true }, { text: address }],
        [{ text: 'Masa Aktif', is_header: true }, { text: `${ttlHours} Jam` }],
        [{ text: 'Status', is_header: true }, { text: '🟢 Aktif' }],
      ],
    },
    {
      type: 'paragraph',
      text: 'Ketuk dan salin alamat di atas. Semua email yang masuk otomatis dikirim ke chat ini.',
    },
  ];

  const fallbackHtml =
    `✅ <b>Alamat Baru Berhasil Dibuat</b>\n\n` +
    `<code>${escapeTelegramHtml(address)}</code>\n\n` +
    `🕒 <b>Masa Aktif:</b> ${ttlHours} Jam (🟢 Aktif)\n\n` +
    `Ketuk & tahan alamat di atas untuk menyalin. Semua email masuk otomatis diteruskan ke sini.`;

  const rows = [
    [
      { text: '👁 Detail', callback_data: `d:${idx}` },
      { text: '🆕 Buat Lagi', callback_data: 'new' },
    ],
    [{ text: '📮 Semua Alamat', callback_data: 'l:0' }],
    [{ text: '⬅️ Menu Utama', callback_data: 'm' }],
  ];
  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: { inline_keyboard: rows },
  };
}

function viewAddressList(addresses, page) {
  if (addresses.length === 0) {
    const blocks = [
      { type: 'section_heading', text: '📮 Alamat Email Aktif' },
      { type: 'paragraph', text: 'Kamu belum memiliki alamat email aktif.' },
    ];
    const fallbackHtml = '📮 <b>Alamat Email Aktif</b>\n\nKamu belum memiliki alamat email aktif.';
    return {
      richMessage: { blocks },
      fallbackHtml,
      text: fallbackHtml,
      keyboard: {
        inline_keyboard: [
          [{ text: '🆕 Buat Alamat Baru', callback_data: 'new' }],
          [{ text: '⬅️ Menu Utama', callback_data: 'm' }],
        ],
      },
    };
  }

  const totalPages = Math.max(1, Math.ceil(addresses.length / ADDR_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * ADDR_PAGE_SIZE;
  const slice = addresses.slice(start, start + ADDR_PAGE_SIZE);
  const now = Date.now();

  const tableCells = [
    [
      { text: '#', is_header: true },
      { text: 'Alamat Email', is_header: true },
      { text: 'Sisa Waktu', is_header: true },
    ],
  ];

  let fallbackList = '';
  slice.forEach((a, localIdx) => {
    const globalIdx = start + localIdx;
    const remaining = formatRemaining(a.expiresAt - now);
    tableCells.push([
      { text: String(globalIdx + 1) },
      { text: a.address },
      { text: remaining },
    ]);
    fallbackList += `<b>${globalIdx + 1}.</b> <code>${escapeTelegramHtml(a.address)}</code> · ⏳ ${escapeTelegramHtml(remaining)}\n`;
  });

  const blocks = [
    {
      type: 'section_heading',
      text: `📮 Alamat Aktif (${addresses.length}/${MAX_ADDRESSES_PER_USER}) · Hal ${safePage + 1}/${totalPages}`,
    },
    {
      type: 'table',
      is_bordered: true,
      is_striped: true,
      cells: tableCells,
    },
    { type: 'paragraph', text: 'Pilih tombol di bawah untuk melihat detail atau tindakan:' },
  ];

  const fallbackHtml =
    `📮 <b>Alamat Aktif (${addresses.length}/${MAX_ADDRESSES_PER_USER})</b>\n` +
    `Halaman ${safePage + 1}/${totalPages}\n\n` +
    fallbackList +
    `\nKetuk salah satu tombol di bawah untuk lihat detail:`;

  const rows = slice.map((a, localIdx) => {
    const globalIdx = start + localIdx;
    const remaining = formatRemaining(a.expiresAt - now);
    return [{ text: `${globalIdx + 1}. ${a.address} · ${remaining}`, callback_data: `d:${globalIdx}` }];
  });

  const navRow = [];
  if (safePage > 0) navRow.push({ text: '◀ Sebelumnya', callback_data: `l:${safePage - 1}` });
  if (safePage < totalPages - 1) navRow.push({ text: 'Berikutnya ▶', callback_data: `l:${safePage + 1}` });
  if (navRow.length) rows.push(navRow);

  rows.push([
    { text: '🆕 Buat Baru', callback_data: 'new' },
    { text: '⏳ Perpanjang Semua', callback_data: 'extall' },
  ]);
  rows.push([{ text: '🗑 Hapus Semua', callback_data: 'dela' }]);
  rows.push([{ text: '⬅️ Menu Utama', callback_data: 'm' }]);

  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: { inline_keyboard: rows },
  };
}

function viewAddressDetail(addresses, idx) {
  const a = addresses[idx];
  const now = Date.now();
  const page = Math.floor(idx / ADDR_PAGE_SIZE);

  const remaining = formatRemaining(a.expiresAt - now);
  const createdStr = formatDateTime(a.createdAt);

  const blocks = [
    { type: 'section_heading', text: `📄 Detail Alamat #${idx + 1}` },
    {
      type: 'table',
      is_bordered: true,
      is_striped: true,
      cells: [
        [{ text: 'Alamat', is_header: true }, { text: a.address }],
        [{ text: 'Dibuat', is_header: true }, { text: createdStr }],
        [{ text: 'Sisa Waktu', is_header: true }, { text: remaining }],
        [{ text: 'Status', is_header: true }, { text: '🟢 Aktif' }],
      ],
    },
    {
      type: 'paragraph',
      text: 'Ketuk & tahan alamat untuk menyalin. Gunakan tombol di bawah untuk mengelola:',
    },
  ];

  const fallbackHtml =
    `📄 <b>Detail Alamat #${idx + 1}</b>\n\n` +
    `<code>${escapeTelegramHtml(a.address)}</code>\n\n` +
    `🕒 <b>Dibuat:</b> ${escapeTelegramHtml(createdStr)}\n` +
    `⏳ <b>Sisa waktu:</b> ${escapeTelegramHtml(remaining)}\n` +
    `🟢 <b>Status:</b> Aktif\n\n` +
    `Ketuk & tahan teks di atas untuk menyalin.`;

  const rows = [
    [{ text: '📥 Cek Email Masuk', callback_data: `ai:${idx}:0` }],
    [
      { text: '⏳ Perpanjang', callback_data: `ext:${idx}` },
      { text: '🗑 Hapus', callback_data: `delc:${idx}` },
    ],
    [{ text: '⬅️ Kembali ke Daftar', callback_data: `l:${page}` }],
    [{ text: '🏠 Menu Utama', callback_data: 'm' }],
  ];

  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: { inline_keyboard: rows },
  };
}

function viewAddressInboxList(addresses, addrIdx, inbox, page) {
  const addr = addresses[addrIdx];
  const filtered = inbox.filter((item) => item.address === addr.address);
  const backToDetail = { text: '⬅️ Kembali ke Detail Alamat', callback_data: `d:${addrIdx}` };
  const menuBtn = { text: '🏠 Menu Utama', callback_data: 'm' };

  if (filtered.length === 0) {
    const blocks = [
      { type: 'section_heading', text: '📥 Email Masuk untuk Alamat Ini' },
      {
        type: 'table',
        is_bordered: true,
        cells: [[{ text: 'Alamat', is_header: true }, { text: addr.address }]],
      },
      { type: 'paragraph', text: 'Belum ada email yang masuk ke alamat ini.' },
    ];
    const fallbackHtml =
      `📥 <b>Email Masuk untuk Alamat Ini</b>\n\n` +
      `<code>${escapeTelegramHtml(addr.address)}</code>\n\n` +
      `Belum ada email yang masuk ke alamat ini.`;
    return {
      richMessage: { blocks },
      fallbackHtml,
      text: fallbackHtml,
      keyboard: { inline_keyboard: [[backToDetail], [menuBtn]] },
    };
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / INBOX_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * INBOX_PAGE_SIZE;
  const slice = filtered.slice(start, start + INBOX_PAGE_SIZE);

  const tableCells = [
    [
      { text: '#', is_header: true },
      { text: 'Waktu', is_header: true },
      { text: 'Subjek', is_header: true },
    ],
  ];

  let fallbackList = '';
  slice.forEach((item, localIdx) => {
    const globalFilteredIdx = start + localIdx;
    const time = formatDateTime(item.receivedAt);
    const attachNote = item.hasAttachment ? ' 📎' : '';
    const subj = truncateForButton(item.subject, 30);
    tableCells.push([
      { text: String(globalFilteredIdx + 1) },
      { text: time },
      { text: `${subj}${attachNote}` },
    ]);
    fallbackList += `<b>${globalFilteredIdx + 1}.</b> [${escapeTelegramHtml(time)}]${attachNote} ${escapeTelegramHtml(subj)}\n`;
  });

  const blocks = [
    {
      type: 'section_heading',
      text: `📥 Email Masuk (${filtered.length} total) · Hal ${safePage + 1}/${totalPages}`,
    },
    {
      type: 'table',
      is_bordered: true,
      is_striped: true,
      cells: tableCells,
    },
    { type: 'paragraph', text: 'Ketuk tombol di bawah untuk melihat rincian email:' },
  ];

  const fallbackHtml =
    `📥 <b>Email Masuk untuk Alamat Ini</b>\n\n` +
    `<code>${escapeTelegramHtml(addr.address)}</code>\n\n` +
    `${filtered.length} email · Halaman ${safePage + 1}/${totalPages}\n\n` +
    fallbackList +
    `\nKetuk salah satu untuk lihat isi lengkap:`;

  const rows = slice.map((item, localIdx) => {
    const globalFilteredIdx = start + localIdx;
    const time = formatDateTime(item.receivedAt);
    const attachNote = item.hasAttachment ? ' 📎' : '';
    const subj = truncateForButton(item.subject, 40);
    return [
      {
        text: `${globalFilteredIdx + 1}. [${time}]${attachNote} ${subj}`,
        callback_data: `aid:${addrIdx}:${safePage}:${globalFilteredIdx}`,
      },
    ];
  });

  const navRow = [];
  if (safePage > 0) navRow.push({ text: '◀ Sebelumnya', callback_data: `ai:${addrIdx}:${safePage - 1}` });
  if (safePage < totalPages - 1) navRow.push({ text: 'Berikutnya ▶', callback_data: `ai:${addrIdx}:${safePage + 1}` });
  if (navRow.length) rows.push(navRow);

  rows.push([backToDetail]);
  rows.push([menuBtn]);

  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: { inline_keyboard: rows },
  };
}

function viewAddressInboxDetail(addresses, addrIdx, inbox, page, filteredIdx, part = 0) {
  const addr = addresses[addrIdx];
  const filtered = inbox.filter((item) => item.address === addr.address);
  const item = filtered[filteredIdx];

  const cleanText = item.cleanText || item.fullText || item.snippet || '(tidak ada isi pesan)';

  let primaryOtp = item.primaryOtp;
  let verificationLink = item.verificationLink;
  if (!primaryOtp && !verificationLink) {
    const extracted = extractOtpAndLinks(cleanText, item.subject || '');
    primaryOtp = extracted.primaryOtp;
    verificationLink = extracted.verificationLink;
  }

  const chunks = splitTextIntoChunks(cleanText, 2500);
  const totalParts = Math.max(1, chunks.length);
  const safePart = Math.max(0, Math.min(part, totalParts - 1));

  let detailHtml =
    `📧 <b>Detail Email Masuk</b>\n\n` +
    `<b>Ke:</b> <code>${escapeTelegramHtml(item.address)}</code>\n` +
    `<b>Dari:</b> ${escapeTelegramHtml(item.from)}\n` +
    `<b>Waktu:</b> ${escapeTelegramHtml(formatDateTime(item.receivedAt))}\n` +
    `<b>Subjek:</b> <b>${escapeTelegramHtml(item.subject)}</b>\n` +
    (item.hasAttachment ? `📎 <i>Ada lampiran</i>\n` : '') +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (primaryOtp) {
    detailHtml +=
      `🔐 <b>KODE VERIFIKASI / OTP:</b>\n` +
      `👉 <code>${escapeTelegramHtml(primaryOtp)}</code>  <i>(Ketuk untuk menyalin)</i>\n\n`;
  }

  if (verificationLink) {
    detailHtml +=
      `🔗 <b>Tautan Verifikasi:</b>\n` +
      `<a href="${escapeHtmlAttr(verificationLink)}">${escapeTelegramHtml(truncateForButton(verificationLink, 50))}</a>\n\n`;
  }

  if (totalParts > 1) {
    detailHtml += `📝 <b>Isi Pesan (Bagian ${safePart + 1}/${totalParts}):</b>\n\n`;
  } else {
    detailHtml += `📝 <b>Isi Pesan:</b>\n\n`;
  }

  detailHtml += linkifyTelegramHtml(chunks[safePart] || '');

  const rows = [];
  if (primaryOtp) {
    rows.push([
      {
        text: `📋 Salin: ${primaryOtp}`,
        copy_text: { text: primaryOtp },
      },
    ]);
  }
  if (verificationLink) {
    rows.push([
      {
        text: '🔗 Buka Tautan Verifikasi',
        url: verificationLink,
      },
    ]);
  }

  if (totalParts > 1) {
    const navRow = [];
    if (safePart > 0) {
      navRow.push({ text: `◀ Bagian ${safePart}`, callback_data: `aid:${addrIdx}:${page}:${filteredIdx}:${safePart - 1}` });
    }
    navRow.push({ text: `📄 ${safePart + 1}/${totalParts}`, callback_data: `aid:${addrIdx}:${page}:${filteredIdx}:${safePart}` });
    if (safePart < totalParts - 1) {
      navRow.push({ text: `Bagian ${safePart + 2} ▶`, callback_data: `aid:${addrIdx}:${page}:${filteredIdx}:${safePart + 1}` });
    }
    rows.push(navRow);
    rows.push([{ text: `📨 Kirim Seluruh Teks (${totalParts} Bagian)`, callback_data: `ai_send_all:${addrIdx}:${filteredIdx}` }]);
  }

  rows.push(
    [{ text: '⬅️ Kembali ke Email Masuk', callback_data: `ai:${addrIdx}:${page}` }],
    [{ text: '🏠 Menu Utama', callback_data: 'm' }]
  );

  return {
    fallbackHtml: detailHtml,
    text: detailHtml,
    keyboard: { inline_keyboard: rows },
  };
}

function viewConfirmDelete(addresses, idx) {
  const a = addresses[idx];
  const blocks = [
    { type: 'section_heading', text: '⚠️ Konfirmasi Hapus Alamat' },
    {
      type: 'table',
      is_bordered: true,
      cells: [[{ text: 'Alamat', is_header: true }, { text: a.address }]],
    },
    {
      type: 'paragraph',
      text: 'Yakin mau menghapus alamat ini? Tindakan ini tidak bisa dibatalkan.',
    },
  ];

  const fallbackHtml =
    `⚠️ <b>Konfirmasi Hapus Alamat</b>\n\n` +
    `<code>${escapeTelegramHtml(a.address)}</code>\n\n` +
    `Yakin mau menghapus alamat ini? Tindakan ini tidak bisa dibatalkan.`;

  const rows = [
    [
      { text: '✅ Ya, Hapus', callback_data: `deldo:${idx}` },
      { text: '❌ Batal', callback_data: `d:${idx}` },
    ],
  ];
  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: { inline_keyboard: rows },
  };
}

function viewConfirmDeleteAll() {
  const blocks = [
    { type: 'section_heading', text: '⚠️ Hapus SEMUA Alamat Aktif?' },
    {
      type: 'paragraph',
      text: 'Yakin mau menghapus SEMUA alamat aktif kamu? Tindakan ini tidak bisa dibatalkan.',
    },
  ];

  const fallbackHtml =
    `⚠️ <b>Hapus SEMUA Alamat Aktif?</b>\n\n` +
    `Yakin mau menghapus <b>SEMUA</b> alamat aktif kamu? Tindakan ini tidak bisa dibatalkan.`;

  const rows = [
    [
      { text: '✅ Ya, Hapus Semua', callback_data: 'delado' },
      { text: '❌ Batal', callback_data: 'l:0' },
    ],
  ];
  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: { inline_keyboard: rows },
  };
}

function viewInboxList(inbox, page) {
  if (inbox.length === 0) {
    const blocks = [
      { type: 'section_heading', text: '📥 Riwayat Email' },
      { type: 'paragraph', text: 'Belum ada email yang masuk.' },
    ];
    const fallbackHtml = '📥 <b>Riwayat Email</b>\n\nBelum ada email yang masuk.';
    return {
      richMessage: { blocks },
      fallbackHtml,
      text: fallbackHtml,
      keyboard: { inline_keyboard: [[{ text: '⬅️ Menu Utama', callback_data: 'm' }]] },
    };
  }

  const totalPages = Math.max(1, Math.ceil(inbox.length / INBOX_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * INBOX_PAGE_SIZE;
  const slice = inbox.slice(start, start + INBOX_PAGE_SIZE);

  const tableCells = [
    [
      { text: '#', is_header: true },
      { text: 'Waktu', is_header: true },
      { text: 'Pengirim', is_header: true },
      { text: 'Subjek', is_header: true },
    ],
  ];

  let fallbackList = '';
  slice.forEach((item, localIdx) => {
    const globalIdx = start + localIdx;
    const time = formatDateTime(item.receivedAt);
    const attachNote = item.hasAttachment ? ' 📎' : '';
    const subj = truncateForButton(item.subject, 30);
    tableCells.push([
      { text: String(globalIdx + 1) },
      { text: time },
      { text: truncateForButton(item.from, 20) },
      { text: `${subj}${attachNote}` },
    ]);
    fallbackList += `<b>${globalIdx + 1}.</b> [${escapeTelegramHtml(time)}] <i>${escapeTelegramHtml(item.from)}</i>${attachNote} — ${escapeTelegramHtml(subj)}\n`;
  });

  const blocks = [
    {
      type: 'section_heading',
      text: `📥 Riwayat Email (${inbox.length} total) · Hal ${safePage + 1}/${totalPages}`,
    },
    {
      type: 'table',
      is_bordered: true,
      is_striped: true,
      cells: tableCells,
    },
    { type: 'paragraph', text: 'Ketuk salah satu tombol di bawah untuk melihat rincian isi:' },
  ];

  const fallbackHtml =
    `📥 <b>Riwayat Email (${inbox.length} total)</b>\n` +
    `Halaman ${safePage + 1}/${totalPages}\n\n` +
    fallbackList +
    `\nKetuk salah satu tombol untuk lihat isi:`;

  const rows = slice.map((item, localIdx) => {
    const globalIdx = start + localIdx;
    const time = formatDateTime(item.receivedAt);
    const attachNote = item.hasAttachment ? ' 📎' : '';
    const subj = truncateForButton(item.subject, 40);
    return [{ text: `${globalIdx + 1}. [${time}]${attachNote} ${subj}`, callback_data: `inbox_detail:${globalIdx}` }];
  });

  const navRow = [];
  if (safePage > 0) navRow.push({ text: '◀ Sebelumnya', callback_data: `i:${safePage - 1}` });
  if (safePage < totalPages - 1) navRow.push({ text: 'Berikutnya ▶', callback_data: `i:${safePage + 1}` });
  if (navRow.length) rows.push(navRow);

  rows.push([{ text: '⬅️ Menu Utama', callback_data: 'm' }]);

  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: { inline_keyboard: rows },
  };
}

function viewInboxDetail(inbox, idx, part = 0) {
  const item = inbox[idx];
  const page = Math.floor(idx / INBOX_PAGE_SIZE);

  const cleanText = item.cleanText || item.fullText || item.snippet || '(tidak ada isi pesan)';

  let primaryOtp = item.primaryOtp;
  let verificationLink = item.verificationLink;
  if (!primaryOtp && !verificationLink) {
    const extracted = extractOtpAndLinks(cleanText, item.subject || '');
    primaryOtp = extracted.primaryOtp;
    verificationLink = extracted.verificationLink;
  }

  const chunks = splitTextIntoChunks(cleanText, 2500);
  const totalParts = Math.max(1, chunks.length);
  const safePart = Math.max(0, Math.min(part, totalParts - 1));

  let detailHtml =
    `📧 <b>Detail Email #${idx + 1}</b>\n\n` +
    `<b>Ke:</b> <code>${escapeTelegramHtml(item.address)}</code>\n` +
    `<b>Dari:</b> ${escapeTelegramHtml(item.from)}\n` +
    `<b>Waktu:</b> ${escapeTelegramHtml(formatDateTime(item.receivedAt))}\n` +
    `<b>Subjek:</b> <b>${escapeTelegramHtml(item.subject)}</b>\n` +
    (item.hasAttachment ? `📎 <i>Ada lampiran</i>\n` : '') +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (primaryOtp) {
    detailHtml +=
      `🔐 <b>KODE VERIFIKASI / OTP:</b>\n` +
      `👉 <code>${escapeTelegramHtml(primaryOtp)}</code>  <i>(Ketuk untuk menyalin)</i>\n\n`;
  }

  if (verificationLink) {
    detailHtml +=
      `🔗 <b>Tautan Verifikasi:</b>\n` +
      `<a href="${escapeHtmlAttr(verificationLink)}">${escapeTelegramHtml(truncateForButton(verificationLink, 50))}</a>\n\n`;
  }

  if (totalParts > 1) {
    detailHtml += `📝 <b>Isi Pesan (Bagian ${safePart + 1}/${totalParts}):</b>\n\n`;
  } else {
    detailHtml += `📝 <b>Isi Pesan:</b>\n\n`;
  }

  detailHtml += linkifyTelegramHtml(chunks[safePart] || '');

  const rows = [];
  if (primaryOtp) {
    rows.push([
      {
        text: `📋 Salin: ${primaryOtp}`,
        copy_text: { text: primaryOtp },
      },
    ]);
  }
  if (verificationLink) {
    rows.push([
      {
        text: '🔗 Buka Tautan Verifikasi',
        url: verificationLink,
      },
    ]);
  }

  if (totalParts > 1) {
    const navRow = [];
    if (safePart > 0) {
      navRow.push({ text: `◀ Bagian ${safePart}`, callback_data: `inbox_detail:${idx}:${safePart - 1}` });
    }
    navRow.push({ text: `📄 ${safePart + 1}/${totalParts}`, callback_data: `inbox_detail:${idx}:${safePart}` });
    if (safePart < totalParts - 1) {
      navRow.push({ text: `Bagian ${safePart + 2} ▶`, callback_data: `inbox_detail:${idx}:${safePart + 1}` });
    }
    rows.push(navRow);
    rows.push([{ text: `📨 Kirim Seluruh Teks (${totalParts} Bagian)`, callback_data: `inbox_send_all:${idx}` }]);
  }

  rows.push(
    [{ text: '⬅️ Kembali ke Riwayat', callback_data: `i:${page}` }],
    [{ text: '🏠 Menu Utama', callback_data: 'm' }]
  );

  return {
    fallbackHtml: detailHtml,
    text: detailHtml,
    keyboard: { inline_keyboard: rows },
  };
}

async function sendFullEmailToChat(env, chatId, item) {
  const cleanText = item.cleanText || item.fullText || item.snippet || '(tidak ada isi pesan)';
  let primaryOtp = item.primaryOtp;
  let verificationLink = item.verificationLink;
  if (!primaryOtp && !verificationLink) {
    const extracted = extractOtpAndLinks(cleanText, item.subject || '');
    primaryOtp = extracted.primaryOtp;
    verificationLink = extracted.verificationLink;
  }

  const chunks = splitTextIntoChunks(cleanText, 2500);

  let headerHtml =
    `📧 <b>Salinan Lengkap Email</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Ke:</b> <code>${escapeTelegramHtml(item.address)}</code>\n` +
    `<b>Dari:</b> ${escapeTelegramHtml(item.from)}\n` +
    `<b>Subjek:</b> <b>${escapeTelegramHtml(item.subject)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (primaryOtp) {
    headerHtml +=
      `🔐 <b>KODE VERIFIKASI / OTP:</b>\n` +
      `👉 <code>${escapeTelegramHtml(primaryOtp)}</code>  <i>(Ketuk untuk menyalin)</i>\n\n`;
  }

  if (verificationLink) {
    headerHtml +=
      `🔗 <b>Tautan Verifikasi:</b>\n` +
      `<a href="${escapeHtmlAttr(verificationLink)}">${escapeTelegramHtml(truncateForButton(verificationLink, 50))}</a>\n\n`;
  }

  for (let b = 0; b < chunks.length; b++) {
    const isFirst = b === 0;
    const msg = isFirst
      ? headerHtml + `📝 <b>Isi Pesan:</b>\n\n` + linkifyTelegramHtml(chunks[0])
      : `<b>(Bagian ${b + 1}/${chunks.length})</b>\n\n` + linkifyTelegramHtml(chunks[b]);

    const keyboard = isFirst && primaryOtp ? {
      inline_keyboard: [
        [{ text: `📋 Salin: ${primaryOtp}`, copy_text: { text: primaryOtp } }]
      ]
    } : undefined;

    await sendHtmlMessage(env, chatId, msg, keyboard);
  }
}

function viewAdminStats(totalUsers, totalCreated, activeLabel, totalEmails) {
  const blocks = [
    { type: 'section_heading', text: '📊 Statistik Bot (Admin)' },
    {
      type: 'table',
      is_bordered: true,
      is_striped: true,
      cells: [
        [{ text: 'Metrik', is_header: true }, { text: 'Jumlah', is_header: true }],
        [{ text: 'Total Pengguna' }, { text: String(totalUsers) }],
        [{ text: 'Alamat Pernah Dibuat' }, { text: String(totalCreated) }],
        [{ text: 'Alamat Aktif Saat Ini' }, { text: String(activeLabel) }],
        [{ text: 'Email Diteruskan' }, { text: String(totalEmails) }],
      ],
    },
  ];

  const fallbackHtml =
    `📊 <b>Statistik Bot (Admin)</b>\n\n` +
    `👤 <b>Total Pengguna:</b> ${totalUsers}\n` +
    `🆕 <b>Alamat Pernah Dibuat:</b> ${totalCreated}\n` +
    `📮 <b>Alamat Aktif:</b> ${activeLabel}\n` +
    `📧 <b>Email Diteruskan:</b> ${totalEmails}`;

  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: mainMenuKeyboard(),
  };
}

function viewAdminHelp() {
  const text =
    `🛠️ <b>PANEL PANDUAN PERINTAH ADMIN</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Halo Admin! Berikut daftar lengkap perintah khusus untuk mengelola bot:\n\n` +
    `📢 <b>Broadcast & Pengumuman:</b>\n` +
    `• <code>/broadcast &lt;pesan&gt;</code> (alias <code>/bc</code>)\n` +
    `  Kirim pengumuman resmi ke seluruh pengguna bot dengan pratinjau & konfirmasi.\n` +
    `  Mendukung format HTML (tebal, miring, link).\n\n` +
    `📊 <b>Pemantauan & Statistik:</b>\n` +
    `• <code>/stats</code>\n` +
    `  Lihat total pengguna, total email masuk, dan alamat aktif.\n` +
    `• <code>/domains</code>\n` +
    `  Lihat semua domain aktif yang terhubung.\n\n` +
    `🌐 <b>Manajemen Domain:</b>\n` +
    `• <code>/adddomain &lt;domain&gt;</code>\n` +
    `  Tambah domain baru (contoh: <code>/adddomain temp2.com</code>).\n` +
    `• <code>/removedomain &lt;domain&gt;</code>\n` +
    `  Hapus domain dari daftar tambahan.\n\n` +
    `⚙️ <b>Pengaturan & Integrasi:</b>\n` +
    `• <code>/setqris</code>\n` +
    `  Upload gambar QRIS donasi baru via chat Telegram.\n` +
    `• <code>/setupapp &lt;url&gt;</code>\n` +
    `  Atur tombol Menu Mini App di pojok kiri bawah chat pengguna.\n` +
    `• <code>/admin</code> (alias <code>/adminhelp</code>)\n` +
    `  Membuka kembali panel panduan admin ini.\n\n` +
    `<i>Pilih tombol aksi cepat di bawah untuk eksekusi instan:</i>`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📊 Cek Statistik', callback_data: 'admin_stats' },
        { text: '🌐 Daftar Domain', callback_data: 'admin_domains' },
      ],
      [
        { text: '🖼️ Upload QRIS', callback_data: 'admin_setqris' },
        { text: '📱 Setup Mini App', callback_data: 'admin_setupapp' },
      ],
      [
        { text: '⬅️ Menu Utama', callback_data: 'm' },
      ],
    ],
  };

  return {
    fallbackHtml: text,
    text,
    keyboard,
  };
}

async function getWorkerUrl(env) {
  if (env.WORKER_URL) return env.WORKER_URL;
  try {
    return await env.TEMPMAIL_KV.get('config:workerUrl');
  } catch {
    return null;
  }
}

async function configureTelegramMenuButton(env, workerUrl) {
  if (!workerUrl || !env.TELEGRAM_BOT_TOKEN) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: {
          type: 'web_app',
          text: 'Mini App',
          web_app: {
            url: workerUrl,
          },
        },
      }),
    });
    return res.ok;
  } catch (err) {
    console.error('Gagal configureTelegramMenuButton:', err);
    return false;
  }
}

function mainMenuKeyboard(workerUrl = null) {
  const inline_keyboard = [];
  if (workerUrl) {
    inline_keyboard.push([{ text: '📱 Buka Mini App', web_app: { url: workerUrl } }]);
  }
  inline_keyboard.push([{ text: '🆕 Buat Alamat Baru', callback_data: 'new' }]);
  inline_keyboard.push([
    { text: '📮 Alamat Saya', callback_data: 'l:0' },
    { text: '📥 Semua Email', callback_data: 'i:0' },
  ]);
  inline_keyboard.push([{ text: '❓ Bantuan', callback_data: 'help' }]);
  inline_keyboard.push([{ text: '💝 Donasi', callback_data: 'donasi' }]);
  return { inline_keyboard };
}

function emailActionsKeyboard(address, primaryOtp = null, verificationLink = null, workerUrl = null) {
  const rows = [];
  if (primaryOtp) {
    rows.push([
      {
        text: `📋 Salin: ${primaryOtp}`,
        copy_text: { text: primaryOtp },
      },
    ]);
  }
  if (verificationLink) {
    rows.push([
      {
        text: '🔗 Buka Tautan Verifikasi',
        url: verificationLink,
      },
    ]);
  }
  if (workerUrl) {
    rows.push([
      {
        text: '📱 Buka di Mini App (Format Asli)',
        web_app: { url: workerUrl },
      },
    ]);
  }
  rows.push([
    { text: '📮 Alamat Saya', callback_data: 'l:0' },
    { text: '🆕 Alamat Baru', callback_data: 'new' },
  ]);
  return { inline_keyboard: rows };
}

function truncateForButton(str, maxLen) {
  const s = String(str || '');
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

// --- Send & Edit Views ---

async function sendView(env, chatId, view) {
  await sendRichOrHtmlMessage(env, chatId, view.richMessage, view.fallbackHtml || view.text, view.keyboard);
}

async function editView(env, chatId, messageId, view) {
  await editRichOrHtmlView(env, chatId, messageId, view);
}

// --- Admin Logs & Metrics ---

function getAdminList(env) {
  return (env.ADMIN_CHAT_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAdmin(env, chatId) {
  return getAdminList(env).some((id) => String(id) === String(chatId));
}

function formatUserLink(from, chatId) {
  const id = chatId ?? (from && from.id);
  const label = from && from.username
    ? `@${from.username}`
    : from && (from.first_name || from.last_name)
      ? [from.first_name, from.last_name].filter(Boolean).join(' ')
      : `User ${id}`;
  return `<a href="tg://user?id=${id}">${escapeTelegramHtml(label)}</a>`;
}

async function notifyAdmin(env, html) {
  const admins = getAdminList(env);
  if (admins.length === 0) return;
  await Promise.all(
    admins.map(async (id) => {
      try {
        await sendHtmlMessage(env, id, html);
      } catch (err) {
        console.error('Gagal mengirim log ke admin', id, err);
      }
    })
  );
}

async function trackUserAndMaybeNotify(env, chatId, from) {
  try {
    const key = `seen:${chatId}`;
    const exists = await env.TEMPMAIL_KV.get(key);
    if (exists) return;
    await env.TEMPMAIL_KV.put(key, '1');
    await incrementCounter(env, 'stats:totalUsers');
    await notifyAdmin(env, `👤 User baru: ${formatUserLink(from, chatId)}`);
  } catch (err) {
    console.error('Gagal tracking user baru:', err);
  }
}

async function incrementCounter(env, key) {
  try {
    const raw = await env.TEMPMAIL_KV.get(key);
    const current = raw ? parseInt(raw, 10) || 0 : 0;
    await env.TEMPMAIL_KV.put(key, String(current + 1));
  } catch (err) {
    console.error('Gagal update counter', key, err);
  }
}

async function getCounter(env, key) {
  try {
    const raw = await env.TEMPMAIL_KV.get(key);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

async function getActiveAddressCount(env) {
  try {
    const list = await env.TEMPMAIL_KV.list({ prefix: 'addr:' });
    return { count: list.keys.length, complete: list.list_complete };
  } catch {
    return { count: null, complete: true };
  }
}

// --- Storage (Cloudflare KV) ---

async function getDomainList(env) {
  const baseDomains = (env.TEMPMAIL_DOMAIN || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  let extraDomains = [];
  try {
    const raw = await env.TEMPMAIL_KV.get('config:extraDomains');
    extraDomains = raw ? JSON.parse(raw) : [];
  } catch {
    extraDomains = [];
  }

  return Array.from(new Set([...baseDomains, ...extraDomains]));
}

async function addExtraDomain(env, domain) {
  const raw = await env.TEMPMAIL_KV.get('config:extraDomains');
  let list = [];
  try {
    list = raw ? JSON.parse(raw) : [];
  } catch {
    list = [];
  }
  if (list.includes(domain)) return false;
  list.push(domain);
  await env.TEMPMAIL_KV.put('config:extraDomains', JSON.stringify(list));
  return true;
}

async function removeExtraDomain(env, domain) {
  const raw = await env.TEMPMAIL_KV.get('config:extraDomains');
  let list = [];
  try {
    list = raw ? JSON.parse(raw) : [];
  } catch {
    list = [];
  }
  const idx = list.indexOf(domain);
  if (idx === -1) return false;
  list.splice(idx, 1);
  await env.TEMPMAIL_KV.put('config:extraDomains', JSON.stringify(list));
  return true;
}

async function getRandomDomain(env) {
  const domains = await getDomainList(env);
  if (domains.length === 0) throw new Error('Belum ada domain yang dikonfigurasi.');
  return domains[Math.floor(Math.random() * domains.length)];
}

function sanitizeDomain(raw) {
  if (!raw) return null;
  const domain = raw.toLowerCase().trim();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) return null;
  return domain;
}

function sanitizeAlias(raw) {
  const alias = raw.toLowerCase().trim().replace(/\s+/g, '');
  if (!/^[a-z0-9._-]{3,20}$/.test(alias)) return null;
  return alias;
}

async function getUserAddresses(env, chatId) {
  const listRaw = await env.TEMPMAIL_KV.get(`userlist:${chatId}`);
  let list = [];
  try {
    list = listRaw ? JSON.parse(listRaw) : [];
  } catch {
    list = [];
  }
  if (list.length === 0) return [];

  const results = await Promise.all(
    list.map(async (address) => {
      const raw = await env.TEMPMAIL_KV.get(`addr:${address}`);
      if (!raw) return null;
      try {
        const data = JSON.parse(raw);
        const ttl = data.ttlSeconds || ADDRESS_TTL_SECONDS;
        return { address, createdAt: data.createdAt, ttlSeconds: ttl, expiresAt: data.createdAt + ttl * 1000 };
      } catch {
        return null;
      }
    })
  );

  const valid = results.filter(Boolean);
  if (valid.length !== list.length) {
    await saveUserAddressList(env, chatId, valid.map((v) => v.address));
  }

  return valid;
}

async function saveUserAddressList(env, chatId, addresses) {
  if (addresses.length === 0) {
    await env.TEMPMAIL_KV.delete(`userlist:${chatId}`);
  } else {
    await env.TEMPMAIL_KV.put(`userlist:${chatId}`, JSON.stringify(addresses));
  }
}

async function createNewAddress(env, chatId, customAlias, ttlSeconds, domain) {
  const ttl = ttlSeconds || ADDRESS_TTL_SECONDS;
  const current = await getUserAddresses(env, chatId);
  if (current.length >= MAX_ADDRESSES_PER_USER) {
    return { error: 'limit' };
  }

  const chosenDomain = domain || (await getRandomDomain(env));
  let address = null;

  if (customAlias) {
    const candidate = `${customAlias}@${chosenDomain}`;
    const exists = await env.TEMPMAIL_KV.get(`addr:${candidate}`);
    if (exists) return { error: 'taken' };
    address = candidate;
  } else {
    for (let attempt = 0; attempt < 6 && !address; attempt++) {
      const candidate = `${generateHumanLocalPart()}@${chosenDomain}`;
      const exists = await env.TEMPMAIL_KV.get(`addr:${candidate}`);
      if (!exists) address = candidate;
    }
    if (!address) address = `${generateHumanLocalPart(true)}@${chosenDomain}`;
  }

  const createdAt = Date.now();
  await env.TEMPMAIL_KV.put(`addr:${address}`, JSON.stringify({ chatId, createdAt, ttlSeconds: ttl }), {
    expirationTtl: ttl,
  });

  const updatedList = [...current.map((a) => a.address), address];
  await saveUserAddressList(env, chatId, updatedList);

  return { address, createdAt };
}

async function extendAddress(env, chatId, address) {
  const raw = await env.TEMPMAIL_KV.get(`addr:${address}`);
  if (!raw) return false;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (data.chatId !== chatId) return false;

  const ttl = data.ttlSeconds || ADDRESS_TTL_SECONDS;
  data.createdAt = Date.now();
  await env.TEMPMAIL_KV.put(`addr:${address}`, JSON.stringify(data), { expirationTtl: ttl });
  return true;
}

async function deleteAddress(env, chatId, address) {
  const raw = await env.TEMPMAIL_KV.get(`addr:${address}`);
  if (!raw) return false;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (!data || data.chatId !== chatId) return false;

  await env.TEMPMAIL_KV.delete(`addr:${address}`);
  await getUserAddresses(env, chatId);
  return true;
}

async function deleteAllAddresses(env, chatId) {
  const current = await getUserAddresses(env, chatId);
  await Promise.all(current.map((a) => env.TEMPMAIL_KV.delete(`addr:${a.address}`)));
  await env.TEMPMAIL_KV.delete(`userlist:${chatId}`);
}

async function pushInboxEntry(env, chatId, entry) {
  if (!entry.id) {
    entry.id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }
  const raw = await env.TEMPMAIL_KV.get(`inbox:${chatId}`);
  let list = [];
  try {
    list = raw ? JSON.parse(raw) : [];
  } catch {
    list = [];
  }
  list.unshift(entry);
  if (list.length > MAX_INBOX_HISTORY) list = list.slice(0, MAX_INBOX_HISTORY);
  await env.TEMPMAIL_KV.put(`inbox:${chatId}`, JSON.stringify(list), { expirationTtl: INBOX_TTL_SECONDS });
}

async function getInbox(env, chatId) {
  const raw = await env.TEMPMAIL_KV.get(`inbox:${chatId}`);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list)
      ? list.map((item, idx) => ({
        id: item.id || `msg_${item.receivedAt || idx}`,
        ...item,
      }))
      : [];
  } catch {
    return [];
  }
}

// --- Address Name Generator ---

const WORD_ADJECTIVES = [
  'senja', 'langit', 'kopi', 'hujan', 'angin', 'malam', 'pagi', 'kilat',
  'ombak', 'rimba', 'sunyi', 'riang', 'cerah', 'gelap', 'manis', 'santai',
  'gesit', 'lincah', 'tenang', 'liar', 'biru', 'jingga', 'perak', 'emas',
];

const WORD_NOUNS = [
  'kucing', 'elang', 'harimau', 'serigala', 'beruang', 'naga', 'singa',
  'rubah', 'merpati', 'kancil', 'tupai', 'gajah', 'panda', 'kuda', 'ikan',
  'camar', 'rusa', 'kelinci', 'burung', 'awan', 'bintang', 'bulan', 'daun',
];

const WORD_NAMES = [
  'budi', 'rani', 'dedi', 'sari', 'joko', 'yuni', 'agus', 'lina', 'fajar',
  'dewi', 'arif', 'nita', 'wawan', 'tari', 'rian', 'mira', 'dimas', 'ayu',
];

function secureRandomInt(maxExclusive) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % maxExclusive;
}

function pick(arr) {
  return arr[secureRandomInt(arr.length)];
}

function randomDigits(count) {
  let out = '';
  for (let i = 0; i < count; i++) {
    out += String(secureRandomInt(10));
  }
  return out;
}

function generateHumanLocalPart(forceFallback = false) {
  if (forceFallback) {
    return `${pick(WORD_ADJECTIVES)}${pick(WORD_NOUNS)}${randomDigits(4)}`;
  }

  const patterns = [
    () => `${pick(WORD_ADJECTIVES)}${pick(WORD_NOUNS)}${randomDigits(2)}`,
    () => `${pick(WORD_NOUNS)}${pick(WORD_ADJECTIVES)}${randomDigits(2)}`,
    () => `${pick(WORD_NAMES)}${randomDigits(2)}`,
    () => `${pick(WORD_NAMES)}.${pick(WORD_NOUNS)}`,
    () => `${pick(WORD_ADJECTIVES)}.${pick(WORD_NOUNS)}${randomDigits(1)}`,
    () => `${pick(WORD_NAMES)}${randomDigits(1)}${pick(WORD_NOUNS)}`,
  ];

  const candidate = pick(patterns)();
  return candidate.toLowerCase().slice(0, 20);
}

// --- Formatters ---

function formatRemaining(ms) {
  if (ms <= 0) return 'kadaluarsa';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}j ${minutes}m lagi`;
  return `${minutes}m lagi`;
}

function formatDateTime(timestampMs) {
  try {
    return new Date(timestampMs).toLocaleString('id-ID', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'Asia/Jakarta'
    });
  } catch {
    return new Date(timestampMs).toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta'
    });
  }
}


// --- Telegram API Helpers ---

async function tgApi(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.clone().text();
    console.error(`Telegram API error (${method}):`, res.status, errText);
  }
  return res;
}

async function sendPlainMessage(env, chatId, text, keyboard) {
  const payload = { chat_id: chatId, text };
  if (keyboard) payload.reply_markup = keyboard;
  await tgApi(env, 'sendMessage', payload);
}

async function sendHtmlMessage(env, chatId, text, keyboard) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) payload.reply_markup = keyboard;
  const res = await tgApi(env, 'sendMessage', payload);
  if (!res.ok) {
    const fallbackText = text.replace(/<[^>]+>/g, '');
    const plainPayload = { chat_id: chatId, text: fallbackText };
    if (keyboard) plainPayload.reply_markup = keyboard;
    return await tgApi(env, 'sendMessage', plainPayload);
  }
  return res;
}

async function sendRichOrHtmlMessage(env, chatId, richMessage, fallbackHtml, keyboard) {
  if (richMessage && richMessage.blocks && richMessage.blocks.length) {
    const payload = {
      chat_id: chatId,
      rich_message: richMessage,
    };
    if (keyboard) payload.reply_markup = keyboard;

    try {
      const res = await tgApi(env, 'sendRichMessage', payload);
      if (res.ok) return res;
      console.warn('sendRichMessage gagal, mencoba fallback ke HTML');
    } catch (err) {
      console.warn('sendRichMessage error, mencoba fallback ke HTML:', err);
    }
  }

  return await sendHtmlMessage(env, chatId, fallbackHtml || '(Pesan kosong)', keyboard);
}

async function editRichOrHtmlView(env, chatId, messageId, view) {
  let ok = false;
  if (view.richMessage && view.richMessage.blocks && view.richMessage.blocks.length) {
    try {
      const res = await tgApi(env, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        rich_message: view.richMessage,
        reply_markup: view.keyboard,
      });
      if (res.ok) {
        ok = true;
      } else {
        const errText = await res.clone().text().catch(() => '');
        if (errText.includes('message is not modified')) return;
      }
    } catch (e) {
      console.warn('editMessageText rich_message failed, fallback to text:', e);
    }
  }

  if (!ok) {
    const res = await tgApi(env, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: view.fallbackHtml || view.text || '(Pesan kosong)',
      parse_mode: 'HTML',
      reply_markup: view.keyboard,
    });
    if (res.ok) {
      ok = true;
    } else {
      let body = null;
      try {
        body = await res.clone().json();
      } catch {
        body = null;
      }
      const isNotModified = body && body.description && body.description.includes('message is not modified');
      if (!isNotModified) {
        const plainRes = await tgApi(env, 'editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: (view.fallbackHtml || view.text || '(Pesan kosong)').replace(/<[^>]+>/g, ''),
          reply_markup: view.keyboard,
        });
        if (!plainRes.ok) {
          await sendView(env, chatId, view);
        }
      }
    }
  }
}

async function sendEmailMediaGroups(env, chatId, imageUrls) {
  if (!imageUrls || !imageUrls.length) return;

  if (imageUrls.length === 1) {
    try {
      await tgApi(env, 'sendPhoto', { chat_id: chatId, photo: imageUrls[0] });
    } catch (err) {
      console.error('Gagal mengirim single photo:', err);
    }
    return;
  }

  const BATCH_SIZE = 10;
  for (let i = 0; i < imageUrls.length; i += BATCH_SIZE) {
    const chunk = imageUrls.slice(i, i + BATCH_SIZE);
    const media = chunk.map((url) => ({
      type: 'photo',
      media: url,
    }));

    try {
      const res = await tgApi(env, 'sendMediaGroup', {
        chat_id: chatId,
        media,
      });
      if (!res.ok) {
        console.warn('sendMediaGroup gagal, fallback ke sendPhoto per gambar');
        for (const url of chunk) {
          try {
            await tgApi(env, 'sendPhoto', { chat_id: chatId, photo: url });
          } catch (e) {
            console.error('Gagal fallback sendPhoto:', e);
          }
        }
      }
    } catch (err) {
      console.error('Error pengiriman media group:', err);
    }
  }
}

async function answerCallback(env, callbackQueryId, text, showAlert) {
  const payload = { callback_query_id: callbackQueryId };
  if (text) {
    payload.text = text;
    payload.show_alert = !!showAlert;
  }
  await tgApi(env, 'answerCallbackQuery', payload);
}

const DONATION_CAPTION =
  '💝 Terima kasih sudah mau mendukung bot ini!\n\n' +
  'Scan QRIS di atas untuk donasi. Setiap dukungan sangat berarti untuk biaya operasional bot ini. 🙏';

async function sendDonationImage(env, chatId) {
  try {
    const bytes = await env.TEMPMAIL_KV.get('assets:qris', { type: 'arrayBuffer' });
    if (bytes) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', DONATION_CAPTION);
      form.append('photo', new Blob([bytes], { type: 'image/png' }), 'qris.png');

      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        console.error('Telegram sendPhoto (KV) error:', res.status, await res.text());
        await sendPlainMessage(env, chatId, '⚠️ Gagal mengirim gambar QRIS. Coba lagi nanti.');
      }
      return;
    }
  } catch (err) {
    console.error('Gagal mengambil qris.png dari KV:', err);
  }

  await sendPlainMessage(
    env,
    chatId,
    '⚠️ Fitur donasi belum dikonfigurasi. Admin belum mengunggah qris.png ke KV (lihat README bagian "Fitur Donasi").'
  );
}

async function sendDocumentToTelegram(env, chatId, filename, mimeType, bytes) {
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([bytes], { type: mimeType || 'application/octet-stream' }), filename || 'lampiran');

    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Telegram sendDocument error:', res.status, errText);
    }
  } catch (err) {
    console.error('Gagal mengirim lampiran:', err);
  }
}

// --- MIME Parser ---

function findHeaderBodySplit(raw) {
  const idxRN = raw.indexOf('\r\n\r\n');
  const idxN = raw.indexOf('\n\n');
  if (idxRN === -1) return idxN;
  if (idxN === -1) return idxRN;
  return Math.min(idxRN, idxN);
}

function parseRawEmail(raw) {
  const { headers } = parseMimeNode(raw);

  const decodedHeaders = {};
  for (const key of Object.keys(headers)) {
    decodedHeaders[key] = decodeMimeHeader(headers[key]);
  }

  const result = { textPlain: '', textHtml: '', attachments: [] };
  collectMimeContent(raw, result);

  // Deteksi cerdas jika tidak ada textHtml tetapi textPlain berisi konten MIME bersarang atau HTML mentah
  if (!result.textHtml && result.textPlain) {
    const tp = result.textPlain;

    // 1. Cek apakah textPlain berisi embedded MIME headers (seperti Content-Type: text/html)
    if (/content-type:\s*text\/html/i.test(tp) || /content-transfer-encoding:/i.test(tp)) {
      const innerParsed = parseMimeNode(tp);
      const innerCt = (innerParsed.headers['content-type'] || '').toLowerCase();
      const innerEnc = (innerParsed.headers['content-transfer-encoding'] || '').toLowerCase();
      if (innerCt.includes('text/html') || /<!doctype html|<html/i.test(innerParsed.body)) {
        result.textHtml = decodeBodyByEncoding(innerParsed.body, innerEnc);
        result.textPlain = '';
      }
    }

    // 2. Cek apakah textPlain langsung berisi HTML mentah (dimulai atau berisi <!doctype html atau <html)
    if (!result.textHtml && /<!doctype html\b|<html\b/i.test(tp)) {
      let htmlCandidate = tp;
      if (/=3D/i.test(htmlCandidate) || /=\r?\n/.test(htmlCandidate)) {
        htmlCandidate = decodeUtf8QuotedPrintable(htmlCandidate);
      }
      const matchStart = htmlCandidate.match(/<!doctype html[\s\S]*$/i) || htmlCandidate.match(/<html[\s\S]*$/i);
      if (matchStart) {
        result.textHtml = matchStart[0];
        result.textPlain = htmlCandidate.slice(0, matchStart.index).trim();
      } else {
        result.textHtml = htmlCandidate;
        result.textPlain = '';
      }
    }
  }

  return {
    headers: decodedHeaders,
    textPlain: result.textPlain ? result.textPlain.trim() : '',
    textHtml: result.textHtml,
    attachments: result.attachments,
  };
}

function parseMimeNode(rawNode) {
  const idx = findHeaderBodySplit(rawNode);
  if (idx === -1) return { headers: {}, body: '' };

  const headerBlock = rawNode.slice(0, idx);
  const bodyBlock = rawNode.slice(idx).replace(/^(\r?\n)+/, '');

  const headers = {};
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  unfolded.split(/\r?\n/).forEach((line) => {
    const i2 = line.indexOf(':');
    if (i2 > -1) {
      const key = line.slice(0, i2).trim().toLowerCase();
      const value = line.slice(i2 + 1).trim();
      headers[key] = value;
    }
  });

  return { headers, body: bodyBlock };
}

function collectMimeContent(rawNode, result) {
  const { headers, body } = parseMimeNode(rawNode);
  const contentType = headers['content-type'] || 'text/plain';
  const contentTypeBase = contentType.split(';')[0].trim().toLowerCase();
  const boundaryMatch = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s\r\n]+))/i);
  const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2] || boundaryMatch[3]) : null;

  if (contentTypeBase.startsWith('multipart/') && boundary) {
    const rawParts = body.split(`--${boundary}`);
    for (const rp of rawParts) {
      const trimmedPart = rp.trim();
      if (!trimmedPart || trimmedPart === '--') continue;
      collectMimeContent(trimmedPart, result);
    }
    return;
  }

  if (contentTypeBase === 'message/rfc822') {
    collectMimeContent(body, result);
    return;
  }

  const isTextBody = contentTypeBase === 'text/plain' || contentTypeBase === 'text/html';
  const encoding = (headers['content-transfer-encoding'] || '').trim().toLowerCase();

  if (!isTextBody) {
    if (encoding === 'base64') {
      try {
        const disposition = headers['content-disposition'] || '';
        const filename =
          decodeMimeHeader(extractFilename(disposition) || extractFilename(contentType) || '') ||
          `lampiran${guessExtension(contentTypeBase)}`;
        const binaryString = atob(body.replace(/\s+/g, ''));
        const bytes = bytesFromBinaryString(binaryString);
        result.attachments.push({ filename, mimeType: contentTypeBase || 'application/octet-stream', bytes });
      } catch (e) {
        console.error('Gagal decode lampiran:', e);
      }
    }
    return;
  }

  const decodedText = decodeBodyByEncoding(body, encoding);
  if (contentTypeBase === 'text/plain') {
    if (!result.textPlain) result.textPlain = decodedText;
  } else if (contentTypeBase === 'text/html') {
    if (!result.textHtml) result.textHtml = decodedText;
  }
}

function extractFilename(headerValue) {
  if (!headerValue) return null;
  let match = headerValue.match(/filename\*=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  match = headerValue.match(/filename=["']?([^"';\r\n]+)["']?/i);
  if (match) return match[1];
  match = headerValue.match(/name=["']?([^"';\r\n]+)["']?/i);
  if (match) return match[1];
  return null;
}

function guessExtension(mimeTypeBase) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/csv': '.csv',
    'application/zip': '.zip',
    'application/msword': '.doc',
    'application/vnd.ms-excel': '.xls',
  };
  return map[mimeTypeBase] || '';
}

function bytesFromBinaryString(binStr) {
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return bytes;
}

function decodeUtf8Base64(b64) {
  try {
    const clean = b64.replace(/\s+/g, '');
    const bin = atob(clean);
    const bytes = bytesFromBinaryString(bin);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return b64;
  }
}

function decodeUtf8QuotedPrintable(str) {
  try {
    const normalized = str.replace(/=\r?\n/g, '');
    const bytes = [];
    let i = 0;
    while (i < normalized.length) {
      if (normalized[i] === '=' && i + 2 < normalized.length && /[0-9A-Fa-f]{2}/.test(normalized.slice(i + 1, i + 3))) {
        bytes.push(parseInt(normalized.slice(i + 1, i + 3), 16));
        i += 3;
      } else {
        bytes.push(normalized.charCodeAt(i));
        i++;
      }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return str;
  }
}

function decodeBodyByEncoding(text, encoding) {
  if (!encoding) return text;
  const enc = encoding.toLowerCase().trim();

  if (enc === 'base64') {
    return decodeUtf8Base64(text);
  }

  if (enc === 'quoted-printable') {
    return decodeUtf8QuotedPrintable(text);
  }

  return text;
}

function decodeMimeHeader(value) {
  if (!value) return value;
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_, charset, type, encoded) => {
    try {
      const cs = (charset || 'utf-8').toLowerCase();
      const decoder = new TextDecoder(cs.includes('8859') ? cs : 'utf-8', { fatal: false });
      if (type.toUpperCase() === 'B') {
        const bin = atob(encoded.replace(/\s+/g, ''));
        return decoder.decode(bytesFromBinaryString(bin));
      } else {
        const qClean = encoded.replace(/_/g, ' ');
        const bytes = [];
        let i = 0;
        while (i < qClean.length) {
          if (qClean[i] === '=' && i + 2 < qClean.length && /[0-9A-Fa-f]{2}/.test(qClean.slice(i + 1, i + 3))) {
            bytes.push(parseInt(qClean.slice(i + 1, i + 3), 16));
            i += 3;
          } else {
            bytes.push(qClean.charCodeAt(i));
            i++;
          }
        }
        return decoder.decode(new Uint8Array(bytes));
      }
    } catch {
      return encoded;
    }
  });
}

// --- Email Plain-Text Cleaning & OTP Extractor ---

function htmlToCleanText(html) {
  if (!html) return '';
  let text = html;

  if (/=3D/i.test(text) || /=\r?\n/.test(text)) {
    text = decodeUtf8QuotedPrintable(text);
  }

  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<head[\s\S]*?<\/head>/gi, '');

  text = text.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, label) => {
    const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
    if (!cleanLabel || cleanLabel === url) return url;
    return `${cleanLabel} (${url})`;
  });

  text = text.replace(/<li[^>]*>/gi, '\n• ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|tr|table|h[1-6]|ul|ol|blockquote)>/gi, '\n\n');
  text = text.replace(/<(p|div|tr|h[1-6]|blockquote)[^>]*>/gi, '\n');
  text = text.replace(/<(?:td|th)[^>]*>/gi, ' ');
  text = text.replace(/<\/(?:td|th)>/gi, ' ');

  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);

  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, idx, arr) => {
      if (!line && idx > 0 && !arr[idx - 1]) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function htmlToText(html) {
  return htmlToCleanText(html);
}

function cleanEmailBody(parsed) {
  let text = '';
  if (parsed.textHtml) {
    text = htmlToCleanText(parsed.textHtml);
  } else if (parsed.textPlain) {
    let plain = parsed.textPlain;
    if (/=3D/i.test(plain) || /=\r?\n/.test(plain)) {
      plain = decodeUtf8QuotedPrintable(plain);
    }
    if (/<[a-z!][\s\S]*>/i.test(plain)) {
      text = htmlToCleanText(plain);
    } else {
      text = plain.trim();
    }
  }

  if (text && /<[^>]+>/.test(text)) {
    text = text.replace(/<[^>]+>/g, '');
  }
  if (text) {
    text = decodeHtmlEntities(text);
  }
  return text ? text.trim() : '';
}

function extractOtpAndLinks(text, subject = '') {
  const combined = `${subject}\n${text}`;
  const otps = new Set();

  const gMatch = combined.match(/\bG-([0-9]{6})\b/i);
  if (gMatch) otps.add(gMatch[0].toUpperCase());

  const kwRegex = /(?:(?:kode|code)\s*(?:otp|verifikasi|konfirmasi|keamanan|akses|masuk|login)?|otp(?:\s*code)?|verification\s*code|confirm(?:ation)?\s*code|security\s*code|login\s*code|passcode|pin)\b[^\n\r:0-9]*[:=isadalah\s-]+\s*([0-9]{4,8}|[A-Z0-9]{3,4}-[A-Z0-9]{3,4})/gi;
  let match;
  while ((match = kwRegex.exec(combined)) !== null) {
    const candidate = match[1].trim();
    if (!isFalsePositiveOtp(candidate)) {
      otps.add(candidate);
    }
  }

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^[0-9]{4,8}$/.test(line)) {
      if (!isFalsePositiveOtp(line)) {
        otps.add(line);
      }
    } else if (/^[A-Z0-9]{3,4}-[A-Z0-9]{3,4}$/i.test(line)) {
      if (!isFalsePositiveOtp(line)) {
        otps.add(line);
      }
    }
  }

  const subjMatch = subject.match(/\b([0-9]{4,8})\b/);
  if (subjMatch && !isFalsePositiveOtp(subjMatch[1])) {
    otps.add(subjMatch[1]);
  }

  const urlRegex = /https?:\/\/[^\s<>"'`()]+/gi;
  const foundUrls = text.match(urlRegex) || [];
  let verificationLink = null;
  const ignoredLinkKeywords = /unsubscribe|berhenti-langganan|berhenti|langganan|optout|opt-out|subscription|privacy|privasi|kebijakan|terms|syarat|ketentuan|bantuan|support|panduan|dukungan|help|pusat-bantuan|preference|manage-account|facebook|twitter|instagram|youtube|linkedin|tiktok|threads|whatsapp|wa\.me|google-play|play\.google|apple\.com|apps\.apple|github\.com\/settings/i;
  const verifyLinkKeywords = /verify|verification|verifikasi|confirm|confirmation|konfirmasi|activate|activation|aktivasi|aktifkan|validate|validation|validasi|masuk|daftar|magic[-_]link|token=|code=|auth\/|login\?|signup\?|signin\?/i;

  for (const url of foundUrls) {
    if (ignoredLinkKeywords.test(url)) continue;
    if (verifyLinkKeywords.test(url)) {
      verificationLink = url;
      break;
    }
  }

  if (!verificationLink) {
    for (const url of foundUrls) {
      if (!ignoredLinkKeywords.test(url) && (url.includes('/auth') || url.includes('/user') || url.includes('/account'))) {
        verificationLink = url;
        break;
      }
    }
  }

  const otpList = Array.from(otps);
  return {
    primaryOtp: otpList.length ? otpList[0] : null,
    allOtps: otpList,
    verificationLink,
  };
}

function isFalsePositiveOtp(code) {
  if (!code) return true;
  if (!/\d/.test(code)) return true;
  if (/^(19|20)\d{2}$/.test(code)) return true;
  if (['8080', '3000', '5000', '404', '200', '500'].includes(code)) return true;
  return false;
}

function splitTextIntoChunks(text, chunkSize = 3200) {
  if (!text || text.length <= chunkSize) return [text || ''];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= chunkSize) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', chunkSize);
    if (splitIdx === -1 || splitIdx < chunkSize * 0.6) {
      splitIdx = remaining.lastIndexOf(' ', chunkSize);
    }
    if (splitIdx === -1 || splitIdx < chunkSize * 0.5) {
      splitIdx = chunkSize;
    }
    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }
  return chunks;
}


function decodeHtmlEntities(str) {
  const namedEntities = {
    nbsp: ' ',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    hellip: '…',
    mdash: '—',
    ndash: '–',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
    copy: '©',
    reg: '®',
    trade: '™',
  };

  return str
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(namedEntities, key) ? namedEntities[key] : match;
    });
}

// --- HTML Escape & Linkify Helpers ---

function escapeTelegramHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(str = '') {
  return escapeTelegramHtml(str).replace(/"/g, '&quot;');
}

function cleanTrailingUrl(rawUrl) {
  let url = rawUrl;
  let trailing = '';
  while (url.length > 0) {
    const lastChar = url[url.length - 1];
    if (['.', ',', ';', ':', '!', '?', ']', '>', '<', '"', "'"].includes(lastChar)) {
      trailing = lastChar + trailing;
      url = url.slice(0, -1);
    } else if (lastChar === ')') {
      const openCount = (url.match(/\(/g) || []).length;
      const closeCount = (url.match(/\)/g) || []).length;
      if (closeCount > openCount) {
        trailing = lastChar + trailing;
        url = url.slice(0, -1);
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return { url, trailing };
}

function linkifyTelegramHtml(text = '') {
  if (!text) return '';
  const urlRegex = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  let lastIndex = 0;
  let out = '';
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = urlRegex.lastIndex;
    const plainPrefix = text.slice(lastIndex, matchStart);
    out += escapeTelegramHtml(plainPrefix);

    const { url, trailing } = cleanTrailingUrl(match[0]);
    if (url) {
      const href = escapeHtmlAttr(url);
      const label = escapeTelegramHtml(url);
      out += `<a href="${href}">${label}</a>`;
    }
    if (trailing) {
      out += escapeTelegramHtml(trailing);
    }
    lastIndex = matchEnd;
  }

  out += escapeTelegramHtml(text.slice(lastIndex));
  return out;
}

// --- Telegram WebApp initData Cryptographic Validator ---

async function verifyTelegramWebAppData(initDataString, botToken, maxAgeSeconds = 86400 * 30) {
  if (!initDataString || !botToken) return { valid: false, user: null, error: 'Token atau initData kosong' };

  try {
    const cleanToken = String(botToken).trim();
    const params = new URLSearchParams(initDataString);
    const hash = params.get('hash');
    if (!hash) return { valid: false, user: null, error: 'Parameter hash tidak ada' };

    params.delete('hash');

    const keys = Array.from(new Set(params.keys())).sort();
    const dataCheckString = keys.map((key) => `${key}=${params.get(key)}`).join('\n');

    const enc = new TextEncoder();

    const webAppDataKey = await crypto.subtle.importKey(
      'raw',
      enc.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const secretKeyBytes = await crypto.subtle.sign('HMAC', webAppDataKey, enc.encode(cleanToken));

    const secretKey = await crypto.subtle.importKey(
      'raw',
      secretKeyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBytes = await crypto.subtle.sign('HMAC', secretKey, enc.encode(dataCheckString));
    const calculatedHash = Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (calculatedHash.toLowerCase() !== hash.toLowerCase()) {
      return { valid: false, user: null, error: 'Signature mismatch' };
    }

    const authDateStr = params.get('auth_date');
    const authDate = authDateStr ? parseInt(authDateStr, 10) : 0;
    if (maxAgeSeconds > 0 && authDate > 0) {
      const now = Math.floor(Date.now() / 1000);
      if (now - authDate > maxAgeSeconds) {
        return { valid: false, user: null, expired: true, error: 'Sesi kadaluarsa' };
      }
    }

    let user = null;
    const userStr = params.get('user');
    if (userStr) {
      try {
        user = JSON.parse(userStr);
      } catch {
        user = null;
      }
    }

    return {
      valid: true,
      user,
      authDate,
      queryId: params.get('query_id') || null,
    };
  } catch (err) {
    return { valid: false, user: null, error: err.message };
  }
}

// --- Telegram Mini App REST API & Server ---

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

async function authenticateApiRequest(request, env) {
  let initData = request.headers.get('X-Telegram-Init-Data');
  if (!initData) {
    const url = new URL(request.url);
    initData = url.searchParams.get('initData') || url.searchParams.get('tgWebAppData');
  }

  // Support local development / debug bypass if DEV_AUTH_BYPASS is set
  if (!initData && env.DEV_AUTH_BYPASS) {
    const devChatId = parseInt(env.ADMIN_CHAT_ID || '123456789', 10);
    return {
      ok: true,
      isGuest: false,
      user: { id: devChatId, first_name: 'DevUser', username: 'devuser' },
      chatId: devChatId,
      isAdmin: true,
    };
  }

  if (!initData) {
    // Mode Tamu (Preview di browser / tanpa session Telegram)
    return {
      ok: true,
      isGuest: true,
      user: { id: 0, first_name: 'Tamu (Preview)', username: 'guest' },
      chatId: null,
      isAdmin: false,
    };
  }

  const cleanToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const verified = await verifyTelegramWebAppData(initData, cleanToken, 86400 * 30);
  if (!verified.valid || !verified.user) {
    console.warn('[MiniApp Auth Failed]', { error: verified.error, initDataLen: initData.length });
    return {
      ok: false,
      error: `Autentikasi Telegram gagal (${verified.error || (verified.expired ? 'sesi kadaluarsa' : 'signature')}). Buka ulang Mini App dari bot Telegram.`,
      status: 403,
    };
  }

  const chatId = verified.user.id;
  const isAdmin = Boolean(env.ADMIN_CHAT_ID && String(env.ADMIN_CHAT_ID).trim() === String(chatId));

  return {
    ok: true,
    isGuest: false,
    user: verified.user,
    chatId,
    isAdmin,
  };
}

async function handleApiRequest(request, env, ctx, url) {
  const path = url.pathname.replace(/^\/api/, '');

  // 1. QRIS public asset endpoint
  if (path === '/qris' && request.method === 'GET') {
    try {
      const bytes = await env.TEMPMAIL_KV.get('assets:qris', { type: 'arrayBuffer' });
      if (!bytes) {
        return jsonResponse({ ok: false, error: 'QRIS belum dikonfigurasi oleh admin' }, 404);
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=3600',
          ...CORS_HEADERS,
        },
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  }

  // 2. Autentikasi semua endpoint /api lainnya
  const auth = await authenticateApiRequest(request, env);
  if (!auth.ok) {
    return jsonResponse({ ok: false, error: auth.error }, auth.status || 401);
  }

  // Tindakan mutasi (membuat/menghapus) wajib akun Telegram resmi, tolak jika tamu
  if (auth.isGuest && request.method !== 'GET') {
    return jsonResponse({ ok: false, error: 'Silakan buka Mini App melalui bot Telegram @VexTempMail_bot untuk melakukan tindakan ini.' }, 401);
  }

  const chatId = auth.chatId;

  // Track user jika baru pertama kali membuka miniapp
  if (chatId && auth.user) {
    await trackUserAndMaybeNotify(env, chatId, auth.user);
  }

  try {
    // GET /api/bootstrap
    if (path === '/bootstrap' && request.method === 'GET') {
      if (auth.isGuest) {
        const domains = await getDomainList(env);
        return jsonResponse({
          ok: true,
          isGuest: true,
          user: auth.user,
          chatId: null,
          isAdmin: false,
          addresses: [],
          domains,
          inbox: [],
          stats: null,
          qrisAvailable: false,
          config: {
            maxAddresses: MAX_ADDRESSES_PER_USER,
            durationOptionsHours: DURATION_OPTIONS_HOURS,
            maxInboxHistory: MAX_INBOX_HISTORY,
          },
        });
      }

      const [addresses, domains, inboxRaw, qrisBytes] = await Promise.all([
        getUserAddresses(env, chatId),
        getDomainList(env),
        getInbox(env, chatId),
        env.TEMPMAIL_KV.get('assets:qris', { type: 'arrayBuffer' }),
      ]);

      let stats = null;
      if (auth.isAdmin) {
        const [totalUsers, totalAddressesCreated, totalEmailsForwarded] = await Promise.all([
          getCounter(env, 'stats:totalUsers'),
          getCounter(env, 'stats:totalAddressesCreated'),
          getCounter(env, 'stats:totalEmailsForwarded'),
        ]);
        stats = { totalUsers, totalAddressesCreated, totalEmailsForwarded };
      }

      return jsonResponse({
        ok: true,
        user: auth.user,
        chatId,
        isAdmin: auth.isAdmin,
        addresses,
        domains,
        inbox: inboxRaw,
        stats,
        qrisAvailable: Boolean(qrisBytes),
        config: {
          maxAddresses: MAX_ADDRESSES_PER_USER,
          durationOptionsHours: DURATION_OPTIONS_HOURS,
          maxInboxHistory: MAX_INBOX_HISTORY,
        },
      });
    }

    // GET /api/addresses
    if (path === '/addresses' && request.method === 'GET') {
      const [addresses, domains] = await Promise.all([
        getUserAddresses(env, chatId),
        getDomainList(env),
      ]);
      return jsonResponse({ ok: true, addresses, domains });
    }

    // POST /api/addresses
    if (path === '/addresses' && request.method === 'POST') {
      let body = {};
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: 'JSON payload tidak valid' }, 400);
      }

      const durationHours = parseInt(body.durationHours, 10);
      const chosenDuration = DURATION_OPTIONS_HOURS.includes(durationHours) ? durationHours : 24;
      const ttlSeconds = chosenDuration * 3600;

      let customAlias = null;
      if (body.mode === 'custom') {
        customAlias = sanitizeAlias(body.customName || '');
        if (!customAlias) {
          return jsonResponse(
            { ok: false, error: 'Alias harus 3-20 karakter alfanumerik (huruf, angka, titik, strip).' },
            400
          );
        }
      }

      const domain = body.domain ? sanitizeDomain(body.domain) : null;
      const result = await createNewAddress(env, chatId, customAlias, ttlSeconds, domain);
      if (result.error === 'limit') {
        return jsonResponse(
          { ok: false, error: `Batas maksimum ${MAX_ADDRESSES_PER_USER} alamat telah tercapai. Hapus salah satu alamat terlebih dahulu.` },
          400
        );
      }
      if (result.error === 'taken') {
        return jsonResponse(
          { ok: false, error: 'Alamat tersebut sudah digunakan. Silakan gunakan nama alias lain.' },
          400
        );
      }

      await incrementCounter(env, 'stats:totalAddressesCreated');
      const updatedAddresses = await getUserAddresses(env, chatId);
      return jsonResponse({ ok: true, address: result.address, addresses: updatedAddresses }, 201);
    }

    // DELETE /api/addresses
    if (path === '/addresses' && request.method === 'DELETE') {
      let body = {};
      try {
        body = await request.json();
      } catch {
        const addrParam = url.searchParams.get('address');
        const allParam = url.searchParams.get('all');
        body = { address: addrParam, all: allParam === 'true' };
      }

      if (body.all) {
        await deleteAllAddresses(env, chatId);
        return jsonResponse({ ok: true, addresses: [] });
      }

      if (!body.address) {
        return jsonResponse({ ok: false, error: 'Parameter address diperlukan.' }, 400);
      }

      const success = await deleteAddress(env, chatId, body.address);
      if (!success) {
        return jsonResponse({ ok: false, error: 'Alamat tidak ditemukan atau bukan milik Anda.' }, 404);
      }

      const remaining = await getUserAddresses(env, chatId);
      return jsonResponse({ ok: true, addresses: remaining });
    }

    // POST /api/addresses/extend
    if (path === '/addresses/extend' && request.method === 'POST') {
      let body = {};
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: 'JSON payload tidak valid' }, 400);
      }

      if (!body.address) {
        return jsonResponse({ ok: false, error: 'Parameter address diperlukan.' }, 400);
      }

      const success = await extendAddress(env, chatId, body.address);
      if (!success) {
        return jsonResponse({ ok: false, error: 'Gagal memperpanjang alamat.' }, 400);
      }

      const updated = await getUserAddresses(env, chatId);
      return jsonResponse({ ok: true, addresses: updated });
    }

    // GET /api/inbox
    if (path === '/inbox' && request.method === 'GET') {
      const allInbox = await getInbox(env, chatId);
      const addressFilter = url.searchParams.get('address');
      const filtered = addressFilter ? allInbox.filter((item) => item.address === addressFilter) : allInbox;
      return jsonResponse({ ok: true, inbox: filtered });
    }

    // DELETE /api/inbox
    if (path === '/inbox' && request.method === 'DELETE') {
      let body = {};
      try {
        body = await request.json();
      } catch {
        const idParam = url.searchParams.get('id');
        const clearAllParam = url.searchParams.get('clearAll');
        body = { id: idParam, clearAll: clearAllParam === 'true' };
      }

      if (body.clearAll) {
        await env.TEMPMAIL_KV.delete(`inbox:${chatId}`);
        return jsonResponse({ ok: true, inbox: [] });
      }

      if (body.id) {
        const currentInbox = await getInbox(env, chatId);
        const updated = currentInbox.filter(
          (item) => item.id !== body.id && (!item.receivedAt || String(item.receivedAt) !== String(body.id))
        );
        await env.TEMPMAIL_KV.put(`inbox:${chatId}`, JSON.stringify(updated), {
          expirationTtl: INBOX_TTL_SECONDS,
        });
        return jsonResponse({ ok: true, inbox: updated });
      }

      return jsonResponse({ ok: false, error: 'Parameter id atau clearAll diperlukan.' }, 400);
    }

    // --- Admin Endpoints ---
    if (path.startsWith('/admin/')) {
      if (!auth.isAdmin) {
        return jsonResponse({ ok: false, error: 'Akses ditolak: Hanya untuk Admin.' }, 403);
      }

      if (path === '/admin/stats' && request.method === 'GET') {
        const [totalUsers, totalAddressesCreated, totalEmailsForwarded] = await Promise.all([
          getCounter(env, 'stats:totalUsers'),
          getCounter(env, 'stats:totalAddressesCreated'),
          getCounter(env, 'stats:totalEmailsForwarded'),
        ]);
        return jsonResponse({ ok: true, stats: { totalUsers, totalAddressesCreated, totalEmailsForwarded } });
      }

      if (path === '/admin/domains' && request.method === 'GET') {
        const [allDomains, extraRaw] = await Promise.all([
          getDomainList(env),
          env.TEMPMAIL_KV.get('config:extraDomains'),
        ]);
        let extraDomains = [];
        try {
          extraDomains = extraRaw ? JSON.parse(extraRaw) : [];
        } catch {
          extraDomains = [];
        }
        return jsonResponse({ ok: true, allDomains, extraDomains });
      }

      if (path === '/admin/domains' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const domain = sanitizeDomain(body.domain);
        if (!domain) {
          return jsonResponse({ ok: false, error: 'Format domain tidak valid.' }, 400);
        }
        const added = await addExtraDomain(env, domain);
        if (!added) {
          return jsonResponse({ ok: false, error: 'Domain tersebut sudah terdaftar.' }, 400);
        }
        const all = await getDomainList(env);
        return jsonResponse({ ok: true, domain, allDomains: all });
      }

      if (path === '/admin/domains' && request.method === 'DELETE') {
        const body = await request.json().catch(() => ({}));
        const domain = sanitizeDomain(body.domain || url.searchParams.get('domain'));
        if (!domain) {
          return jsonResponse({ ok: false, error: 'Format domain tidak valid.' }, 400);
        }
        const removed = await removeExtraDomain(env, domain);
        if (!removed) {
          return jsonResponse({ ok: false, error: 'Domain tidak ditemukan di daftar domain tambahan.' }, 404);
        }
        const all = await getDomainList(env);
        return jsonResponse({ ok: true, domain, allDomains: all });
      }

      return jsonResponse({ ok: false, error: 'Admin endpoint tidak ditemukan.' }, 404);
    }

    return jsonResponse({ ok: false, error: 'Endpoint API tidak ditemukan.' }, 404);
  } catch (err) {
    console.error('API Error:', err);
    return jsonResponse({ ok: false, error: err.message || 'Internal Server Error' }, 500);
  }
}

function renderMiniAppResponse(env) {
  const html = renderMiniAppHtml(env);
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

function renderMiniAppHtml(env) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>VexTempMail</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      --bg-primary: #080c14;
      --bg-secondary: #0f172a;
      --surface-glass: rgba(255, 255, 255, 0.05);
      --surface-glass-hover: rgba(255, 255, 255, 0.09);
      --surface-glass-active: rgba(255, 255, 255, 0.14);
      --border-glass: rgba(255, 255, 255, 0.10);
      --border-glass-bright: rgba(255, 255, 255, 0.22);
      --accent-cyan: #00f2fe;
      --accent-violet: #7f00ff;
      --accent-gradient: linear-gradient(135deg, #00f2fe 0%, #7f00ff 100%);
      --accent-glow: 0 0 20px rgba(0, 242, 254, 0.35);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --radius-sm: 8px;
      --radius-md: 14px;
      --radius-lg: 20px;
      --radius-full: 9999px;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: "SF Mono", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }

    body {
      background: var(--bg-primary);
      background-image: 
        radial-gradient(at 0% 0%, rgba(127, 0, 255, 0.18) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(0, 242, 254, 0.15) 0px, transparent 50%);
      background-attachment: fixed;
      color: var(--text-main);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
      min-height: 100vh;
      overflow-x: hidden;
      padding-bottom: 85px;
    }

    /* Glass utility */
    .glass-panel {
      background: var(--surface-glass);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border-glass);
      border-radius: var(--radius-md);
    }

    /* Header */
    header {
      position: sticky;
      top: 0;
      z-index: 50;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(8, 12, 20, 0.82);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border-glass);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .brand-logo {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      background: var(--accent-gradient);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      box-shadow: var(--accent-glow);
    }

    .brand-title {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.3px;
      background: linear-gradient(135deg, #ffffff 40%, #00f2fe 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .user-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      border-radius: var(--radius-full);
      background: var(--surface-glass);
      border: 1px solid var(--border-glass);
      font-size: 12px;
      color: var(--text-muted);
    }

    .refresh-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 6px;
      border-radius: var(--radius-sm);
      transition: all 0.2s;
    }

    .refresh-btn:active {
      transform: scale(0.9);
      color: var(--accent-cyan);
    }

    .rotating {
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      100% { transform: rotate(360deg); }
    }

    /* Container */
    .container {
      max-width: 600px;
      margin: 0 auto;
      padding: 16px;
    }

    /* Views */
    .view {
      display: none;
      animation: fadeIn 0.25s ease-out;
    }

    .view.active {
      display: block;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 18px;
      font-size: 13px;
      font-weight: 600;
      border-radius: var(--radius-md);
      border: 1px solid transparent;
      cursor: pointer;
      transition: all 0.2s;
      outline: none;
      text-decoration: none;
    }

    .btn:active {
      transform: scale(0.97);
    }

    .btn-primary {
      background: var(--accent-gradient);
      color: #fff;
      box-shadow: 0 4px 16px rgba(0, 242, 254, 0.25);
    }

    .btn-glass {
      background: var(--surface-glass);
      border-color: var(--border-glass);
      color: var(--text-main);
    }

    .btn-glass:hover {
      background: var(--surface-glass-hover);
      border-color: var(--border-glass-bright);
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }

    .btn-sm {
      padding: 6px 12px;
      font-size: 12px;
      border-radius: var(--radius-sm);
    }

    .btn-block {
      width: 100%;
    }

    /* Active Address Card */
    .address-card {
      background: var(--surface-glass);
      border: 1px solid var(--border-glass);
      border-radius: var(--radius-md);
      padding: 14px 16px;
      margin-bottom: 12px;
      position: relative;
      overflow: hidden;
      transition: border-color 0.2s;
    }

    .address-card:hover {
      border-color: var(--border-glass-bright);
    }

    .address-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }

    .address-badge {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2px 8px;
      border-radius: var(--radius-full);
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .address-text {
      font-family: var(--font-mono);
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      word-break: break-all;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .address-text:hover {
      color: var(--accent-cyan);
    }

    .timer-bar-container {
      margin: 10px 0;
      background: rgba(255, 255, 255, 0.08);
      height: 4px;
      border-radius: 2px;
      overflow: hidden;
    }

    .timer-bar {
      height: 100%;
      background: var(--accent-gradient);
      width: 100%;
      transition: width 1s linear;
    }

    .timer-text {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-dim);
    }

    .address-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }

    /* Inbox List */
    .inbox-item {
      background: var(--surface-glass);
      border: 1px solid var(--border-glass);
      border-radius: var(--radius-md);
      padding: 14px 16px;
      margin-bottom: 10px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .inbox-item:hover, .inbox-item:active {
      background: var(--surface-glass-hover);
      border-color: var(--border-glass-bright);
      transform: translateY(-1px);
    }

    .inbox-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 4px;
      gap: 8px;
    }

    .inbox-from {
      font-weight: 600;
      color: #fff;
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .inbox-time {
      font-size: 11px;
      color: var(--text-dim);
      white-space: nowrap;
    }

    .inbox-subject {
      font-size: 13px;
      color: var(--text-main);
      font-weight: 500;
      margin-bottom: 6px;
    }

    .inbox-snippet {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .inbox-otp-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(0, 242, 254, 0.12);
      border: 1px solid rgba(0, 242, 254, 0.3);
      color: var(--accent-cyan);
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      margin-top: 8px;
    }

    /* Email Reader (Gmail style) */
    .reader-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border-glass);
    }

    .reader-header {
      background: var(--surface-glass);
      border: 1px solid var(--border-glass);
      border-radius: var(--radius-md);
      padding: 16px;
      margin-bottom: 14px;
    }

    .reader-subject {
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 12px;
      line-height: 1.3;
    }

    .reader-meta-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--text-muted);
    }

    .reader-meta-row span strong {
      color: var(--text-main);
    }

    /* Pinned OTP Card */
    .otp-hero-card {
      background: linear-gradient(135deg, rgba(0, 242, 254, 0.12) 0%, rgba(127, 0, 255, 0.18) 100%);
      border: 1px solid rgba(0, 242, 254, 0.4);
      box-shadow: 0 0 25px rgba(0, 242, 254, 0.15);
      border-radius: var(--radius-md);
      padding: 16px;
      margin-bottom: 16px;
      text-align: center;
    }

    .otp-hero-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--accent-cyan);
      margin-bottom: 6px;
    }

    .otp-hero-code {
      font-family: var(--font-mono);
      font-size: 30px;
      font-weight: 800;
      letter-spacing: 4px;
      color: #ffffff;
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      display: inline-block;
      user-select: all;
      margin-bottom: 12px;
      text-shadow: 0 0 12px rgba(0, 242, 254, 0.5);
    }

    .reader-toggle-wrap {
      display: flex;
      background: rgba(255, 255, 255, 0.06);
      padding: 3px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-glass);
      margin-bottom: 14px;
    }

    .reader-toggle-btn {
      flex: 1;
      padding: 8px;
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      border: none;
      background: transparent;
      color: var(--text-muted);
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .reader-toggle-btn.active {
      background: var(--surface-glass-active);
      color: #fff;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }

    /* Iframe Sheet container */
    .email-sheet {
      background: #ffffff;
      border-radius: var(--radius-md);
      overflow: hidden;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
      min-height: 400px;
    }

    .email-iframe {
      width: 100%;
      height: 500px;
      border: none;
      background: #ffffff;
      display: block;
    }

    .clean-text-sheet {
      background: var(--surface-glass);
      border: 1px solid var(--border-glass);
      border-radius: var(--radius-md);
      padding: 16px;
      color: #e2e8f0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
      line-height: 1.6;
    }

    .clean-text-sheet a {
      color: var(--accent-cyan);
      text-decoration: underline;
      text-underline-offset: 2px;
      word-break: break-all;
      cursor: pointer;
      transition: color 0.2s;
    }

    .clean-text-sheet a:hover {
      color: #ffffff;
      text-shadow: 0 0 8px rgba(0, 242, 254, 0.6);
    }

    /* Bottom Navigation Dock */
    .nav-dock {
      position: fixed;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%);
      width: calc(100% - 24px);
      max-width: 500px;
      height: 62px;
      background: rgba(15, 23, 42, 0.88);
      backdrop-filter: blur(25px);
      -webkit-backdrop-filter: blur(25px);
      border: 1px solid var(--border-glass-bright);
      border-radius: var(--radius-full);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: space-around;
      padding: 0 8px;
      z-index: 100;
    }

    .nav-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      color: var(--text-dim);
      font-size: 10px;
      font-weight: 600;
      gap: 3px;
      padding: 6px 12px;
      border-radius: var(--radius-full);
      cursor: pointer;
      position: relative;
      transition: all 0.2s;
    }

    .nav-item.active {
      color: var(--accent-cyan);
    }

    .nav-item.active .nav-icon {
      transform: scale(1.1);
    }

    .nav-icon {
      font-size: 18px;
      transition: transform 0.2s;
    }

    .nav-badge {
      position: absolute;
      top: 2px;
      right: 6px;
      background: var(--accent-gradient);
      color: #fff;
      font-size: 9px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 9px;
      min-width: 14px;
      text-align: center;
    }

    /* Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      z-index: 200;
      display: none;
      align-items: flex-end;
      justify-content: center;
    }

    .modal-overlay.active {
      display: flex;
    }

    .modal-sheet {
      background: var(--bg-secondary);
      border: 1px solid var(--border-glass-bright);
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      width: 100%;
      max-width: 550px;
      max-height: 85vh;
      overflow-y: auto;
      padding: 20px 20px 30px;
      animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes slideUp {
      from { transform: translateY(100%); }
      to { transform: translateY(0); }
    }

    .modal-title {
      font-size: 17px;
      font-weight: 700;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .modal-close {
      background: none;
      border: none;
      color: var(--text-dim);
      font-size: 20px;
      cursor: pointer;
    }

    .form-group {
      margin-bottom: 14px;
    }

    .form-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .form-input, .form-select {
      width: 100%;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: var(--radius-md);
      padding: 10px 14px;
      color: #fff;
      font-family: inherit;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
    }

    .form-input:focus, .form-select:focus {
      border-color: var(--accent-cyan);
    }

    .pill-group {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .pill-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: var(--text-muted);
      padding: 6px 12px;
      border-radius: var(--radius-full);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }

    .pill-btn.active {
      background: var(--accent-gradient);
      color: #fff;
      border-color: transparent;
    }

    /* Toast */
    #toast {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%) translateY(-100px);
      background: rgba(15, 23, 42, 0.95);
      backdrop-filter: blur(15px);
      -webkit-backdrop-filter: blur(15px);
      border: 1px solid var(--accent-cyan);
      box-shadow: 0 8px 25px rgba(0, 242, 254, 0.3);
      color: #fff;
      padding: 10px 20px;
      border-radius: var(--radius-full);
      font-size: 13px;
      font-weight: 600;
      z-index: 300;
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: none;
    }

    #toast.show {
      transform: translateX(-50%) translateY(0);
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-dim);
    }

    .empty-icon {
      font-size: 44px;
      margin-bottom: 12px;
      opacity: 0.8;
    }

    .empty-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-main);
      margin-bottom: 6px;
    }

    .empty-desc {
      font-size: 12px;
      color: var(--text-muted);
      max-width: 280px;
      margin: 0 auto 16px;
    }
  </style>
</head>
<body>

  <!-- Toast Notification -->
  <div id="toast">
    <span id="toast-icon">✨</span>
    <span id="toast-msg">Tersalin ke clipboard!</span>
  </div>

  <!-- Header -->
  <header>
    <div class="brand">
      <div class="brand-logo">⚡</div>
      <div class="brand-title">VexTempMail</div>
    </div>
    <div style="display: flex; align-items: center; gap: 10px;">
      <div class="user-pill" id="user-display">
        <span id="user-name">Loading...</span>
      </div>
      <button class="refresh-btn" id="btn-refresh" title="Muat Ulang Data">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
      </button>
    </div>
  </header>

  <div class="container">

    <!-- View: Kotak Masuk (Inbox) -->
    <div id="view-inbox" class="view active">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
        <h2 style="font-size: 16px; font-weight: 700;">Kotak Masuk</h2>
        <button class="btn btn-glass btn-sm" id="btn-clear-inbox">Hapus Semua</button>
      </div>

      <div id="inbox-filter-bar" style="margin-bottom: 12px; display: none;">
        <select class="form-select" id="inbox-addr-filter">
          <option value="">Semua Alamat</option>
        </select>
      </div>

      <div id="inbox-list">
        <!-- Rendered items -->
      </div>
    </div>

    <!-- View: Alamat Saya -->
    <div id="view-addresses" class="view">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
        <h2 style="font-size: 16px; font-weight: 700;">Alamat Saya</h2>
        <button class="btn btn-primary btn-sm" id="btn-open-create">+ Buat Alamat</button>
      </div>

      <div id="address-list">
        <!-- Rendered addresses -->
      </div>
    </div>

    <!-- View: Detail Email (Gmail Style) -->
    <div id="view-reader" class="view">
      <div class="reader-toolbar">
        <button class="btn btn-glass btn-sm" id="reader-back-btn">← Kembali</button>
        <button class="btn btn-danger btn-sm" id="reader-delete-btn">🗑️ Hapus</button>
      </div>

      <div class="reader-header">
        <h1 class="reader-subject" id="reader-subject">(Subjek)</h1>
        <div class="reader-meta-row">
          <span><strong>Dari:</strong> <span id="reader-from">...</span></span>
          <span><strong>Untuk:</strong> <span id="reader-to">...</span></span>
          <span><strong>Waktu:</strong> <span id="reader-date">...</span></span>
        </div>
      </div>

      <!-- Pinned OTP Banner if detected -->
      <div id="reader-otp-card" class="otp-hero-card" style="display: none;">
        <div class="otp-hero-title">🔐 KODE OTP / VERIFIKASI</div>
        <div class="otp-hero-code" id="reader-otp-code">------</div>
        <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
          <button class="btn btn-primary btn-sm" id="btn-copy-reader-otp">📋 Salin Kode</button>
          <a class="btn btn-glass btn-sm" id="btn-open-verify-link" href="#" target="_blank" style="display: none;">🌐 Buka Tautan Verifikasi</a>
        </div>
      </div>

      <!-- Mode Toggle: Format Asli vs Teks Bersih -->
      <div class="reader-toggle-wrap">
        <button class="reader-toggle-btn active" id="toggle-view-html">📧 Format Asli (HTML)</button>
        <button class="reader-toggle-btn" id="toggle-view-text">📝 Teks Bersih</button>
      </div>

      <!-- HTML Sheet (Gmail iframe) -->
      <div id="reader-html-container" class="email-sheet">
        <iframe id="reader-iframe" class="email-iframe" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"></iframe>
      </div>

      <!-- Clean Text Sheet -->
      <div id="reader-text-container" class="clean-text-sheet" style="display: none;">
        <div id="reader-clean-text">...</div>
      </div>
    </div>

    <!-- View: Donasi -->
    <div id="view-donate" class="view">
      <div style="text-align: center; margin-bottom: 20px;">
        <h2 style="font-size: 18px; font-weight: 700; margin-bottom: 6px;">Dukung Server Bot</h2>
        <p style="font-size: 13px; color: var(--text-muted);">Donasi sukarela untuk biaya perpanjangan domain & Cloudflare Worker.</p>
      </div>

      <div class="glass-panel" style="padding: 24px; text-align: center; max-width: 380px; margin: 0 auto;">
        <div id="qris-img-container" style="background: #fff; padding: 12px; border-radius: var(--radius-md); display: inline-block; margin-bottom: 16px;">
          <img id="qris-img" src="/api/qris" alt="QRIS Donasi" style="max-width: 260px; width: 100%; height: auto; border-radius: 4px; display: block;" onerror="handleQrisError()">
        </div>
        <p style="font-size: 12px; color: var(--text-muted); line-height: 1.5;">
          Scan QRIS di atas dengan GoPay, OVO, Dana, ShopeePay, BCA, atau mobile banking lainnya. Terima kasih banyak atas dukungannya! 🙏
        </p>
      </div>
    </div>

    <!-- View: Admin Panel (if admin) -->
    <div id="view-admin" class="view">
      <h2 style="font-size: 18px; font-weight: 700; margin-bottom: 16px;">Panel Admin</h2>

      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px;">
        <div class="glass-panel" style="padding: 12px; text-align: center;">
          <div style="font-size: 11px; color: var(--text-dim); margin-bottom: 4px;">PENGGUNA</div>
          <div id="admin-stat-users" style="font-size: 20px; font-weight: 800; color: var(--accent-cyan);">0</div>
        </div>
        <div class="glass-panel" style="padding: 12px; text-align: center;">
          <div style="font-size: 11px; color: var(--text-dim); margin-bottom: 4px;">ALAMAT</div>
          <div id="admin-stat-addresses" style="font-size: 20px; font-weight: 800; color: #a855f7;">0</div>
        </div>
        <div class="glass-panel" style="padding: 12px; text-align: center;">
          <div style="font-size: 11px; color: var(--text-dim); margin-bottom: 4px;">EMAIL MASUK</div>
          <div id="admin-stat-emails" style="font-size: 20px; font-weight: 800; color: var(--success);">0</div>
        </div>
      </div>

      <div class="glass-panel" style="padding: 16px;">
        <h3 style="font-size: 14px; font-weight: 600; margin-bottom: 12px;">Kelola Domain Tambahan</h3>
        <div style="display: flex; gap: 8px; margin-bottom: 12px;">
          <input type="text" class="form-input" id="admin-new-domain" placeholder="contoh: mail.domainku.com">
          <button class="btn btn-primary btn-sm" id="admin-add-domain-btn">+ Tambah</button>
        </div>
        <div id="admin-domains-list">
          <!-- Domain list -->
        </div>
      </div>
    </div>

  </div>

  <!-- Modal: Buat Alamat Baru -->
  <div class="modal-overlay" id="modal-create">
    <div class="modal-sheet">
      <div class="modal-title">
        <span>Buat Alamat Baru</span>
        <button class="modal-close" id="modal-close-btn">&times;</button>
      </div>

      <div class="form-group">
        <label class="form-label">Mode Pembuatan</label>
        <div class="pill-group">
          <button class="pill-btn active" id="mode-auto-btn">🎲 Acak Cepat</button>
          <button class="pill-btn" id="mode-custom-btn">✏️ Kustom Alias</button>
        </div>
      </div>

      <div class="form-group" id="custom-alias-wrap" style="display: none;">
        <label class="form-label">Nama Alias</label>
        <input type="text" class="form-input" id="custom-alias-input" placeholder="contoh: merahbiru">
        <span style="font-size: 11px; color: var(--text-dim); margin-top: 4px; display: block;">3-20 karakter alfanumerik.</span>
      </div>

      <div class="form-group">
        <label class="form-label">Pilih Domain</label>
        <select class="form-select" id="create-domain-select">
          <!-- Populated dynamically -->
        </select>
      </div>

      <div class="form-group">
        <label class="form-label">Masa Aktif</label>
        <div class="pill-group" id="duration-pills">
          <button class="pill-btn" data-hours="6">6 Jam</button>
          <button class="pill-btn" data-hours="12">12 Jam</button>
          <button class="pill-btn active" data-hours="24">24 Jam</button>
          <button class="pill-btn" data-hours="48">48 Jam</button>
          <button class="pill-btn" data-hours="72">72 Jam</button>
        </div>
      </div>

      <button class="btn btn-primary btn-block" id="btn-submit-create" style="margin-top: 18px;">
        🚀 Buat Alamat Sekarang
      </button>
    </div>
  </div>

  <!-- Bottom Navigation Dock -->
  <nav class="nav-dock">
    <button class="nav-item active" data-view="inbox">
      <span class="nav-icon">📬</span>
      <span>Kotak Masuk</span>
      <span class="nav-badge" id="badge-inbox" style="display: none;">0</span>
    </button>
    <button class="nav-item" data-view="addresses">
      <span class="nav-icon">📮</span>
      <span>Alamat</span>
      <span class="nav-badge" id="badge-addresses" style="display: none;">0</span>
    </button>
    <button class="nav-item" id="nav-btn-create">
      <span class="nav-icon">➕</span>
      <span>Buat</span>
    </button>
    <button class="nav-item" data-view="donate">
      <span class="nav-icon">☕</span>
      <span>Donasi</span>
    </button>
    <button class="nav-item" data-view="admin" id="nav-item-admin" style="display: none;">
      <span class="nav-icon">⚙️</span>
      <span>Admin</span>
    </button>
  </nav>

  <script>
    // --- Application State ---
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      try {
        tg.setHeaderColor('#080c14');
        tg.setBackgroundColor('#080c14');
      } catch (e) {}
    }

    const state = {
      user: null,
      isAdmin: false,
      addresses: [],
      domains: [],
      inbox: [],
      stats: null,
      currentView: 'inbox',
      currentEmail: null,
      createMode: 'auto',
      selectedDuration: 24,
      filterAddress: '',
    };

    function haptic(type = 'light') {
      if (tg?.HapticFeedback) {
        if (type === 'success' || type === 'error' || type === 'warning') {
          tg.HapticFeedback.notificationOccurred(type);
        } else {
          tg.HapticFeedback.impactOccurred(type);
        }
      }
    }

    function showToast(msg, icon = '✨') {
      const toast = document.getElementById('toast');
      document.getElementById('toast-msg').textContent = msg;
      document.getElementById('toast-icon').textContent = icon;
      toast.classList.add('show');
      haptic('light');
      setTimeout(() => toast.classList.remove('show'), 2400);
    }

    async function copyToClipboard(text, label = 'Teks') {
      try {
        await navigator.clipboard.writeText(text);
        showToast(\`\${label} disalin!\`, '📋');
        haptic('success');
      } catch (err) {
        const inp = document.createElement('input');
        inp.value = text;
        document.body.appendChild(inp);
        inp.select();
        document.execCommand('copy');
        document.body.removeChild(inp);
        showToast(\`\${label} disalin!\`, '📋');
        haptic('success');
      }
    }

    function getRawInitData() {
      // 1. Dari Telegram WebApp SDK
      if (window.Telegram?.WebApp?.initData) {
        const d = window.Telegram.WebApp.initData;
        try { sessionStorage.setItem('vex_init_data', d); } catch (e) {}
        return d;
      }
      // 2. Dari URL hash (#tgWebAppData=...)
      if (window.location.hash) {
        try {
          const hashStr = window.location.hash.replace(/^#/, '');
          const params = new URLSearchParams(hashStr);
          const hashData = params.get('tgWebAppData');
          if (hashData) {
            try { sessionStorage.setItem('vex_init_data', hashData); } catch (e) {}
            return hashData;
          }
        } catch (e) {}
      }
      // 3. Dari URL query string (?tgWebAppData=... atau ?initData=...)
      if (window.location.search) {
        try {
          const searchParams = new URLSearchParams(window.location.search);
          const qData = searchParams.get('tgWebAppData') || searchParams.get('initData');
          if (qData) {
            try { sessionStorage.setItem('vex_init_data', qData); } catch (e) {}
            return qData;
          }
        } catch (e) {}
      }
      // 4. Dari sessionStorage cache
      try {
        const cached = sessionStorage.getItem('vex_init_data');
        if (cached) return cached;
      } catch (e) {}

      return '';
    }

    function getAuthHeaders() {
      const initData = getRawInitData();
      return {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      };
    }

    // --- API Calls ---
    async function apiFetch(endpoint, options = {}) {
      const headers = { ...getAuthHeaders(), ...(options.headers || {}) };
      const res = await fetch('/api' + endpoint, { ...options, headers });
      return res.json();
    }

    async function loadBootstrapData() {
      const btnRefresh = document.getElementById('btn-refresh');
      btnRefresh.classList.add('rotating');
      try {
        const data = await apiFetch('/bootstrap');
        if (!data.ok) throw new Error(data.error || 'Gagal memuat data');

        state.isGuest = Boolean(data.isGuest);
        state.user = data.user;
        state.isAdmin = Boolean(data.isAdmin);
        state.addresses = data.addresses || [];
        state.domains = data.domains || [];
        state.inbox = data.inbox || [];
        state.stats = data.stats;

        // UI Updates
        if (state.isGuest) {
          document.getElementById('user-name').textContent = 'Tamu (Preview)';
        } else {
          document.getElementById('user-name').textContent = state.user?.first_name || 'Pengguna';
        }

        if (state.isAdmin) {
          document.getElementById('nav-item-admin').style.display = 'flex';
          renderAdminStats();
        } else {
          document.getElementById('nav-item-admin').style.display = 'none';
        }

        renderAddresses();
        renderInbox();
        populateDomainSelects();

        // Jika mode tamu tapi Telegram SDK tersedia, coba re-fetch sekali lagi setelah 400ms jika initData terlambat muncul
        if (state.isGuest && window.Telegram?.WebApp && !window._retriedBootstrap) {
          window._retriedBootstrap = true;
          setTimeout(() => {
            if (getRawInitData()) {
              loadBootstrapData();
            }
          }, 400);
        }
      } catch (err) {
        console.error('loadBootstrapData error:', err);
        document.getElementById('user-name').textContent = 'Gagal Memuat';
        showToast('Gagal memuat: ' + err.message, '⚠️');
        renderErrorState(err.message);
      } finally {
        setTimeout(() => btnRefresh.classList.remove('rotating'), 400);
      }
    }

    function renderErrorState(errorMessage = '') {
      const inboxContainer = document.getElementById('inbox-list');
      const addrContainer = document.getElementById('address-list');

      const errorHtml = \`
        <div class="empty-state" style="padding: 30px 16px; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: var(--radius-md);">
          <div class="empty-icon" style="font-size: 42px; margin-bottom: 8px;">⚠️</div>
          <div class="empty-title" style="color: #fca5a5;">Gagal Memuat Data</div>
          <div class="empty-desc" style="max-width: 320px; margin: 0 auto 16px; color: #fecaca; font-size: 13px;">\${escapeHtml(errorMessage)}</div>
          <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
            <button class="btn btn-primary btn-sm" onclick="loadBootstrapData()">🔄 Coba Muat Ulang</button>
            <a href="https://t.me/VexTempMail_bot" class="btn btn-glass btn-sm" style="text-decoration: none;">🤖 Buka di Telegram</a>
          </div>
        </div>
      \`;

      if (inboxContainer) inboxContainer.innerHTML = errorHtml;
      if (addrContainer) addrContainer.innerHTML = errorHtml;
    }

    // --- View Navigation ---
    function switchView(viewName) {
      haptic('light');
      state.currentView = viewName;
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const activeEl = document.getElementById(\`view-\${viewName}\`);
      if (activeEl) activeEl.classList.add('active');

      document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.toggle('active', n.dataset.view === viewName);
      });

      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.addEventListener('click', () => switchView(item.dataset.view));
    });

    document.getElementById('btn-refresh').addEventListener('click', loadBootstrapData);

    // --- Addresses Rendering ---
    function renderAddresses() {
      const container = document.getElementById('address-list');
      const badge = document.getElementById('badge-addresses');

      badge.textContent = state.addresses.length;
      badge.style.display = state.addresses.length > 0 ? 'inline-block' : 'none';

      if (state.isGuest) {
        container.innerHTML = \`
          <div class="empty-state" style="padding: 30px 16px; background: rgba(255, 255, 255, 0.03); border: 1px dashed var(--border-glass-bright); border-radius: var(--radius-md);">
            <div class="empty-icon" style="font-size: 44px; margin-bottom: 10px;">📮</div>
            <div class="empty-title">Kelola Alamat di Telegram</div>
            <div class="empty-desc" style="max-width: 320px; margin: 0 auto 16px; font-size: 13px; color: var(--text-muted);">
              Alamat email Anda tersimpan aman dan terhubung dengan akun Telegram Anda. Silakan buka melalui bot Telegram untuk membuat alamat email.
            </div>
            <a href="https://t.me/VexTempMail_bot" class="btn btn-glass btn-sm" style="text-decoration: none;">
              <span>🤖 Buka @VexTempMail_bot</span>
            </a>
          </div>
        \`;
        return;
      }

      if (state.addresses.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">📮</div>
            <div class="empty-title">Belum Ada Alamat Aktif</div>
            <div class="empty-desc">Buat alamat email sementara Anda untuk menerima email dan kode verifikasi.</div>
            <button class="btn btn-primary btn-sm" onclick="openCreateModal()">+ Buat Alamat Sekarang</button>
          </div>
        \`;
        return;
      }

      const now = Date.now();
      container.innerHTML = state.addresses.map(addr => {
        const remainingMs = Math.max(0, addr.expiresAt - now);
        const totalDurationMs = (addr.ttlSeconds || 86400) * 1000;
        const percent = Math.min(100, Math.max(0, (remainingMs / totalDurationMs) * 100));

        const hoursLeft = Math.floor(remainingMs / (1000 * 60 * 60));
        const minsLeft = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
        const timeLabel = remainingMs > 0 ? \`\${hoursLeft}j \${minsLeft}m tersisa\` : 'Kadaluarsa';

        return \`
          <div class="address-card">
            <div class="address-header">
              <span class="address-badge">\${remainingMs > 0 ? 'Aktif' : 'Expired'}</span>
              <span class="timer-text">\${timeLabel}</span>
            </div>
            <div class="address-text" onclick="copyToClipboard('\${addr.address}', 'Alamat')">
              <span>\${addr.address}</span>
              <span style="font-size: 13px; opacity: 0.6;">📋</span>
            </div>
            <div class="timer-bar-container">
              <div class="timer-bar" style="width: \${percent}%;"></div>
            </div>
            <div class="address-actions">
              <button class="btn btn-glass btn-sm" onclick="copyToClipboard('\${addr.address}', 'Alamat')">📋 Salin</button>
              <button class="btn btn-glass btn-sm" onclick="extendAddress('\${addr.address}')">⏳ +24 Jam</button>
              <button class="btn btn-danger btn-sm" onclick="deleteAddress('\${addr.address}')">🗑️ Hapus</button>
            </div>
          </div>
        \`;
      }).join('');
    }

    async function extendAddress(address) {
      haptic('light');
      try {
        const res = await apiFetch('/addresses/extend', {
          method: 'POST',
          body: JSON.stringify({ address }),
        });
        if (!res.ok) throw new Error(res.error);
        state.addresses = res.addresses;
        renderAddresses();
        showToast('Masa aktif berhasil diperpanjang +24 Jam!', '⏳');
      } catch (err) {
        showToast('Gagal perpanjang: ' + err.message, '⚠️');
      }
    }

    async function deleteAddress(address) {
      if (!confirm(\`Hapus alamat \${address}?\`)) return;
      haptic('warning');
      try {
        const res = await apiFetch('/addresses', {
          method: 'DELETE',
          body: JSON.stringify({ address }),
        });
        if (!res.ok) throw new Error(res.error);
        state.addresses = res.addresses;
        renderAddresses();
        showToast('Alamat berhasil dihapus.', '🗑️');
      } catch (err) {
        showToast('Gagal menghapus: ' + err.message, '⚠️');
      }
    }

    // --- Modal Create Address ---
    function openCreateModal() {
      haptic('light');
      document.getElementById('modal-create').classList.add('active');
    }

    function closeCreateModal() {
      document.getElementById('modal-create').classList.remove('active');
    }

    document.getElementById('btn-open-create').addEventListener('click', openCreateModal);
    document.getElementById('nav-btn-create').addEventListener('click', openCreateModal);
    document.getElementById('modal-close-btn').addEventListener('click', closeCreateModal);

    document.getElementById('mode-auto-btn').addEventListener('click', () => {
      state.createMode = 'auto';
      document.getElementById('mode-auto-btn').classList.add('active');
      document.getElementById('mode-custom-btn').classList.remove('active');
      document.getElementById('custom-alias-wrap').style.display = 'none';
    });

    document.getElementById('mode-custom-btn').addEventListener('click', () => {
      state.createMode = 'custom';
      document.getElementById('mode-custom-btn').classList.add('active');
      document.getElementById('mode-auto-btn').classList.remove('active');
      document.getElementById('custom-alias-wrap').style.display = 'block';
    });

    document.querySelectorAll('#duration-pills .pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#duration-pills .pill-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.selectedDuration = parseInt(btn.dataset.hours, 10);
      });
    });

    function populateDomainSelects() {
      const select = document.getElementById('create-domain-select');
      select.innerHTML = state.domains.map(d => \`<option value="\${d}">\${d}</option>\`).join('');
    }

    document.getElementById('btn-submit-create').addEventListener('click', async () => {
      const domain = document.getElementById('create-domain-select').value;
      const customName = document.getElementById('custom-alias-input').value.trim();

      const btn = document.getElementById('btn-submit-create');

      if (state.isGuest) {
        showToast('Buka Mini App di bot Telegram untuk membuat alamat.', '⚠️');
        return;
      }

      btn.textContent = 'Membuat Alamat...';
      btn.disabled = true;

      try {
        const res = await apiFetch('/addresses', {
          method: 'POST',
          body: JSON.stringify({
            mode: state.createMode,
            customName: state.createMode === 'custom' ? customName : null,
            domain,
            durationHours: state.selectedDuration,
          }),
        });
        if (!res.ok) throw new Error(res.error);

        state.addresses = res.addresses;
        renderAddresses();
        closeCreateModal();
        switchView('addresses');
        showToast('Alamat baru siap digunakan!', '🚀');
        haptic('success');
      } catch (err) {
        showToast(err.message, '⚠️');
      } finally {
        btn.textContent = '🚀 Buat Alamat Sekarang';
        btn.disabled = false;
      }
    });

    // --- Inbox & Reader (Gmail-Style) ---
    function renderInbox() {
      const container = document.getElementById('inbox-list');
      const badge = document.getElementById('badge-inbox');
      badge.textContent = state.inbox.length;
      badge.style.display = state.inbox.length > 0 ? 'inline-block' : 'none';

      if (state.isGuest) {
        container.innerHTML = \`
          <div class="empty-state" style="padding: 34px 16px; background: rgba(255, 255, 255, 0.03); border: 1px dashed var(--border-glass-bright); border-radius: var(--radius-md);">
            <div class="empty-icon" style="font-size: 48px; margin-bottom: 12px;">📱</div>
            <div class="empty-title">Mode Tamu (Buka di Telegram)</div>
            <div class="empty-desc" style="max-width: 330px; margin: 0 auto 18px; font-size: 13px; line-height: 1.6; color: var(--text-muted);">
              Mini App ini memerlukan autentikasi akun Telegram untuk menampilkan kotak masuk email Anda secara aman.
              <br><br>
              Buka bot Telegram <b>@VexTempMail_bot</b> dan ketuk tombol <b>Menu</b> di pojok kiri bawah, atau klik tombol di bawah:
            </div>
            <a href="https://t.me/VexTempMail_bot" class="btn btn-primary btn-sm" style="display: inline-flex; align-items: center; gap: 6px; text-decoration: none; font-weight: 700;">
              <span>🤖 Buka @VexTempMail_bot di Telegram</span>
            </a>
          </div>
        \`;
        return;
      }

      if (state.inbox.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">📭</div>
            <div class="empty-title">Kotak Masuk Kosong</div>
            <div class="empty-desc">Belum ada email yang masuk. Gunakan alamat email aktif Anda untuk menerima pesan.</div>
          </div>
        \`;
        return;
      }

      container.innerHTML = state.inbox.map(item => {
        const timeStr = item.receivedAt ? formatRelativeTime(item.receivedAt) : 'Baru saja';
        return \`
          <div class="inbox-item" onclick="openEmailReader('\${item.id}')">
            <div class="inbox-top">
              <span class="inbox-from">\${escapeHtml(item.from || '(Pengirim tidak dikenal)')}</span>
              <span class="inbox-time">\${timeStr}</span>
            </div>
            <div class="inbox-subject">\${escapeHtml(item.subject || '(Tanpa Subjek)')}</div>
            <div class="inbox-snippet">\${escapeHtml(item.snippet || '')}</div>
            \${item.primaryOtp ? \`<div class="inbox-otp-tag">🔑 OTP: \${escapeHtml(item.primaryOtp)}</div>\` : ''}
          </div>
        \`;
      }).join('');
    }

    function openEmailReader(id) {
      const email = state.inbox.find(i => i.id === id);
      if (!email) return;

      state.currentEmail = email;
      haptic('light');

      document.getElementById('reader-subject').textContent = email.subject || '(Tanpa Subjek)';
      document.getElementById('reader-from').textContent = email.from || '(tidak diketahui)';
      document.getElementById('reader-to').textContent = email.address || '';
      document.getElementById('reader-date').textContent = email.receivedAt ? new Date(email.receivedAt).toLocaleString('id-ID') : '-';

      // OTP Card
      const otpCard = document.getElementById('reader-otp-card');
      if (email.primaryOtp) {
        otpCard.style.display = 'block';
        document.getElementById('reader-otp-code').textContent = email.primaryOtp;

        const verifyBtn = document.getElementById('btn-open-verify-link');
        if (email.verificationLink) {
          verifyBtn.href = email.verificationLink;
          verifyBtn.style.display = 'inline-flex';
          verifyBtn.onclick = (e) => {
            e.preventDefault();
            openExternalUrl(email.verificationLink);
          };
        } else {
          verifyBtn.style.display = 'none';
        }
      } else {
        otpCard.style.display = 'none';
      }

      // Render into Sandboxed Iframe (Gmail style)
      const iframe = document.getElementById('reader-iframe');
      const fallbackCleanHtml = email.cleanText 
        ? \`<pre style="font-family: inherit; white-space: pre-wrap; word-break: break-word; padding: 15px; color: #1e293b;">\${linkifyHtml(email.cleanText)}</pre>\`
        : '<p style="padding: 20px; color: #64748b;">(Pesan kosong)</p>';
      const htmlContent = email.rawHtml ? email.rawHtml : fallbackCleanHtml;

      // Inject HTML safely into iframe srcdoc with responsive mobile styling & link click interceptor
      const iframeDocument = \`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <base target="_blank">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              color: #1e293b;
              margin: 12px;
              line-height: 1.5;
              word-break: break-word;
            }
            img { max-width: 100% !important; height: auto !important; }
            table { max-width: 100% !important; }
            a { color: #0284c7; }
          </style>
          <script>
            document.addEventListener('click', function(e) {
              var a = e.target.closest('a');
              if (a && a.href) {
                if (/^https?:\\/\\//i.test(a.href) || /^mailto:/i.test(a.href) || /^tel:/i.test(a.href)) {
                  e.preventDefault();
                  try {
                    window.parent.postMessage({ type: 'open_url', url: a.href }, '*');
                  } catch (err) {
                    window.open(a.href, '_blank');
                  }
                }
              }
            }, true);
          <\` + \`/script>
        </head>
        <body>\${htmlContent}</body>
        </html>
      \`;
      iframe.srcdoc = iframeDocument;

      // Clean text sheet fallback with clickable links
      const cleanContainer = document.getElementById('reader-clean-text');
      cleanContainer.innerHTML = email.cleanText 
        ? linkifyHtml(email.cleanText) 
        : '<span style="color: var(--text-muted);">(tidak ada isi pesan teks)</span>';

      // Reset toggle to HTML view
      setReaderViewMode('html');
      switchView('reader');
    }

    function setReaderViewMode(mode) {
      const btnHtml = document.getElementById('toggle-view-html');
      const btnText = document.getElementById('toggle-view-text');
      const containerHtml = document.getElementById('reader-html-container');
      const containerText = document.getElementById('reader-text-container');

      if (mode === 'html') {
        btnHtml.classList.add('active');
        btnText.classList.remove('active');
        containerHtml.style.display = 'block';
        containerText.style.display = 'none';
      } else {
        btnText.classList.add('active');
        btnHtml.classList.remove('active');
        containerHtml.style.display = 'none';
        containerText.style.display = 'block';
      }
    }

    document.getElementById('toggle-view-html').addEventListener('click', () => setReaderViewMode('html'));
    document.getElementById('toggle-view-text').addEventListener('click', () => setReaderViewMode('text'));

    document.getElementById('reader-clean-text').addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (a && a.href) {
        e.preventDefault();
        openExternalUrl(a.href);
      }
    });

    window.addEventListener('message', (event) => {
      if (event && event.data && event.data.type === 'open_url' && event.data.url) {
        openExternalUrl(event.data.url);
      }
    });

    document.getElementById('reader-back-btn').addEventListener('click', () => switchView('inbox'));

    document.getElementById('btn-copy-reader-otp').addEventListener('click', () => {
      if (state.currentEmail?.primaryOtp) {
        copyToClipboard(state.currentEmail.primaryOtp, 'Kode OTP');
      }
    });

    document.getElementById('reader-delete-btn').addEventListener('click', async () => {
      if (!state.currentEmail) return;
      haptic('warning');
      try {
        const res = await apiFetch('/inbox', {
          method: 'DELETE',
          body: JSON.stringify({ id: state.currentEmail.id }),
        });
        if (!res.ok) throw new Error(res.error);
        state.inbox = res.inbox;
        renderInbox();
        switchView('inbox');
        showToast('Email dihapus dari riwayat.', '🗑️');
      } catch (err) {
        showToast('Gagal menghapus: ' + err.message, '⚠️');
      }
    });

    document.getElementById('btn-clear-inbox').addEventListener('click', async () => {
      if (!confirm('Hapus seluruh riwayat kotak masuk?')) return;
      haptic('warning');
      try {
        const res = await apiFetch('/inbox', {
          method: 'DELETE',
          body: JSON.stringify({ clearAll: true }),
        });
        if (!res.ok) throw new Error(res.error);
        state.inbox = [];
        renderInbox();
        showToast('Kotak masuk dikosongkan.', '🗑️');
      } catch (err) {
        showToast('Gagal mengosongkan: ' + err.message, '⚠️');
      }
    });

    // --- Admin Functions ---
    function renderAdminStats() {
      if (!state.stats) return;
      document.getElementById('admin-stat-users').textContent = state.stats.totalUsers || 0;
      document.getElementById('admin-stat-addresses').textContent = state.stats.totalAddressesCreated || 0;
      document.getElementById('admin-stat-emails').textContent = state.stats.totalEmailsForwarded || 0;
      loadAdminDomains();
    }

    async function loadAdminDomains() {
      try {
        const data = await apiFetch('/admin/domains');
        if (!data.ok) return;
        const list = document.getElementById('admin-domains-list');
        list.innerHTML = data.allDomains.map(d => {
          const isExtra = data.extraDomains.includes(d);
          return \`
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(255,255,255,0.04); border-radius: var(--radius-sm); margin-bottom: 6px;">
              <span style="font-family: var(--font-mono); font-size: 13px;">\${d}</span>
              \${isExtra ? \`<button class="btn btn-danger btn-sm" onclick="removeDomain('\${d}')">Hapus</button>\` : \`<span style="font-size: 11px; color: var(--text-dim);">Bawaan</span>\`}
            </div>
          \`;
        }).join('');
      } catch (e) {}
    }

    async function removeDomain(domain) {
      if (!confirm(\`Hapus domain \${domain}?\`)) return;
      try {
        const res = await apiFetch('/admin/domains', {
          method: 'DELETE',
          body: JSON.stringify({ domain }),
        });
        if (res.ok) {
          showToast('Domain dihapus.', '🗑️');
          loadAdminDomains();
        }
      } catch (e) {}
    }

    document.getElementById('admin-add-domain-btn')?.addEventListener('click', async () => {
      const input = document.getElementById('admin-new-domain');
      const domain = input.value.trim();
      if (!domain) return;
      try {
        const res = await apiFetch('/admin/domains', {
          method: 'POST',
          body: JSON.stringify({ domain }),
        });
        if (res.ok) {
          input.value = '';
          showToast('Domain ditambahkan!', '✅');
          loadAdminDomains();
        } else {
          showToast(res.error || 'Gagal tambah domain', '⚠️');
        }
      } catch (e) {}
    });

    function handleQrisError() {
      const container = document.getElementById('qris-img-container');
      container.innerHTML = \`
        <div style="padding: 30px 10px; color: #64748b;">
          <div style="font-size: 32px; margin-bottom: 8px;">🖼️</div>
          <div style="font-size: 13px; font-weight: 600;">QRIS Belum Diunggah</div>
          <div style="font-size: 11px; margin-top: 4px;">Admin dapat mengunggahnya dengan kirim /setqris di chat bot.</div>
        </div>
      \`;
    }

    // --- Helpers ---
    function formatRelativeTime(timestamp) {
      const diffMs = Date.now() - timestamp;
      const diffSec = Math.floor(diffMs / 1000);
      if (diffSec < 60) return 'Baru saja';
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return \`\${diffMin}m lalu\`;
      const diffHour = Math.floor(diffMin / 60);
      if (diffHour < 24) return \`\${diffHour}j lalu\`;
      const diffDay = Math.floor(diffHour / 24);
      return \`\${diffDay}h lalu\`;
    }

    function openExternalUrl(url) {
      if (!url) return;
      if (!/^https?:\\/\\//i.test(url) && !/^mailto:/i.test(url) && !/^tel:/i.test(url)) return;
      try {
        if (tg && typeof tg.openLink === 'function') {
          tg.openLink(url);
          return;
        }
      } catch (err) {
        console.warn('tg.openLink error:', err);
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    }

    function cleanTrailingUrl(rawUrl) {
      let url = rawUrl;
      let trailing = '';
      while (url.length > 0) {
        const lastChar = url[url.length - 1];
        if (['.', ',', ';', ':', '!', '?', ']', '>', '<', '"', "'"].includes(lastChar)) {
          trailing = lastChar + trailing;
          url = url.slice(0, -1);
        } else if (lastChar === ')') {
          const openCount = (url.match(/\\(/g) || []).length;
          const closeCount = (url.match(/\\)/g) || []).length;
          if (closeCount > openCount) {
            trailing = lastChar + trailing;
            url = url.slice(0, -1);
          } else {
            break;
          }
        } else {
          break;
        }
      }
      return { url, trailing };
    }

    function linkifyHtml(text = '') {
      if (!text) return '';
      const urlRegex = /\\bhttps?:\\/\\/[^\\s<>"'\`]+/gi;
      let lastIndex = 0;
      let out = '';
      let match;

      while ((match = urlRegex.exec(text)) !== null) {
        const matchStart = match.index;
        const matchEnd = urlRegex.lastIndex;
        const plainPrefix = text.slice(lastIndex, matchStart);
        out += escapeHtml(plainPrefix);

        const { url, trailing } = cleanTrailingUrl(match[0]);
        if (url) {
          const href = escapeHtml(url);
          const label = escapeHtml(url);
          out += \`<a href="\${href}" target="_blank" rel="noopener noreferrer">\${label}</a>\`;
        }
        if (trailing) {
          out += escapeHtml(trailing);
        }
        lastIndex = matchEnd;
      }

      out += escapeHtml(text.slice(lastIndex));
      return out;
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // Initial Load
    loadBootstrapData();
  </script>
</body>
</html>
`;
}
