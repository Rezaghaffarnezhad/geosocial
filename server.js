const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');

// Full permissive CORS for Mobile App / Web / Cross-Origin requests
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Initial Seed Users with Phone Numbers
const defaultUsers = [
  {
    id: 'usr_09121111111',
    phone: '09121111111',
    name: 'حساب اول (کاربر ۱)',
    username: 'user_09121111111',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
    bio: 'حساب اول وارد شده با شماره موبایل 📱',
    city: 'تهران - ولیعصر',
    lat: 35.6982,
    lng: 51.4020,
    ghost: false,
    online: true,
    last_seen: new Date().toISOString()
  },
  {
    id: 'usr_09122222222',
    phone: '09122222222',
    name: 'حساب دوم (کاربر ۲)',
    username: 'user_09122222222',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
    bio: 'حساب دوم وارد شده با شماره موبایل 📱',
    city: 'تهران - انقلاب',
    lat: 35.6882,
    lng: 51.3910,
    ghost: false,
    online: true,
    last_seen: new Date().toISOString()
  }
];

const defaultPublicMessages = [
  { id: 'pub_1', sender_id: 'sys', sender_name: 'سیستم GeoSocial', text: 'به چت عمومی محیطی خوش آمدید! ورود با شماره موبایل فعال شد 📱', created_at: new Date().toISOString() }
];

const defaultStories = [
  {
    id: 'st_demo1',
    user_id: 'usr_09121111111',
    user_name: 'حساب اول (کاربر ۱)',
    user_avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
    media_url: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=600&auto=format&fit=crop&q=80',
    media_type: 'image',
    caption: 'استوری تستی حساب موبایل ☕',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    likes: ['usr_09122222222'],
    comments: [
      { user_name: 'کاربر ۲', text: 'درود، تست عالی کار میکنه!' }
    ]
  }
];

let users = [...defaultUsers];
let publicMessages = [...defaultPublicMessages];
let directMessages = {};
let stories = [...defaultStories];
let activeOTPs = {}; // { phone: { code: '1234', expires: timestamp } }

// Load persisted DB from disk if available
try {
  if (fs.existsSync(DB_FILE)) {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.users && Array.isArray(parsed.users)) users = parsed.users;
    if (parsed.publicMessages && Array.isArray(parsed.publicMessages)) publicMessages = parsed.publicMessages;
    if (parsed.directMessages && typeof parsed.directMessages === 'object') directMessages = parsed.directMessages;
    if (parsed.stories && Array.isArray(parsed.stories)) stories = parsed.stories;
    console.log('📦 Loaded database from disk:', DB_FILE);
  }
} catch (e) {
  console.error('Error loading database:', e.message);
}

let saveTimeout = null;
function persistDB() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const data = { users, publicMessages, directMessages, stories };
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving database:', e.message);
    }
  }, 1000);
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

  const clientId = Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  sseClients.push({ id: clientId, res });

  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', time: new Date().toISOString() })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
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
    public_messages_count: publicMessages.length
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

// SMS & Telegram Gateway Integration Configuration
const SMS_CONFIG = {
  // Telegram Bot Token
  telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '8186173027:AAHY6oTA7TF0NWbgD_KaajJgqBZtyAu6EPc',
  telegram_bot_username: process.env.TELEGRAM_BOT_USERNAME || 'RezaProFx_bot',
  
  // SMS Gateways
  kavenegar_api_key: process.env.KAVENEGAR_API_KEY || '',
  kavenegar_template: process.env.KAVENEGAR_TEMPLATE || 'verify',
  faraz_api_key: process.env.FARAZ_API_KEY || '',
  faraz_pattern_code: process.env.FARAZ_PATTERN_CODE || '',
  faraz_originator: process.env.FARAZ_ORIGINATOR || '+983000505'
};

const https = require('https');

