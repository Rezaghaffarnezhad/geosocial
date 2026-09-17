const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Pool } = require('pg');

const DATABASE_URL = (process.env.DATABASE_URL || 'postgresql://postgres:Reza.137801@db.dotyhbasvvczsyzdhnko.supabase.co:5432/postgres').replace(/\[|\]/g, '');

let pgPool = null;
let pgConnected = false;

try {
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 7000
  });

  pgPool.on('error', (err) => {
    console.error('PostgreSQL client error:', err.message);
  });
} catch (e) {
  console.error('Failed to initialize PostgreSQL pool:', e.message);
}

function dist(a, b, c, d) {
  const R = 6371, p = Math.PI / 180, dl = (c - a) * p, dg = (d - b) * p, x = Math.sin(dl / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

let saveTimeout = null;
function persistDB() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const data = { users, publicMessages, directMessages, stories, highlights, posts, follows };
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving database:', e.message);
    }
  }, 1000);
}

async function initPostgres() {
  if (!pgPool) return;
  try {
    const client = await pgPool.connect();
    pgConnected = true;
    console.log('🐘 Connected to Supabase PostgreSQL database successfully!');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        username TEXT,
        phone TEXT,
        avatar TEXT,
        bio TEXT,
        lat NUMERIC,
        lng NUMERIC,
        ghost BOOLEAN DEFAULT false,
        online BOOLEAN DEFAULT false,
        last_seen TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT,
        receiver_id TEXT,
        conversation_key TEXT,
        text TEXT,
        media_url TEXT,
        audio_url TEXT,
        media_type TEXT,
        location JSONB,
        poll JSONB,
        contact JSONB,
        file_info JSONB,
        reply_to TEXT,
        reply_text TEXT,
        forward_from JSONB,
        reactions JSONB DEFAULT '{}',
        is_pinned BOOLEAN DEFAULT false,
        status TEXT DEFAULT 'delivered',
        seen BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS public_messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT,
        lat NUMERIC,
        lng NUMERIC,
        radius NUMERIC DEFAULT 25,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS stories (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        user_name TEXT,
        user_avatar TEXT,
        media_url TEXT,
        media_type TEXT DEFAULT 'image',
        caption TEXT,
        likes JSONB DEFAULT '[]',
        comments JSONB DEFAULT '[]',
        views JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Sync users from PG
    const uRes = await client.query('SELECT * FROM users');
    if (uRes.rows.length > 0) {
      uRes.rows.forEach(r => {
        const u = {
          ...r,
          lat: r.lat != null ? Number(r.lat) : 35.6892,
          lng: r.lng != null ? Number(r.lng) : 51.3890,
          ghost: Boolean(r.ghost),
          online: Boolean(r.online)
        };
        const idx = users.findIndex(x => x.id === u.id);
        if (idx >= 0) users[idx] = { ...users[idx], ...u };
        else users.push(u);
      });
      console.log(`🐘 Synced ${uRes.rows.length} users from PostgreSQL`);
    }

    // Sync public messages from PG
    const pRes = await client.query('SELECT * FROM public_messages ORDER BY created_at DESC LIMIT 100');
    if (pRes.rows.length > 0) {
      const dbPubs = pRes.rows.reverse().map(r => ({
        ...r,
        lat: r.lat != null ? Number(r.lat) : null,
        lng: r.lng != null ? Number(r.lng) : null,
        radius: r.radius != null ? Number(r.radius) : 25
      }));
      publicMessages = dbPubs;
      console.log(`🐘 Synced ${dbPubs.length} public messages from PostgreSQL`);
    }

    // Sync direct messages from PG
    const mRes = await client.query('SELECT * FROM messages ORDER BY created_at ASC');
    if (mRes.rows.length > 0) {
      mRes.rows.forEach(r => {
        const key = r.conversation_key || [r.sender_id, r.receiver_id].sort().join('_');
        if (!directMessages[key]) directMessages[key] = [];
        if (!directMessages[key].some(m => m.id === r.id)) {
          directMessages[key].push(r);
        }
      });
      console.log(`🐘 Synced direct messages from PostgreSQL`);
    }

    // Sync stories from PG
    const sRes = await client.query('SELECT * FROM stories ORDER BY created_at DESC LIMIT 50');
    if (sRes.rows.length > 0) {
      stories = sRes.rows;
      console.log(`🐘 Synced ${stories.length} stories from PostgreSQL`);
    }

    client.release();
    persistDB();
  } catch (err) {
    console.warn('⚠️ Supabase PostgreSQL connection notice:', err.message);
    console.log('📁 Operating with local database persistence fallback (data.json).');
  }
}
initPostgres();

async function pgUpsertUser(u) {
  if (!pgPool || !pgConnected || !u?.id) return;
  try {
    await pgPool.query(`
      INSERT INTO users (id, name, username, phone, avatar, bio, lat, lng, ghost, online, last_seen, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, users.name),
        username = COALESCE(EXCLUDED.username, users.username),
        phone = COALESCE(EXCLUDED.phone, users.phone),
        avatar = COALESCE(EXCLUDED.avatar, users.avatar),
        bio = COALESCE(EXCLUDED.bio, users.bio),
        lat = COALESCE(EXCLUDED.lat, users.lat),
        lng = COALESCE(EXCLUDED.lng, users.lng),
        ghost = EXCLUDED.ghost,
        online = EXCLUDED.online,
        last_seen = EXCLUDED.last_seen,
        updated_at = NOW()
    `, [u.id, u.name, u.username || null, u.phone || null, u.avatar || null, u.bio || null, u.lat, u.lng, !!u.ghost, !!u.online, u.last_seen || new Date().toISOString()]);
  } catch (e) {
    console.error('PG Upsert User Error:', e.message);
  }
}

async function pgInsertMessage(msg, convKey) {
  if (!pgPool || !pgConnected || !msg?.id) return;
  try {
    await pgPool.query(`
      INSERT INTO messages (id, sender_id, receiver_id, conversation_key, text, media_url, audio_url, media_type, location, poll, contact, file_info, reply_to, reply_text, forward_from, reactions, is_pinned, status, seen, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      ON CONFLICT (id) DO UPDATE SET
        reactions = EXCLUDED.reactions,
        is_pinned = EXCLUDED.is_pinned,
        status = EXCLUDED.status,
        seen = EXCLUDED.seen
    `, [msg.id, msg.sender_id, msg.receiver_id, convKey, msg.text, msg.media_url, msg.audio_url, msg.media_type, JSON.stringify(msg.location || null), JSON.stringify(msg.poll || null), JSON.stringify(msg.contact || null), JSON.stringify(msg.file_info || null), msg.reply_to, msg.reply_text, JSON.stringify(msg.forward_from || null), JSON.stringify(msg.reactions || {}), !!msg.is_pinned, msg.status || 'delivered', !!msg.seen, msg.created_at || new Date().toISOString()]);
  } catch (e) {
    console.error('PG Insert Message Error:', e.message);
  }
}

async function pgInsertPublicMessage(msg) {
  if (!pgPool || !pgConnected || !msg?.id) return;
  try {
    await pgPool.query(`
      INSERT INTO public_messages (id, sender_id, sender_name, text, lat, lng, radius, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO NOTHING
    `, [msg.id, msg.sender_id, msg.sender_name, msg.text, msg.lat, msg.lng, msg.radius || 25, msg.created_at || new Date().toISOString()]);
  } catch (e) {
    console.error('PG Insert Public Message Error:', e.message);
  }
}

async function pgInsertStory(s) {
  if (!pgPool || !pgConnected || !s?.id) return;
  try {
    await pgPool.query(`
      INSERT INTO stories (id, user_id, user_name, user_avatar, media_url, media_type, caption, likes, comments, views, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        likes = EXCLUDED.likes,
        comments = EXCLUDED.comments,
        views = EXCLUDED.views
    `, [s.id, s.user_id, s.user_name, s.user_avatar, s.media_url, s.media_type || 'image', s.caption, JSON.stringify(s.likes || []), JSON.stringify(s.comments || []), JSON.stringify(s.views || []), s.created_at || new Date().toISOString()]);
  } catch (e) {
    console.error('PG Insert Story Error:', e.message);
  }
}

// Server-Sent Events (SSE) for Real-Time Instant Broadcast
let sseClients = [];

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try { client.res.write(payload); } catch {}
  });
}

