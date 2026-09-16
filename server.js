const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');

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

// Real Dynamic Users (No fake seed users)
let users = [];
let publicMessages = [];
let directMessages = {};
let stories = [];
let highlights = [];
let posts = [];
let follows = {}; // { userId: [followingUserIds] }
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
    if (parsed.highlights && Array.isArray(parsed.highlights)) highlights = parsed.highlights;
    if (parsed.posts && Array.isArray(parsed.posts)) posts = parsed.posts;
    if (parsed.follows && typeof parsed.follows === 'object') follows = parsed.follows;
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
      const data = { users, publicMessages, directMessages, stories, highlights, posts, follows };
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

// Alias for /api/sse so both SSE paths work reliably
app.get('/api/sse', (req, res) => {
  res.redirect(307, '/api/events');
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
    broadcastSSE('story_view', { story_id, views_count: story.views.length });
  }

  res.json({ success: true, views_count: story.views.length, views: story.views });
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
  const { story_id, user_id, user_name, user_avatar, text } = req.body;
  const story = stories.find(s => s.id === story_id);
  if (!story) return res.status(404).json({ success: false, error: 'Story not found' });
  
  if (!story.comments) story.comments = [];
  const comment = {
    id: 'cm_' + Date.now(),
    user_id: user_id || 'guest',
    user_name: user_name || 'کاربر',
    user_avatar: user_avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
    text: text.trim(),
    created_at: new Date().toISOString()
  };
  story.comments.push(comment);

  persistDB();
  broadcastSSE('story_comment', { story_id, comment });
  res.json({ success: true, comments: story.comments });
});

app.post('/api/stories/vote_poll', (req, res) => {
  const { story_id, sticker_id, option_index, user_id } = req.body;
  const story = stories.find(s => s.id === story_id);
  if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

  if (!story.poll_votes) story.poll_votes = {};
  const pollKey = sticker_id || 'default_poll';
  if (!story.poll_votes[pollKey]) story.poll_votes[pollKey] = {};

  // Remove previous vote by user
  Object.keys(story.poll_votes[pollKey]).forEach(k => {
    story.poll_votes[pollKey][k] = (story.poll_votes[pollKey][k] || []).filter(u => u !== user_id);
  });

  const optKey = String(option_index);
  if (!story.poll_votes[pollKey][optKey]) story.poll_votes[pollKey][optKey] = [];
  story.poll_votes[pollKey][optKey].push(user_id);

  persistDB();
  broadcastSSE('story_poll_vote', { story_id, poll_key: pollKey, votes: story.poll_votes[pollKey] });
  res.json({ success: true, votes: story.poll_votes[pollKey] });
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
  if (!user_id || !title) return res.status(400).json({ success: false, error: 'Missing parameters' });

  const newHighlight = {
    id: 'hl_' + Date.now(),
    user_id,
    title: title.trim(),
    cover_url: cover_url || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
    story_ids: story_ids || [],
    created_at: new Date().toISOString()
  };

  highlights.unshift(newHighlight);
  persistDB();
  broadcastSSE('new_highlight', newHighlight);
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

// Posts & Shared Media API
app.get('/api/posts', (req, res) => {
  const { user_id } = req.query;
  const list = user_id ? posts.filter(p => p.user_id === user_id) : posts;
  res.json({ success: true, posts: list });
});

app.post('/api/posts', (req, res) => {
  const { user_id, user_name, user_avatar, media_url, caption } = req.body;
  if (!user_id || !media_url) return res.status(400).json({ success: false, error: 'Missing post data' });

  const newPost = {
    id: 'post_' + Date.now(),
    user_id,
    user_name: user_name || 'کاربر',
    user_avatar: user_avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
    media_url,
    caption: caption || '',
    created_at: new Date().toISOString(),
    likes: [],
    comments: []
  };

  posts.unshift(newPost);
  persistDB();
  broadcastSSE('new_post', newPost);
  res.json({ success: true, post: newPost });
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
