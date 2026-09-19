/**
 * Bot Telegram Temp-Mail (Cloudflare Workers)
 * Menggunakan Telegram Rich Messages (tabel asli, heading, format terstruktur)
 */


const ADDRESS_TTL_SECONDS = 24 * 60 * 60;
const DURATION_OPTIONS_HOURS = [6, 12, 24, 48, 72];
const MAX_ADDRESSES_PER_USER = 8;
const ADDR_PAGE_SIZE = 4;
const MAX_INBOX_HISTORY = 12;
const INBOX_PAGE_SIZE = 4;
const INBOX_TTL_SECONDS = 30 * 24 * 60 * 60;
const PENDING_TTL_SECONDS = 300;

export default {
  async fetch(request, env, ctx) {
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

      const keyboard = emailActionsKeyboard(to, primaryOtp, verificationLink);

      // 4. Kirim teks bersih ke Telegram (pecah pesan jika sangat panjang)
      const bodyText = cleanText || (parsed.attachments.length ? '(Email ini hanya berisi lampiran, tanpa teks)' : '(tidak ada isi pesan)');
      const chunks = splitTextIntoChunks(bodyText, 3200);

      const firstMsgHtml = chunks.length > 1
        ? headerHtml + `📝 <b>Isi Pesan (Bagian 1/${chunks.length}):</b>\n\n${escapeTelegramHtml(chunks[0])}`
        : headerHtml + `📝 <b>Isi Pesan:</b>\n\n${escapeTelegramHtml(chunks[0])}`;

      await sendHtmlMessage(env, chatId, firstMsgHtml, keyboard);

      for (let i = 1; i < chunks.length; i++) {
        const partHtml = `<b>(Bagian ${i + 1}/${chunks.length})</b>\n\n${escapeTelegramHtml(chunks[i])}`;
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

      await pushInboxEntry(env, chatId, {
        address: to,
        from,
        subject,
        snippet,
        cleanText,
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
      const view = command === '/help' ? viewHelp() : viewMenu(firstName);
      await sendView(env, chatId, view);
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

  try {
    if (data === 'm') {
      await answerCallback(env, query.id);
      await edit(viewMenu());
      return;
    }

    if (data === 'help') {
      await answerCallback(env, query.id);
      await edit(viewHelp());
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
        await edit(viewMenu());
        return;
      }
      if (result.error === 'taken') {
        await answerCallback(env, query.id, `Alamat "${alias}" baru saja dipakai orang lain. Coba lagi.`, true);
        await edit(viewMenu());
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
      await edit(viewMenu());

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

function viewMenu(firstName = '', note = '') {
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
    keyboard: mainMenuKeyboard(),
  };
}

function viewHelp() {
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
        `📎 Lampiran email otomatis dikirim sebagai file terpisah.\n🖼 Gambar email dikirim rapi dalam album foto.`,
    },
  ];

  const fallbackHtml =
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
    `Buka "Alamat Saya" → pilih alamat → "Cek Email Masuk" untuk melihat inbox khusus alamat tsb.\n` +
    `Lampiran otomatis diteruskan sebagai file.</blockquote>\n\n` +
    `Atau cukup gunakan tombol navigasi di bawah 👇`;

  return {
    richMessage: { blocks },
    fallbackHtml,
    text: fallbackHtml,
    keyboard: mainMenuKeyboard(),
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

  const chunks = splitTextIntoChunks(cleanText, 3000);
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

  detailHtml += escapeTelegramHtml(chunks[safePart] || '');

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

  const chunks = splitTextIntoChunks(cleanText, 3000);
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

  detailHtml += escapeTelegramHtml(chunks[safePart] || '');

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

  const chunks = splitTextIntoChunks(cleanText, 3500);

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
      ? headerHtml + `📝 <b>Isi Pesan:</b>\n\n` + escapeTelegramHtml(chunks[0])
      : `<b>(Bagian ${b + 1}/${chunks.length})</b>\n\n` + escapeTelegramHtml(chunks[b]);

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

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🆕 Buat Alamat Baru', callback_data: 'new' }],
      [
        { text: '📮 Alamat Saya', callback_data: 'l:0' },
        { text: '📥 Semua Email', callback_data: 'i:0' },
      ],
      [{ text: '❓ Bantuan', callback_data: 'help' }],
      [{ text: '💝 Donasi', callback_data: 'donasi' }],
    ],
  };
}

function emailActionsKeyboard(address, primaryOtp = null, verificationLink = null) {
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
    return JSON.parse(raw);
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
  const ignoredLinkKeywords = /unsubscribe|optout|subscription|privacy|terms|facebook|twitter|instagram|youtube|linkedin|github\.com\/settings/i;
  const verifyLinkKeywords = /verify|verification|confirm|confirmation|activate|activation|token=|code=|auth\/|login\?|signup\?/i;

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

// --- HTML Escape Helpers ---

function escapeTelegramHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(str = '') {
  return escapeTelegramHtml(str).replace(/"/g, '&quot;');
}