// Keep-alive heartbeat every 15s
setInterval(() => {
  sseClients.forEach(client => {
    try { client.res.write(': keepalive\n\n'); } catch {}
  });
}, 15000);

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const userId = req.query.user_id;
  const clientId = Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  sseClients.push({ id: clientId, userId, res });

  if (userId) {
    const u = users.find(usr => usr.id === userId);
    if (u) {
      u.online = true;
      u.last_seen = new Date().toISOString();
      persistDB();
      pgUpsertUser(u);
      broadcastSSE('user_update', u);
      broadcastSSE('user_sync', u);
    }
  }

  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', time: new Date().toISOString() })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
    if (userId) {
      const stillHasConn = sseClients.some(c => c.userId === userId);
      if (!stillHasConn) {
        const u = users.find(usr => usr.id === userId);
        if (u) {
          u.online = false;
          u.last_seen = new Date().toISOString();
          persistDB();
          pgUpsertUser(u);
          broadcastSSE('user_update', u);
          broadcastSSE('user_sync', u);
        }
      }
    }
  });
});

// Endpoint for instant offline notification on app unload / minimize
app.post('/api/users/offline', (req, res) => {
  let userId = req.body?.user_id;
  if (!userId && typeof req.body === 'string') {
    try { userId = JSON.parse(req.body).user_id; } catch {}
  }
  if (userId) {
    const u = users.find(usr => usr.id === userId);
    if (u) {
      u.online = false;
      u.last_seen = new Date().toISOString();
      persistDB();
      pgUpsertUser(u);
      broadcastSSE('user_update', u);
      broadcastSSE('user_sync', u);
    }
  }
  res.json({ success: true });
});

// Alias for /api/sse so both SSE paths work reliably
app.get('/api/sse', (req, res) => {
  res.redirect(307, '/api/events' + (req.query.user_id ? `?user_id=${req.query.user_id}` : ''));
});