// Send Message directly to a specific Telegram Chat ID
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
        res.on('end', () => {
          resolve({ success: true, data });
        });
      });

      req.on('timeout', () => { req.destroy(); trySend(idx + 1); });
      req.on('error', () => trySend(idx + 1));
      req.write(payload);
      req.end();
    }

    trySend(0);
  });
}

// Telegram Bot Poller with anti-censorship proxy rotation
let lastTelegramUpdateId = 0;
function startTelegramBotPoller() {
  if (!SMS_CONFIG.telegram_bot_token) return;

  const hosts = [
    'api.telegram.org',
    'api.telegram-proxy.org'
  ];

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

// Handle incoming message from any Telegram user
function handleTelegramUpdate(update) {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const fromUser = msg.from;

  // 1. User shared their Phone Number via Contact Button
  if (msg.contact && msg.contact.phone_number) {
    const rawPhone = msg.contact.phone_number;
    const cleanPhone = normalizePhone(rawPhone);

    const code = Math.floor(1000 + Math.random() * 9000).toString();
    activeOTPs[cleanPhone] = {
      code: code,
      expires: Date.now() + 180000
    };

    const replyText = `🔐 <b>کد تایید ورود شما به ژئوسوشیال:</b>\n\n<code>${code}</code>\n\n📱 شماره تلفن: <code>${cleanPhone}</code>\n⏱ اعتبار: ۳ دقیقه\n\nاین کد را در برنامه وارد کنید تا وارد شوید.`;
    
    sendTelegramMessage(chatId, replyText, {
      remove_keyboard: true
    });
    console.log(`📱 Issued OTP ${code} to Telegram user ${chatId} (${cleanPhone})`);
    return;
  }

  // 2. User started the bot
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

// Start bot listener
startTelegramBotPoller();

// Send Real SMS / Telegram OTP
async function sendRealSMS(receptor, code) {
  return new Promise((resolve) => {
    // Priority 1: Kavenegar
    if (SMS_CONFIG.kavenegar_api_key) {
      const url = `https://api.kavenegar.com/v1/${SMS_CONFIG.kavenegar_api_key}/verify/lookup.json?receptor=${receptor}&token=${code}&template=${SMS_CONFIG.kavenegar_template}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log(`[SMS-Kavenegar] Response for ${receptor}:`, data);
          resolve({ provider: 'kavenegar', success: true });
        });
      }).on('error', (err) => {
        console.error(`[SMS-Kavenegar] Error sending to ${receptor}:`, err.message);
        resolve({ provider: 'kavenegar', success: false, error: err.message });
      });
      return;
    }

    // Priority 2: FarazSMS / IPPanel
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
        res.on('end', () => {
          console.log(`[SMS-Faraz] Response for ${receptor}:`, data);
          resolve({ provider: 'faraz', success: true });
        });
      });
      req.on('error', (err) => {
        console.error(`[SMS-Faraz] Error:`, err.message);
        resolve({ provider: 'faraz', success: false, error: err.message });
      });
      req.write(postData);
      req.end();
      return;
    }

    // Fallback: Simulator mode
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

  // Generate 4-digit random OTP
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  activeOTPs[cleanPhone] = {
    code: code,
    expires: Date.now() + 180000 // 3 minutes validity
  };

  const existingUser = users.find(u => u.phone === cleanPhone || u.id === 'usr_' + cleanPhone);

  console.log(`📱 SMS OTP Code for ${cleanPhone}: [${code}]`);

  // Dispatch SMS / Telegram in background (non-blocking so connection never hangs)
  sendRealSMS(cleanPhone, code).catch(err => console.error('SMS background error:', err));

  const hasGateway = (SMS_CONFIG.telegram_bot_token && SMS_CONFIG.telegram_chat_id) || SMS_CONFIG.kavenegar_api_key || SMS_CONFIG.faraz_api_key;

  res.json({
    success: true,
    phone: cleanPhone,
    is_new_user: !existingUser,
    user_name: existingUser ? existingUser.name : null,
    has_real_gateway: !!hasGateway,
    code: code, // keep in payload so user is never stuck if ISP blocks telegram
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

  // Remove used OTP
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
      city: city || 'تهران',
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
  res.json({ success: true, user });
});

// 3. Direct Telegram Profile Login (Instant Auth with User's Real Telegram Profile)
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
      city: 'تهران',
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
  console.log(`🚀 Instant Telegram Login for ${user.name} (@${user.username})`);
  res.json({ success: true, user });
});

// Users & Locations API
app.get('/api/users', (req, res) => {
  const currentUserId = req.query.user_id;
  const filtered = users.filter(u => !u.ghost && u.id !== currentUserId);
  res.json({ success: true, users: filtered });
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

  persistDB();
  broadcastSSE('user_update', user);
  res.json({ success: true, user });
});

// Stories API
app.get('/api/stories', (req, res) => {
  const now = new Date().toISOString();
  const active = stories.filter(s => !s.expires_at || s.expires_at > now);
  res.json({ success: true, stories: active });
});

app.post('/api/stories', (req, res) => {
  const { user_id, user_name, user_avatar, media_url, media_type, caption } = req.body || {};
  if (!user_id || !media_url) return res.status(400).json({ success: false, error: 'Missing story data' });
  
  const newStory = {
    id: 'st_' + Date.now(),
    user_id,
    user_name: user_name || 'کاربر',
    user_avatar: user_avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
    media_url,
    media_type: media_type || 'image',
    caption: caption || '',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    likes: [],
    comments: []
  };

  stories.unshift(newStory);
  persistDB();
  broadcastSSE('new_story', newStory);
  res.json({ success: true, story: newStory });
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
  broadcastSSE('story_like', { story_id, likes: story.likes });
  res.json({ success: true, likes: story.likes });
});

app.post('/api/stories/comment', (req, res) => {
  const { story_id, user_name, text } = req.body;
  const story = stories.find(s => s.id === story_id);
  if (!story) return res.status(404).json({ success: false, error: 'Story not found' });
  
  if (!story.comments) story.comments = [];
  const comment = { user_name: user_name || 'کاربر', text: text.trim(), created_at: new Date().toISOString() };
  story.comments.push(comment);

  persistDB();
  broadcastSSE('story_comment', { story_id, comment });
  res.json({ success: true, comments: story.comments });
});

// Public Chat API
app.get('/api/public_messages', (req, res) => {
  res.json({ success: true, messages: publicMessages.slice(-50) });
});

app.post('/api/public_messages', (req, res) => {
  const { sender_id, sender_name, text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ success: false, error: 'Empty text' });
  const msg = {
    id: 'pub_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    sender_id: sender_id || 'anonymous',
    sender_name: sender_name || 'کاربر',
    text: text.trim(),
    created_at: new Date().toISOString()
  };
  publicMessages.push(msg);
  if (publicMessages.length > 200) publicMessages = publicMessages.slice(-200);
  persistDB();
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
  const { sender_id, receiver_id, text, audio_url, reply_to, reply_text } = req.body || {};
  if (!sender_id || !receiver_id || (!text && !audio_url)) return res.status(400).json({ success: false, error: 'Missing parameters' });
  
  const key = [sender_id, receiver_id].sort().join('_');
  if (!directMessages[key]) directMessages[key] = [];
  
  const msg = {
    id: 'dm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    sender_id,
    receiver_id,
    text: text ? text.trim() : null,
    audio_url: audio_url || null,
    reply_to: reply_to || null,
    reply_text: reply_text || null,
    created_at: new Date().toISOString(),
    status: 'delivered'
  };
  
  directMessages[key].push(msg);
  persistDB();
  broadcastSSE('dm_msg', msg);
  res.json({ success: true, message: msg });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(` GeoSocial Server running with Mobile Auth:`);
  console.log(` > Local:   http://localhost:${PORT}`);
  console.log(` > Network: http://0.0.0.0:${PORT}`);
  console.log(` > Phone OTP Authentication Active!`);
  console.log(`=========================================`);
});