app.get('/', (req, res) => {
  if (fs.existsSync(path.join(__dirname, 'index.html'))) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else if (fs.existsSync(path.join(__dirname, 'index (1).html'))) {
    res.sendFile(path.join(__dirname, 'index (1).html'));
  } else {
    res.send('GeoSocial Server is running.');
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    online_users: users.length,
    sse_clients: sseClients.length,
    stories_count: stories.length,
    public_messages_count: publicMessages.length,
    highlights_count: highlights.length,
    posts_count: posts.length
  });
});

// Normalize Iranian phone number helper
function normalizePhone(input) {
  if (!input) return '';
  let p = input.toString().trim().replace(/[^\d+]/g, '');
  if (p.startsWith('+98')) p = '0' + p.substring(3);
  if (p.startsWith('0098')) p = '0' + p.substring(4);
  if (p.startsWith('98') && p.length === 12) p = '0' + p.substring(2);
  if (p.length === 10 && p.startsWith('9')) p = '0' + p;
  return p;
}

// ----------------------------------------------------
// Mobile Number & OTP Authentication APIs
// ----------------------------------------------------

const SMS_CONFIG = {
  telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '8186173027:AAHY6oTA7TF0NWbgD_KaajJgqBZtyAu6EPc',
  telegram_bot_username: process.env.TELEGRAM_BOT_USERNAME || 'RezaProFx_bot',
  kavenegar_api_key: process.env.KAVENEGAR_API_KEY || '',
  kavenegar_template: process.env.KAVENEGAR_TEMPLATE || 'verify',
  faraz_api_key: process.env.FARAZ_API_KEY || '',
  faraz_pattern_code: process.env.FARAZ_PATTERN_CODE || '',
  faraz_originator: process.env.FARAZ_ORIGINATOR || '+983000505'
};

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  return new Promise((resolve) => {
    if (!SMS_CONFIG.telegram_bot_token || !chatId) {
      return resolve({ success: false });
    }

    const payload = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    });

    const endpoints = [
      { host: 'api.telegram.org', path: `/bot${SMS_CONFIG.telegram_bot_token}/sendMessage` },
      { host: 'api.telegram-proxy.org', path: `/bot${SMS_CONFIG.telegram_bot_token}/sendMessage` }
    ];

    function trySend(idx) {
      if (idx >= endpoints.length) return resolve({ success: false });

      const req = https.request({
        hostname: endpoints[idx].host,
        path: endpoints[idx].path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 4000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ success: true, data }));
      });

      req.on('timeout', () => { req.destroy(); trySend(idx + 1); });
      req.on('error', () => trySend(idx + 1));
      req.write(payload);
      req.end();
    }

    trySend(0);
  });
}

let lastTelegramUpdateId = 0;
function startTelegramBotPoller() {
  if (!SMS_CONFIG.telegram_bot_token) return;

  const hosts = ['api.telegram.org', 'api.telegram-proxy.org'];

  async function pollUpdates(hostIdx = 0) {
    const currentHost = hosts[hostIdx % hosts.length];
    try {
      const path = `/bot${SMS_CONFIG.telegram_bot_token}/getUpdates?offset=${lastTelegramUpdateId + 1}&timeout=15`;
      const req = https.get({
        hostname: currentHost,
        path: path,
        timeout: 18000
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.ok && Array.isArray(json.result)) {
              json.result.forEach(update => {
                lastTelegramUpdateId = Math.max(lastTelegramUpdateId, update.update_id);
                handleTelegramUpdate(update);
              });
            }
          } catch {}
          setTimeout(() => pollUpdates(hostIdx), 1000);
        });
      });

      req.on('timeout', () => {
        req.destroy();
        setTimeout(() => pollUpdates(hostIdx + 1), 2000);
      });

      req.on('error', () => {
        setTimeout(() => pollUpdates(hostIdx + 1), 2500);
      });
    } catch {
      setTimeout(() => pollUpdates(hostIdx + 1), 2500);
    }
  }

  pollUpdates(0);
  console.log('🤖 Telegram Bot Poller active for @' + SMS_CONFIG.telegram_bot_username);
}

function handleTelegramUpdate(update) {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const fromUser = msg.from;

  if (msg.contact && msg.contact.phone_number) {
    const rawPhone = msg.contact.phone_number;
    const cleanPhone = normalizePhone(rawPhone);

    const code = Math.floor(1000 + Math.random() * 9000).toString();
    activeOTPs[cleanPhone] = {
      code: code,
      expires: Date.now() + 180000
    };

    const replyText = `🔐 <b>کد تایید ورود شما به ژئوسوشیال:</b>\n\n<code>${code}</code>\n\n📱 شماره تلفن: <code>${cleanPhone}</code>\n⏱ اعتبار: ۳ دقیقه\n\nاین کد را در برنامه وارد کنید تا وارد شوید.`;
    
    sendTelegramMessage(chatId, replyText, { remove_keyboard: true });
    console.log(`📱 Issued OTP ${code} to Telegram user ${chatId} (${cleanPhone})`);
    return;
  }

  const text = (msg.text || '').trim();
  if (text.startsWith('/start')) {
    const welcomeText = `سلام ${fromUser.first_name || 'کاربر گرامی'} عزیز! 🌟\n\nبه ربات ورود اختصاصی <b>ژئوسوشیال (GeoSocial)</b> خوش آمدید.\n\nبرای دریافت کد تایید ورود به حساب، لطفاً دکمه زیر را لمس کنید تا کد تایید برای شماره تلگرام شما ارسال شود 👇`;
    
    const replyMarkup = {
      keyboard: [
        [{ text: '📱 ارسال شماره و دریافت کد ورود', request_contact: true }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    };

    sendTelegramMessage(chatId, welcomeText, replyMarkup);
  }
}

startTelegramBotPoller();

async function sendRealSMS(receptor, code) {
  return new Promise((resolve) => {
    if (SMS_CONFIG.kavenegar_api_key) {
      const url = `https://api.kavenegar.com/v1/${SMS_CONFIG.kavenegar_api_key}/verify/lookup.json?receptor=${receptor}&token=${code}&template=${SMS_CONFIG.kavenegar_template}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ provider: 'kavenegar', success: true }));
      }).on('error', (err) => resolve({ provider: 'kavenegar', success: false, error: err.message }));
      return;
    }

    if (SMS_CONFIG.faraz_api_key && SMS_CONFIG.faraz_pattern_code) {
      const postData = JSON.stringify({
        code: SMS_CONFIG.faraz_pattern_code,
        sender: SMS_CONFIG.faraz_originator,
        recipient: receptor,
        variable: { code: code }
      });
      const req = https.request({
        hostname: 'api2.ippanel.com',
        path: '/api/v1/sms/pattern/normal/send',
        method: 'POST',
        headers: {
          'apikey': SMS_CONFIG.faraz_api_key,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ provider: 'faraz', success: true }));
      });
      req.on('error', (err) => resolve({ provider: 'faraz', success: false, error: err.message }));
      req.write(postData);
      req.end();
      return;
    }

    console.log(`[SMS/Telegram-Simulator] Code for ${receptor}: [${code}]`);
    resolve({ provider: 'simulator', success: true });
  });
}

// 1. Send OTP Code
app.post('/api/auth/send_otp', async (req, res) => {
  const { phone } = req.body || {};
  const cleanPhone = normalizePhone(phone);

  if (!cleanPhone || cleanPhone.length < 10) {
    return res.status(400).json({ success: false, error: 'شماره موبایل نامعتبر است (مثال: 09123456789)' });
  }

  const code = Math.floor(1000 + Math.random() * 9000).toString();
  activeOTPs[cleanPhone] = {
    code: code,
    expires: Date.now() + 180000
  };

  const existingUser = users.find(u => u.phone === cleanPhone || u.id === 'usr_' + cleanPhone);

  console.log(`📱 SMS OTP Code for ${cleanPhone}: [${code}]`);
  sendRealSMS(cleanPhone, code).catch(err => console.error('SMS background error:', err));

  const hasGateway = (SMS_CONFIG.telegram_bot_token && SMS_CONFIG.telegram_chat_id) || SMS_CONFIG.kavenegar_api_key || SMS_CONFIG.faraz_api_key;

  res.json({
    success: true,
    phone: cleanPhone,
    is_new_user: !existingUser,
    user_name: existingUser ? existingUser.name : null,
    has_real_gateway: !!hasGateway,
    code: code,
    message: `کد تایید ارسال شد`
  });
});

// 2. Verify OTP & Complete Login
app.post('/api/auth/verify_otp', (req, res) => {
  const { phone, code, name, avatar, bio, city, lat, lng } = req.body || {};
  const cleanPhone = normalizePhone(phone);
  const sentCode = (code || '').toString().trim();

  if (!cleanPhone) {
    return res.status(400).json({ success: false, error: 'شماره موبایل الزامی است' });
  }

  const stored = activeOTPs[cleanPhone];
  const isValidCode = sentCode === '1234' || (stored && stored.code === sentCode);

  if (!isValidCode) {
    return res.status(400).json({ success: false, error: 'کد تایید اشتباه است (کد ۱۲۳۴ نیز برای تست مجاز است)' });
  }

  delete activeOTPs[cleanPhone];

  let user = users.find(u => u.phone === cleanPhone || u.id === 'usr_' + cleanPhone);

  if (!user) {
    user = {
      id: 'usr_' + cleanPhone,
      phone: cleanPhone,
      name: name && name.trim() ? name.trim() : `کاربر ${cleanPhone.slice(-4)}`,
      username: 'user_' + cleanPhone.slice(-6),
      avatar: avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
      bio: bio || 'عضو GeoSocial 📱',
      city: city || 'ایران',
      lat: Number(lat) || (35.6892 + (Math.random() - 0.5) * 0.02),
      lng: Number(lng) || (51.3890 + (Math.random() - 0.5) * 0.02),
      ghost: false,
      online: true,
      last_seen: new Date().toISOString()
    };
    users.push(user);
  } else {
    if (name && name.trim()) user.name = name.trim();
    if (avatar) user.avatar = avatar;
    if (bio) user.bio = bio;
    if (city) user.city = city;
    if (lat && Number.isFinite(Number(lat))) user.lat = Number(lat);
    if (lng && Number.isFinite(Number(lng))) user.lng = Number(lng);
    user.online = true;
    user.last_seen = new Date().toISOString();
  }

  persistDB();
  broadcastSSE('user_update', user);
  broadcastSSE('user_sync', user);
  res.json({ success: true, user });
});

// 3. Direct Telegram Profile Login
app.post('/api/auth/telegram', (req, res) => {
  const { id, first_name, last_name, username, photo_url, lat, lng } = req.body || {};

  if (!id) {
    return res.status(400).json({ success: false, error: 'اطلاعات تلگرام معتبر نیست' });
  }

  const tgUserId = 'tg_' + id;
  let fullName = [first_name, last_name].filter(Boolean).join(' ').trim();
  if (!fullName) fullName = username ? `@${username}` : `کاربر تلگرام ${id}`;

  let user = users.find(u => u.id === tgUserId || u.telegram_id === id);

  if (!user) {
    user = {
      id: tgUserId,
      telegram_id: id,
      name: fullName,
      username: username || 'tg_' + id,
      avatar: photo_url || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
      bio: username ? `کاربر تلگرام (@${username}) 📱` : 'عضو تلگرامی GeoSocial 📱',
      city: 'ایران',
      lat: Number(lat) || (35.6892 + (Math.random() - 0.5) * 0.02),
      lng: Number(lng) || (51.3890 + (Math.random() - 0.5) * 0.02),
      ghost: false,
      online: true,
      last_seen: new Date().toISOString()
    };
    users.push(user);
  } else {
    user.name = fullName;
    if (photo_url) user.avatar = photo_url;
    if (username) user.username = username;
    if (lat && Number.isFinite(Number(lat))) user.lat = Number(lat);
    if (lng && Number.isFinite(Number(lng))) user.lng = Number(lng);
    user.online = true;
    user.last_seen = new Date().toISOString();
  }

  persistDB();
  broadcastSSE('user_update', user);
  broadcastSSE('user_sync', user);
  console.log(`🚀 Instant Telegram Login for ${user.name} (@${user.username})`);
  res.json({ success: true, user });
});

// Users & Locations API
app.get('/api/users', (req, res) => {
  const currentUserId = req.query.user_id;
  const filtered = users.filter(u => !u.ghost && u.id !== currentUserId);
  res.json({ success: true, users: filtered });
});

app.get('/api/users/profile', (req, res) => {
  const { user_id, target_id } = req.query;
  const target = users.find(u => u.id === target_id);
  if (!target) return res.status(404).json({ success: false, error: 'User not found' });

  const targetStories = stories.filter(s => s.user_id === target_id && (!s.expires_at || s.expires_at > new Date().toISOString()));
  const targetHighlights = highlights.filter(h => h.user_id === target_id);
  const targetPosts = posts.filter(p => p.user_id === target_id);
  const followerCount = Object.values(follows).filter(list => Array.isArray(list) && list.includes(target_id)).length;
  const followingCount = (follows[target_id] || []).length;
  const isFollowing = user_id && follows[user_id] ? follows[user_id].includes(target_id) : false;

  res.json({
    success: true,
    user: target,
    has_active_story: targetStories.length > 0,
    stories: targetStories,
    highlights: targetHighlights,
    posts: targetPosts,
    stats: {
      followers: followerCount,
      following: followingCount,
      posts: targetPosts.length,
      stories: targetStories.length,
      highlights: targetHighlights.length
    },
    is_following: isFollowing
  });
});

app.post('/api/users/follow', (req, res) => {
  const { user_id, target_id } = req.body;
  if (!user_id || !target_id) return res.status(400).json({ success: false, error: 'Missing user IDs' });

  if (!follows[user_id]) follows[user_id] = [];
  const idx = follows[user_id].indexOf(target_id);
  let isFollowing = false;

  if (idx >= 0) {
    follows[user_id].splice(idx, 1);
    isFollowing = false;
  } else {
    follows[user_id].push(target_id);
    isFollowing = true;
  }

  persistDB();
  broadcastSSE('follow_update', { user_id, target_id, is_following: isFollowing });
  res.json({ success: true, is_following: isFollowing });
});

app.post('/api/users/sync', (req, res) => {
  const user = req.body;
  if (!user || !user.id) return res.status(400).json({ success: false, error: 'User ID required' });
  
  const idx = users.findIndex(u => u.id === user.id);
  user.last_seen = new Date().toISOString();
  user.online = true;

  if (idx >= 0) {
    users[idx] = { ...users[idx], ...user };
  } else {
    users.push(user);
  }
  const updatedUser = idx >= 0 ? users[idx] : user;
  persistDB();
  pgUpsertUser(updatedUser);
  broadcastSSE('user_update', updatedUser);
  broadcastSSE('user_sync', updatedUser);
  res.json({ success: true, user: updatedUser });
});

// Stories API
app.get('/api/stories', (req, res) => {
  const now = new Date().toISOString();
  const active = stories.filter(s => !s.expires_at || s.expires_at > now);
  res.json({ success: true, stories: active });
});

app.get('/api/stories/archive', (req, res) => {
  const { user_id } = req.query;
  const userStories = stories.filter(s => s.user_id === user_id);
  res.json({ success: true, stories: userStories });
});

app.post('/api/stories', (req, res) => {
  const { user_id, user_name, user_avatar, media_url, media_type, caption, stickers, audience } = req.body || {};
  if (!user_id || !media_url) return res.status(400).json({ success: false, error: 'Missing story data' });
  
  const newStory = {
    id: 'st_' + Date.now(),
    user_id,
    user_name: user_name || 'کاربر',
    user_avatar: user_avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
    media_url,
    media_type: media_type || 'image',
    caption: caption || '',
    stickers: stickers || [],
    audience: audience || 'all',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    likes: [],
    comments: [],
    views: [],
    poll_votes: {} // { [optionIndex]: [userIds] }
  };

  stories.unshift(newStory);
  persistDB();
  pgInsertStory(newStory);
  broadcastSSE('new_story', newStory);
  res.json({ success: true, story: newStory });
});

app.post('/api/stories/view', (req, res) => {
  const { story_id, user_id, user_name, user_avatar } = req.body;
  const story = stories.find(s => s.id === story_id);
  if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

  if (!story.views) story.views = [];
  if (user_id && !story.views.some(v => (typeof v === 'string' ? v === user_id : v.user_id === user_id))) {
    story.views.push({
      user_id,
      user_name: user_name || 'کاربر',
      user_avatar: user_avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
      viewed_at: new Date().toISOString()
    });
    persistDB();
    pgInsertStory(story);
    broadcastSSE('story_view', { story_id, views_count: story.views.length });
  }
  res.json({ success: true, views_count: story.views.length });
});

app.post('/api/stories/like', (req, res) => {
  const { story_id, user_id } = req.body;
  const story = stories.find(s => s.id === story_id);
  if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

  if (!story.likes) story.likes = [];
  const idx = story.likes.indexOf(user_id);
  if (idx >= 0) story.likes.splice(idx, 1);
  else story.likes.push(user_id);

  persistDB();
  pgInsertStory(story);
  broadcastSSE('story_like', { story_id, likes_count: story.likes.length });
  res.json({ success: true, likes_count: story.likes.length, is_liked: idx < 0 });
});

app.post('/api/stories/comment', (req, res) => {
  const { story_id, user_id, user_name, text } = req.body;
  const story = stories.find(s => s.id === story_id);
  if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

  if (!story.comments) story.comments = [];
  const comment = { id: 'c_' + Date.now(), user_id, user_name: user_name || 'کاربر', text, created_at: new Date().toISOString() };
  story.comments.push(comment);

  persistDB();
  pgInsertStory(story);
  broadcastSSE('story_comment', { story_id, comment });
  res.json({ success: true, comment });
});

app.post('/api/stories/vote_poll', (req, res) => {
  const { story_id, option_index, user_id } = req.body;
  const story = stories.find(s => s.id === story_id);
  if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

  if (!story.poll_votes) story.poll_votes = {};
  if (!story.poll_votes[option_index]) story.poll_votes[option_index] = [];
  
  // Remove user from all options first
  Object.keys(story.poll_votes).forEach(opt => {
    story.poll_votes[opt] = story.poll_votes[opt].filter(id => id !== user_id);
  });
  
  story.poll_votes[option_index].push(user_id);
  persistDB();
  pgInsertStory(story);
  broadcastSSE('story_poll_update', { story_id, poll_votes: story.poll_votes });
  res.json({ success: true, poll_votes: story.poll_votes });
});

app.delete('/api/stories/:id', (req, res) => {
  const { id } = req.params;
  const idx = stories.findIndex(s => s.id === id);
  if (idx >= 0) {
    stories.splice(idx, 1);
    persistDB();
    broadcastSSE('story_deleted', { id });
    return res.json({ success: true, message: 'Story deleted' });
  }
  res.status(404).json({ success: false, error: 'Story not found' });
});

// Highlights API
app.get('/api/highlights', (req, res) => {
  const { user_id } = req.query;
  const list = user_id ? highlights.filter(h => h.user_id === user_id) : highlights;
  res.json({ success: true, highlights: list });
});

app.post('/api/highlights', (req, res) => {
  const { user_id, title, cover_url, story_ids } = req.body;
  const newHighlight = {
    id: 'hl_' + Date.now(),
    user_id,
    title: title || 'هایلایت',
    cover_url: cover_url || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
    story_ids: story_ids || [],
    created_at: new Date().toISOString()
  };
  highlights.unshift(newHighlight);
  persistDB();
  res.json({ success: true, highlight: newHighlight });
});

app.delete('/api/highlights/:id', (req, res) => {
  const { id } = req.params;
  const idx = highlights.findIndex(h => h.id === id);
  if (idx >= 0) {
    highlights.splice(idx, 1);
    persistDB();
    broadcastSSE('highlight_deleted', { id });
    return res.json({ success: true });
  }
  res.status(404).json({ success: false, error: 'Highlight not found' });
});

// Profile Posts API (Instagram style)
app.get('/api/posts', (req, res) => {
  const { user_id } = req.query;
  const userPosts = user_id ? posts.filter(p => p.user_id === user_id) : posts;
  res.json({ success: true, posts: userPosts });
});

app.post('/api/posts', (req, res) => {
  const { user_id, user_name, user_avatar, media_url, caption } = req.body;
  const newPost = {
    id: 'p_' + Date.now(),
    user_id,
    user_name: user_name || 'کاربر',
    user_avatar: user_avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
    media_url,
    caption: caption || '',
    likes: [],
    comments: [],
    created_at: new Date().toISOString()
  };
  posts.unshift(newPost);
  persistDB();
  res.json({ success: true, post: newPost });
});

// Public Chat API (Filtered by Location Radius)
app.get('/api/public_messages', (req, res) => {
  const { lat, lng, radius } = req.query;
  let msgs = publicMessages.slice(-100);
  if (lat != null && lng != null) {
    const uLat = Number(lat), uLng = Number(lng), uRad = Number(radius) || 25;
    if (uRad < 500) {
      msgs = msgs.filter(m => {
        if (m.lat == null || m.lng == null) return true;
        const d = dist(uLat, uLng, Number(m.lat), Number(m.lng));
        const maxR = Math.max(uRad, Number(m.radius) || 25);
        return d <= maxR;
      });
    }
  }
  res.json({ success: true, messages: msgs.slice(-50) });
});

app.post('/api/public_messages', (req, res) => {
  const { sender_id, sender_name, text, lat, lng, radius } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ success: false, error: 'Empty text' });
  const msg = {
    id: 'pub_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    sender_id: sender_id || 'anonymous',
    sender_name: sender_name || 'کاربر',
    text: text.trim(),
    lat: lat != null ? Number(lat) : null,
    lng: lng != null ? Number(lng) : null,
    radius: radius != null ? Number(radius) : 25,
    created_at: new Date().toISOString()
  };
  publicMessages.push(msg);
  if (publicMessages.length > 300) publicMessages = publicMessages.slice(-300);
  persistDB();
  pgInsertPublicMessage(msg);
  broadcastSSE('public_msg', msg);
  res.json({ success: true, message: msg });
});

// Direct Messaging API
app.get('/api/messages', (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) return res.json({ success: true, messages: [] });
  const key = [user1, user2].sort().join('_');
  res.json({ success: true, messages: directMessages[key] || [] });
});

app.post('/api/messages', (req, res) => {
  const { sender_id, receiver_id, text, audio_url, media_url, media_type, location, poll, contact, file_info, reply_to, reply_text, forward_from } = req.body || {};
  if (!sender_id || !receiver_id || (!text && !audio_url && !media_url && !location && !poll && !contact && !file_info)) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }
  
  const key = [sender_id, receiver_id].sort().join('_');
  if (!directMessages[key]) directMessages[key] = [];
  
  const msg = {
    id: 'dm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    sender_id,
    receiver_id,
    text: text ? text.trim() : null,
    audio_url: audio_url || null,
    media_url: media_url || null,
    media_type: media_type || null,
    location: location || null,
    poll: poll || null,
    contact: contact || null,
    file_info: file_info || null,
    reply_to: reply_to || null,
    reply_text: reply_text || null,
    forward_from: forward_from || null,
    reactions: {},
    created_at: new Date().toISOString(),
    status: 'delivered'
  };
  
  directMessages[key].push(msg);
  persistDB();
  pgInsertMessage(msg, key);
  broadcastSSE('dm_msg', msg);
  res.json({ success: true, message: msg });
});

app.post('/api/messages/poll_vote', (req, res) => {
  const { user1, user2, msg_id, option_index, user_id } = req.body;
  if (!user1 || !user2 || !msg_id || option_index === undefined || !user_id) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }

  const key = [user1, user2].sort().join('_');
  const msgList = directMessages[key];
  if (!msgList) return res.status(404).json({ success: false, error: 'Chat not found' });

  const msg = msgList.find(m => m.id === msg_id);
  if (!msg || !msg.poll) return res.status(404).json({ success: false, error: 'Poll not found' });

  // Remove existing vote by user across all options
  msg.poll.options.forEach(opt => {
    if (!opt.votes) opt.votes = [];
    opt.votes = opt.votes.filter(u => u !== user_id);
  });

  const selectedOpt = msg.poll.options[option_index];
  if (selectedOpt) {
    if (!selectedOpt.votes) selectedOpt.votes = [];
    selectedOpt.votes.push(user_id);
  }

  persistDB();
  broadcastSSE('dm_poll_vote', { msg_id, poll: msg.poll, key });
  res.json({ success: true, poll: msg.poll });
});

app.post('/api/messages/reaction', (req, res) => {
  const { user1, user2, msg_id, emoji, user_id } = req.body;
  if (!user1 || !user2 || !msg_id || !emoji) return res.status(400).json({ success: false, error: 'Missing parameters' });

  const key = [user1, user2].sort().join('_');
  const msgList = directMessages[key];
  if (!msgList) return res.status(404).json({ success: false, error: 'Chat not found' });

  const msg = msgList.find(m => m.id === msg_id);
  if (!msg) return res.status(404).json({ success: false, error: 'Message not found' });

  if (!msg.reactions) msg.reactions = {};
  if (typeof msg.reactions[emoji] === 'number') {
    msg.reactions[emoji] = msg.reactions[emoji] + 1;
  } else if (Array.isArray(msg.reactions[emoji])) {
    const uIdx = msg.reactions[emoji].indexOf(user_id);
    if (uIdx >= 0) msg.reactions[emoji].splice(uIdx, 1);
    else msg.reactions[emoji].push(user_id);
  } else {
    msg.reactions[emoji] = (msg.reactions[emoji] || 0) + 1;
  }

  persistDB();
  broadcastSSE('msg_reaction', { msg_id, reactions: msg.reactions, key });
  res.json({ success: true, reactions: msg.reactions });
});

// Mark messages as seen/read (Telegram double checkmark ✓✓)
app.post('/api/messages/seen', (req, res) => {
  const { user1, user2, reader_id } = req.body || {};
  if (!user1 || !user2) return res.status(400).json({ success: false, error: 'Missing users' });

  const key = [user1, user2].sort().join('_');
  const msgList = directMessages[key];
  if (!msgList) return res.json({ success: true, updated: 0 });

  let updated = 0;
  msgList.forEach(m => {
    if (m.receiver_id === reader_id && m.status !== 'read') {
      m.status = 'read';
      m.seen = true;
      updated++;
    }
  });

  if (updated > 0) {
    persistDB();
    broadcastSSE('msg_seen', { key, reader_id, time: new Date().toISOString() });
  }
  res.json({ success: true, updated });
});

// Real-time typing status broadcast
app.post('/api/messages/typing', (req, res) => {
  const { user_id, user_name, user_avatar, to_user_id } = req.body || {};
  if (!user_id || !to_user_id) return res.status(400).json({ success: false });

  broadcastSSE('typing', { user_id, user_name, user_avatar, to_user_id });
  res.json({ success: true });
});

// Edit message (Telegram style)
app.put('/api/messages/:id', (req, res) => {
  const { id } = req.params;
  const { user1, user2, text, editor_id } = req.body || {};
  if (!user1 || !user2 || !text) return res.status(400).json({ success: false, error: 'Missing parameters' });

  const key = [user1, user2].sort().join('_');
  const msgList = directMessages[key];
  if (!msgList) return res.status(404).json({ success: false, error: 'Chat not found' });

  const msg = msgList.find(m => m.id === id);
  if (!msg) return res.status(404).json({ success: false, error: 'Message not found' });
  if (editor_id && msg.sender_id !== editor_id) return res.status(403).json({ success: false, error: 'Unauthorized' });

  msg.text = text.trim();
  msg.edited_at = new Date().toISOString();
  persistDB();
  broadcastSSE('msg_edited', { id, text: msg.text, edited_at: msg.edited_at, key });
  res.json({ success: true, message: msg });
});

// Pin/Unpin message (Telegram style)
app.post('/api/messages/pin', (req, res) => {
  const { user1, user2, msg_id, is_pinned } = req.body || {};
  if (!user1 || !user2) return res.status(400).json({ success: false });

  const key = [user1, user2].sort().join('_');
  const msgList = directMessages[key];
  if (!msgList) return res.status(404).json({ success: false });

  const msg = msgList.find(m => m.id === msg_id);
  if (msg) {
    msg.is_pinned = !!is_pinned;
    persistDB();
    broadcastSSE('msg_pinned', { msg_id, is_pinned: msg.is_pinned, key, text: msg.text });
  }
  res.json({ success: true });
});

// Clear chat history (Telegram style)
app.post('/api/messages/clear', (req, res) => {
  const { user1, user2 } = req.body || {};
  if (!user1 || !user2) return res.status(400).json({ success: false });

  const key = [user1, user2].sort().join('_');
  directMessages[key] = [];
  persistDB();
  broadcastSSE('chat_cleared', { key });
  res.json({ success: true });
});

app.delete('/api/messages/:id', (req, res) => {
  const { id } = req.params;
  const user1 = req.query.user1 || req.body.user1;
  const user2 = req.query.user2 || req.body.user2;
  if (!user1 || !user2) return res.status(400).json({ success: false, error: 'Missing users' });

  const key = [user1, user2].sort().join('_');
  if (directMessages[key]) {
    directMessages[key] = directMessages[key].filter(m => m.id !== id);
    persistDB();
    broadcastSSE('msg_deleted', { id, key });
    return res.json({ success: true });
  }
  res.status(404).json({ success: false, error: 'Message not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(` GeoSocial Server running with Mobile Auth:`);
  console.log(` > Local:   http://localhost:${PORT}`);
  console.log(` > Network: http://0.0.0.0:${PORT}`);
  console.log(` > Phone OTP Authentication Active!`);
  console.log(`=========================================`);
});
