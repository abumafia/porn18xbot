const { Telegraf, Markup, session } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');

// SOZLAMALAR
const BOT_TOKEN = '8504888393:AAHUV2fMIjvo00feV_tJhKtHdwhnX_eJNm8';
const MONGODB_URL = 'mongodb+srv://abumafia0:abumafia0@abumafia.h1trttg.mongodb.net/kinojanbot?appName=abumafia';

// Adminlar ro'yxati
const ADMIN_IDS = [6606638731, 901126203];

// Render.com muhit o'zgaruvchilari
const PORT = process.env.PORT || 10000;
const URL = process.env.RENDER_EXTERNAL_URL || process.env.URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'super_secret_token_123';

// MongoDB ulanish
mongoose.connect(MONGODB_URL)
    .then(() => console.log('✅ MongoDB ulandi'))
    .catch(err => console.error('❌ MongoDB xatosi:', err));

// Schemalar
const userSchema = new mongoose.Schema({
    user_id: { type: Number, required: true, unique: true },
    username: String,
    first_name: String,
    join_date: { type: Date, default: Date.now }
});

const movieSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    file_id: { type: String, required: true },
    caption: String,
    file_type: { type: String, default: 'video' },
    date: { type: Date, default: Date.now }
});

// Kengaytirilgan subscription schema
const subscriptionSchema = new mongoose.Schema({
    title: { type: String, required: true },
    url: { type: String, required: true, unique: true },
    type: { 
        type: String, 
        enum: ['channel', 'group', 'private_channel', 'social', 'website'], 
        required: true 
    },
    icon: { type: String, default: '🔗' },
    order: { type: Number, default: 0 },
    is_required: { type: Boolean, default: true }
});

const User = mongoose.model('User', userSchema);
const Movie = mongoose.model('Movie', movieSchema);
const Subscription = mongoose.model('Subscription', subscriptionSchema);

// Bot yaratish
const bot = new Telegraf(BOT_TOKEN);

// Session middleware - to'g'ri konfiguratsiya
const sessionMiddleware = session({
    defaultSession: () => ({
        addingMovie: false,
        movieData: null,
        waitingForCode: false,
        broadcasting: false,
        addingLink: null,
        deletingLink: null
    })
});

bot.use(sessionMiddleware);

// Admin tekshirish
function isAdmin(userId) {
    return ADMIN_IDS.includes(Number(userId));
}

// Iconlar ro'yxati
const TYPE_ICONS = {
    channel: '📢',
    group: '👥',
    private_channel: '🔒',
    social: '🌐',
    website: '🌍'
};

// Telegram username chiqarish
function extractTelegramUsername(url) {
    try {
        if (!url) return null;
        
        // t.me/username format
        if (url.includes('t.me/')) {
            const match = url.match(/t\.me\/([^/?]+)/);
            if (match) {
                const username = match[1];
                if (username.startsWith('+')) {
                    return null; // Maxfiy kanal
                }
                return username;
            }
        }
        
        // https://t.me/username format
        if (url.includes('https://t.me/')) {
            const match = url.match(/https:\/\/t\.me\/([^/?]+)/);
            if (match) {
                const username = match[1];
                if (username.startsWith('+')) {
                    return null;
                }
                return username;
            }
        }
        
        // @username format
        if (url.startsWith('@')) {
            return url.substring(1);
        }
        
        return null;
    } catch (error) {
        console.error('Username extract error:', error);
        return null;
    }
}

// Obuna tekshirish
async function checkRequiredSubscriptions(userId) {
    if (isAdmin(userId)) return { success: true };

    try {
        // Faqat zarur va tekshirish mumkin bo'lgan kanallar
        const requiredSubs = await Subscription.find({
            type: { $in: ['channel', 'group'] },
            is_required: true
        });
        
        if (requiredSubs.length === 0) return { success: true, message: 'Majburiy obuna yo\'q' };

        const notSubscribed = [];
        
        for (const sub of requiredSubs) {
            const username = extractTelegramUsername(sub.url);
            
            if (!username) {
                console.log(`Maxfiy kanal: ${sub.title}, tekshirilmaydi`);
                continue;
            }
            
            try {
                const member = await bot.telegram.getChatMember(`@${username}`, userId);
                const status = member.status;
                
                if (status === 'left' || status === 'kicked') {
                    notSubscribed.push(sub.title);
                }
            } catch (error) {
                console.error(`Obuna tekshirish xatosi (@${username}):`, error.message);
                // Agar kanal topilmasa yoki bot admin bo'lmasa, o'tkazib yuboramiz
                continue;
            }
        }
        
        if (notSubscribed.length > 0) {
            return { 
                success: false, 
                message: `Quyidagi kanallarga obuna bo'lmagansiz:\n${notSubscribed.map(name => `• ${name}`).join('\n')}` 
            };
        }
        
        return { success: true, message: 'Barcha obunalarga a\'zosiz' };
    } catch (error) {
        console.error('Obunalar xatosi:', error);
        return { success: false, message: 'Obuna tekshirishda xatolik' };
    }
}

// Barcha havolalar uchun klaviatura
async function getLinksKeyboard() {
    try {
        const subs = await Subscription.find().sort('order');
        
        if (subs.length === 0) {
            return Markup.inlineKeyboard([
                [Markup.button.callback('✅ Obunalarni tekshirish', 'check_subscription')]
            ]);
        }
        
        const rows = subs.map(sub => {
            const icon = TYPE_ICONS[sub.type] || sub.icon;
            return [Markup.button.url(`${icon} ${sub.title}`, sub.url)];
        });
        
        rows.push([Markup.button.callback('✅ Obunalarni tekshirish', 'check_subscription')]);
        return Markup.inlineKeyboard(rows);
    } catch (error) {
        console.error('Klaviatura yaratish xatosi:', error);
        return Markup.inlineKeyboard([
            [Markup.button.callback('✅ Obunalarni tekshirish', 'check_subscription')]
        ]);
    }
}

// User qo'shish/tekshirish
async function ensureUser(userId, username = null, firstName = null) {
    try {
        const existing = await User.findOne({ user_id: userId });
        if (!existing) {
            await User.create({
                user_id: userId,
                username: username,
                first_name: firstName
            });
            return false; // Yangi foydalanuvchi
        }
        return true; // Mavjud foydalanuvchi
    } catch (error) {
        console.error('User qo\'shish xatosi:', error);
        return false;
    }
}

// ====================== ASOSIY HANDLERLAR ======================

// START HANDLER
bot.start(async (ctx) => {
    try {
        const userId = ctx.from.id;
        const username = ctx.from.username;
        const firstName = ctx.from.first_name;
        
        console.log(`🚀 Start bosildi: ${userId} - @${username || 'no_username'}`);
        
        await ensureUser(userId, username, firstName);
        
        const checkResult = await checkRequiredSubscriptions(userId);
        
        if (!checkResult.success && !isAdmin(userId)) {
            const keyboard = await getLinksKeyboard();
            return ctx.reply(
                `🎬 *Kino Botiga xush kelibsiz!*\n\n${checkResult.message}\n\n` +
                'Botdan foydalanish uchun quyidagi kanallarga obuna bo\'ling va "✅ Obunalarni tekshirish" tugmasini bosing:',
                { 
                    parse_mode: 'Markdown',
                    ...keyboard 
                }
            );
        }

        if (isAdmin(userId)) {
            const adminKeyboard = Markup.keyboard([
                ['🎬 Kino qoʻshish', '📊 Statistika'],
                ['📢 Broadcast', '🔗 Havola qoʻshish'],
                ['📋 Havolalar roʻyxati', '➖ Havola oʻchirish'],
                ['🏠 Bosh menyu']
            ]).resize().oneTime();
            
            return ctx.reply('👨‍💻 *Admin panelga xush kelibsiz!*', { 
                parse_mode: 'Markdown',
                ...adminKeyboard 
            });
        }

        ctx.reply(
            '🎥 *Botga xush kelibsiz!*\n\n' +
            'Kino olish uchun kod yuboring (masalan: 123)\n' +
            '⚠️ *Diqqat:* Bot 18+ kontent uchun mo\'ljallangan!',
            {
                parse_mode: 'Markdown',
                ...(await getLinksKeyboard())
            }
        );
    } catch (error) {
        console.error('Start handler xatosi:', error);
        ctx.reply('❌ Xatolik yuz berdi. Iltimos, qayta urinib ko\'ring.');
    }
});

// Obuna tekshirish
bot.action('check_subscription', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        
        console.log(`🔍 Obuna tekshirildi: ${userId}`);
        
        const checkResult = await checkRequiredSubscriptions(userId);
        
        if (checkResult.success || isAdmin(userId)) {
            await ensureUser(userId, ctx.from.username, ctx.from.first_name);
            
            if (isAdmin(userId)) {
                const adminKeyboard = Markup.keyboard([
                    ['🎬 Kino qoʻshish', '📊 Statistika'],
                    ['📢 Broadcast', '🔗 Havola qoʻshish'],
                    ['📋 Havolalar roʻyxati', '➖ Havola oʻchirish'],
                    ['🏠 Bosh menyu']
                ]).resize().oneTime();
                
                return ctx.reply('✅ *Obuna tasdiqlandi!*\nAdmin panelga xush kelibsiz!', { 
                    parse_mode: 'Markdown',
                    ...adminKeyboard 
                });
            }
            
            return ctx.reply('✅ *Obuna tasdiqlandi!*\n\nEndi kino olish uchun kod yuboring.', {
                parse_mode: 'Markdown'
            });
        }

        const keyboard = await getLinksKeyboard();
        return ctx.reply(`❌ ${checkResult.message}\n\nIltimos, obuna bo\'ling va tekshirish tugmasini bosing:`, {
            parse_mode: 'Markdown',
            ...keyboard
        });
    } catch (error) {
        console.error('Check subscription xatosi:', error);
        ctx.answerCbQuery('❌ Xatolik yuz berdi');
    }
});

// ====================== ADMIN FUNKSIYALARI ======================

// Kino qo'shish
bot.hears('🎬 Kino qoʻshish', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    
    ctx.session.addingMovie = true;
    ctx.session.waitingForCode = false;
    ctx.session.movieData = null;
    
    ctx.reply(
        '🎬 *Kino qoʻshish rejimi yoqildi!*\n\n' +
        'Endi video yuboring yoki forward qiling.\n' +
        'Videoga izoh qo\'shishingiz mumkin.\n' +
        'Keyin sizdan kino kodi so\'raladi.',
        { parse_mode: 'Markdown' }
    );
});

// Video qabul qilish
bot.on('video', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    
    if (!ctx.session.addingMovie) return;

    try {
        const video = ctx.message.video;
        const caption = ctx.message.caption || '';
        
        console.log(`Video qabul qilindi: ${video.file_id}`);
        
        ctx.session.movieData = {
            file_id: video.file_id,
            caption: caption,
            file_type: 'video'
        };
        ctx.session.waitingForCode = true;
        
        ctx.reply('✅ *Video qabul qilindi!*\n\nEndi kino kodi yuboring (faqat raqamlar):', { 
            parse_mode: 'Markdown' 
        });
    } catch (error) {
        console.error('Video qabul qilish xatosi:', error);
        ctx.reply('❌ Video qabul qilishda xatolik. Qayta urinib ko\'ring.');
    }
});

// Document qabul qilish (video fayllar ham document sifatida kelishi mumkin)
bot.on('document', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    
    if (!ctx.session.addingMovie) return;

    const doc = ctx.message.document;
    const mimeType = doc.mime_type || '';
    
    // Agar video fayl bo'lsa
    if (mimeType.startsWith('video/')) {
        try {
            console.log(`Video document qabul qilindi: ${doc.file_id}`);
            
            ctx.session.movieData = {
                file_id: doc.file_id,
                caption: ctx.message.caption || '',
                file_type: 'document'
            };
            ctx.session.waitingForCode = true;
            
            ctx.reply('✅ *Video fayl qabul qilindi!*\n\nEndi kino kodi yuboring (faqat raqamlar):', { 
                parse_mode: 'Markdown' 
            });
        } catch (error) {
            console.error('Document qabul qilish xatosi:', error);
            ctx.reply('❌ Video fayl qabul qilishda xatolik.');
        }
    }
});

// Statistika
bot.hears('📊 Statistika', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    
    try {
        const users = await User.countDocuments();
        const movies = await Movie.countDocuments();
        const subs = await Subscription.countDocuments();
        
        const channelSubs = await Subscription.countDocuments({ type: 'channel' });
        const groupSubs = await Subscription.countDocuments({ type: 'group' });
        const privateSubs = await Subscription.countDocuments({ type: 'private_channel' });
        const otherSubs = subs - channelSubs - groupSubs - privateSubs;
        
        ctx.reply(
            `📊 *Bot statistikasi:*\n\n` +
            `👥 Foydalanuvchilar: ${users}\n` +
            `🎬 Kinolar soni: ${movies}\n` +
            `🔗 Jami havolalar: ${subs}\n` +
            `   ├ Kanal: ${channelSubs}\n` +
            `   ├ Guruh: ${groupSubs}\n` +
            `   ├ Maxfiy kanal: ${privateSubs}\n` +
            `   └ Boshqa: ${otherSubs}`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        console.error('Statistika xatosi:', err);
        ctx.reply('❌ Statistika olishda xatolik');
    }
});

// Broadcast
bot.hears('📢 Broadcast', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    
    ctx.session.broadcasting = true;
    ctx.reply(
        '📢 *Broadcast rejimi yoqildi!*\n\n' +
        'Barcha foydalanuvchilarga yubormoqchi bo\'lgan xabaringizni yuboring.',
        { parse_mode: 'Markdown' }
    );
});

// Havola qo'shish boshlash
bot.hears('🔗 Havola qoʻshish', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    
    const typeKeyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('📢 Oddiy kanal', 'add_link_channel'),
            Markup.button.callback('🔒 Maxfiy kanal', 'add_link_private_channel')
        ],
        [
            Markup.button.callback('👥 Guruh', 'add_link_group'),
            Markup.button.callback('🌐 Ijtimoiy tarmoq', 'add_link_social')
        ],
        [
            Markup.button.callback('🌍 Website', 'add_link_website')
        ]
    ]);
    
    ctx.reply('Qanday turdagi havola qo\'shmoqchisiz?', typeKeyboard);
});

// Havola turini tanlash
bot.action(/add_link_(.+)/, (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    
    const type = ctx.match[1];
    const typeNames = {
        'channel': '📢 Oddiy kanal',
        'private_channel': '🔒 Maxfiy kanal',
        'group': '👥 Guruh',
        'social': '🌐 Ijtimoiy tarmoq',
        'website': '🌍 Website'
    };
    
    ctx.session.addingLink = {
        type: type,
        step: 'title'
    };
    
    ctx.reply(`*${typeNames[type]} qo'shish*\n\nHavola uchun nom yozing:`, {
        parse_mode: 'Markdown'
    });
});

// Havolalar ro'yxatini ko'rish
bot.hears('📋 Havolalar roʻyxati', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    
    try {
        const subs = await Subscription.find().sort('order');
        
        if (subs.length === 0) {
            return ctx.reply('❌ Hozircha hech qanday havola mavjud emas.');
        }
        
        let message = '📋 *Barcha havolalar:*\n\n';
        
        subs.forEach((sub, index) => {
            const typeNames = {
                'channel': 'Kanal',
                'private_channel': 'Maxfiy kanal',
                'group': 'Guruh',
                'social': 'Ijtimoiy tarmoq',
                'website': 'Website'
            };
            
            message += `${index + 1}. *${sub.title}*\n`;
            message += `   🔗 ${sub.url}\n`;
            message += `   📝 Turi: ${typeNames[sub.type]}\n`;
            message += `   ⚙️ ID: \`${sub._id}\`\n\n`;
        });
        
        ctx.reply(message, { 
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error('Havolalar ro\'yxati xatosi:', error);
        ctx.reply('❌ Xatolik yuz berdi');
    }
});

// Bosh menyu
bot.hears('🏠 Bosh menyu', async (ctx) => {
    try {
        const userId = ctx.from.id;
        await ensureUser(userId, ctx.from.username, ctx.from.first_name);
        
        if (isAdmin(userId)) {
            const adminKeyboard = Markup.keyboard([
                ['🎬 Kino qoʻshish', '📊 Statistika'],
                ['📢 Broadcast', '🔗 Havola qoʻshish'],
                ['📋 Havolalar roʻyxati', '➖ Havola oʻchirish'],
                ['🏠 Bosh menyu']
            ]).resize().oneTime();
            
            return ctx.reply('🏠 *Bosh menyuga xush kelibsiz!*', { 
                parse_mode: 'Markdown',
                ...adminKeyboard 
            });
        }
        
        ctx.reply(
            '🎥 *Bosh menyu*\n\nKino olish uchun kod yuboring (masalan: 123)',
            {
                parse_mode: 'Markdown',
                ...(await getLinksKeyboard())
            }
        );
    } catch (error) {
        console.error('Bosh menyu xatosi:', error);
    }
});

// ====================== ASOSIY TEXT HANDLER ======================

bot.on('text', async (ctx) => {
    try {
        const text = ctx.message.text.trim();
        const userId = ctx.from.id;
        const isUserAdmin = isAdmin(userId);

        // Havola qo'shish jarayoni
        if (isUserAdmin && ctx.session.addingLink) {
            const step = ctx.session.addingLink.step;
            
            if (step === 'title') {
                ctx.session.addingLink.title = text;
                ctx.session.addingLink.step = 'url';
                
                return ctx.reply('✅ Nom qabul qilindi!\n\nEndi havola linkini yuboring:');
            }
            
            if (step === 'url') {
                const { title, type } = ctx.session.addingLink;
                
                // URL tekshirish
                if (!text.includes('://') && !text.includes('t.me/') && !text.startsWith('@')) {
                    return ctx.reply('❌ Noto\'g\'ri havola formati. http://, https://, t.me/ yoki @ bilan boshlansin.');
                }
                
                // To'liq URL yaratish
                let url = text;
                if (text.startsWith('t.me/')) {
                    url = `https://${text}`;
                } else if (text.startsWith('@')) {
                    url = `https://t.me/${text.substring(1)}`;
                }
                
                try {
                    // Order ni aniqlash
                    const count = await Subscription.countDocuments({ type });
                    const order = count + 1;
                    
                    await Subscription.create({
                        title: title,
                        url: url,
                        type: type,
                        icon: TYPE_ICONS[type],
                        order: order
                    });
                    
                    delete ctx.session.addingLink;
                    
                    return ctx.reply(`✅ *${title}* havolasi muvaffaqiyatli qo'shildi!`, {
                        parse_mode: 'Markdown'
                    });
                } catch (err) {
                    if (err.code === 11000) {
                        return ctx.reply('❌ Bu havola allaqachon mavjud.');
                    }
                    console.error('Havola qo\'shish xatosi:', err);
                    return ctx.reply('❌ Xatolik yuz berdi');
                }
            }
        }

        // Havola o'chirish (ID orqali)
        if (isUserAdmin && text === '➖ Havola oʻchirish') {
            try {
                const subs = await Subscription.find().sort('order');
                
                if (subs.length === 0) {
                    return ctx.reply('❌ Hozircha hech qanday havola mavjud emas.');
                }
                
                let message = '🗑️ *O\'chirish uchun havola tanlang:*\n\n';
                const keyboard = [];
                
                subs.forEach((sub, index) => {
                    message += `${index + 1}. ${sub.title} (ID: \`${sub._id}\`)\n`;
                    keyboard.push([Markup.button.callback(`❌ ${sub.title}`, `delete_${sub._id}`)]);
                });
                
                return ctx.reply(message, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard(keyboard)
                });
            } catch (error) {
                console.error('Havola o\'chirish xatosi:', error);
                return ctx.reply('❌ Xatolik yuz berdi');
            }
        }

        // Havola o'chirish callback
        if (text.startsWith('delete_') && isUserAdmin) {
            const id = text.substring(7);
            
            try {
                const sub = await Subscription.findById(id);
                if (!sub) {
                    return ctx.reply('❌ Havola topilmadi.');
                }
                
                await Subscription.deleteOne({ _id: id });
                
                return ctx.reply(`✅ *${sub.title}* havolasi muvaffaqiyatli o'chirildi!`, {
                    parse_mode: 'Markdown'
                });
            } catch (error) {
                console.error('Havola o\'chirish xatosi:', error);
                return ctx.reply('❌ Havola o\'chirishda xatolik');
            }
        }

        // Kino kodi qabul qilish
        if (isUserAdmin && ctx.session.waitingForCode && ctx.session.movieData) {
            const code = text;
            
            // Kodni tekshirish
            if (!/^\d{1,10}$/.test(code)) {
                return ctx.reply('❌ Kod faqat raqamlardan iborat bo\'lishi kerak (1-10 ta). Qayta kiriting:');
            }

            try {
                // Kino mavjudligini tekshirish
                const existing = await Movie.findOne({ code });
                if (existing) {
                    return ctx.reply(`⚠️ *${code}* kodi allaqachon mavjud. Boshqa kod kiriting:`, {
                        parse_mode: 'Markdown'
                    });
                }

                // Yangi kino yaratish
                await Movie.create({
                    code: code,
                    file_id: ctx.session.movieData.file_id,
                    caption: ctx.session.movieData.caption || `Kino kodi: ${code}`,
                    file_type: ctx.session.movieData.file_type
                });

                // Sessionni tozalash
                ctx.session.addingMovie = false;
                ctx.session.waitingForCode = false;
                delete ctx.session.movieData;

                return ctx.reply(`✅ *${code} kodli kino muvaffaqiyatli saqlandi!*\n\nYangi kino qo\'shish uchun "🎬 Kino qoʻshish" tugmasini bosing.`, {
                    parse_mode: 'Markdown'
                });
            } catch (err) {
                console.error('❌ Kino saqlash xatosi:', err);
                return ctx.reply('❌ Saqlashda xatolik yuz berdi. Qayta urinib ko\'ring.');
            }
        }

        // Broadcast qilish
        if (isUserAdmin && ctx.session.broadcasting) {
            try {
                const users = await User.find({});
                let success = 0;
                let failed = 0;
                
                // Progress xabari
                const progressMsg = await ctx.reply(`📤 Broadcast boshlanmoqda...\nJami: ${users.length} ta foydalanuvchi`);
                
                for (const user of users) {
                    try {
                        await ctx.telegram.copyMessage(user.user_id, ctx.chat.id, ctx.message.message_id);
                        success++;
                        
                        // Har 100ta xabardan keyin progress yangilash
                        if (success % 100 === 0) {
                            try {
                                await ctx.telegram.editMessageText(
                                    progressMsg.chat.id,
                                    progressMsg.message_id,
                                    null,
                                    `📤 Broadcast davom etmoqda...\nYuborildi: ${success}/${users.length}`
                                );
                            } catch (e) {
                                // Progressni yangilashda xatolik bo'lsa, davom etamiz
                            }
                        }
                        
                        // To'xtash uchun biroz kutish
                        await new Promise(resolve => setTimeout(resolve, 50));
                    } catch (e) {
                        failed++;
                    }
                }
                
                // Progress xabarini o'chirish
                try {
                    await ctx.telegram.deleteMessage(progressMsg.chat.id, progressMsg.message_id);
                } catch (e) {}
                
                ctx.session.broadcasting = false;
                
                return ctx.reply(
                    `✅ *Broadcast yakunlandi!*\n` +
                    `📤 Yuborildi: ${success} ta\n` +
                    `❌ Yuborilmadi: ${failed} ta`,
                    { parse_mode: 'Markdown' }
                );
            } catch (err) {
                console.error('Broadcast xatosi:', err);
                ctx.session.broadcasting = false;
                return ctx.reply('❌ Broadcastda xatolik yuz berdi.', { parse_mode: 'Markdown' });
            }
        }

        // Foydalanuvchi uchun kino qidirish
        if (/^\d{1,10}$/.test(text)) {
            const checkResult = await checkRequiredSubscriptions(userId);
            
            if (!checkResult.success && !isUserAdmin) {
                const keyboard = await getLinksKeyboard();
                return ctx.reply(`❌ ${checkResult.message}\n\nIltimos, obuna bo\'ling:`, { 
                    parse_mode: 'Markdown',
                    ...keyboard 
                });
            }
            
            await ensureUser(userId, ctx.from.username, ctx.from.first_name);
            
            const movie = await Movie.findOne({ code: text });
            
            if (!movie) {
                return ctx.reply(
                    '❌ *Bunday kodda kino topilmadi.*\n\n' +
                    'Boshqa kod kiriting yoki admin bilan bog\'laning.',
                    { parse_mode: 'Markdown' }
                );
            }

            try {
                // Video yuborish
                await ctx.replyWithVideo(movie.file_id, {
                    caption: movie.caption || `🎬 *Kino kodi:* ${movie.code}\n\n✅ Boshqa kodlar bilan kinolar toping!`,
                    parse_mode: 'Markdown'
                });
                
                // Foydali havolalarni ham yuborish
                const keyboard = await getLinksKeyboard();
                setTimeout(() => {
                    ctx.reply('📌 *Foydali havolalar:*', {
                        parse_mode: 'Markdown',
                        ...keyboard
                    });
                }, 500);
                
            } catch (err) {
                console.error('❌ Video yuborish xatosi:', err);
                
                // Agar video yuborishda xatolik bo'lsa, adminlarga xabar berish
                if (movie.file_type === 'video') {
                    ctx.reply('❌ *Video yuborishda xatolik yuz berdi.*\n\nIltimos, birozdan keyin qayta urinib ko\'ring yoki adminlarga murojaat qiling.', { 
                        parse_mode: 'Markdown' 
                    });
                } else {
                    ctx.reply('❌ *Fayl yuborishda xatolik.*\n\nAdminlar bu muammoni tekshirishadi.', {
                        parse_mode: 'Markdown'
                    });
                }
            }
        } else {
            // Agar raqam bo'lmasa
            if (!isUserAdmin) {
                const keyboard = await getLinksKeyboard();
                ctx.reply('⚠️ *Iltimos, faqat raqamlardan iborat kino kodini yuboring.*\n\nMasalan: 123', {
                    parse_mode: 'Markdown',
                    ...keyboard
                });
            }
        }
    } catch (error) {
        console.error('Text handler xatosi:', error);
        ctx.reply('❌ Xatolik yuz berdi. Iltimos, qayta urinib ko\'ring.');
    }
});

// Boshqa kontentlar uchun broadcast
bot.on(['photo', 'document', 'audio', 'voice', 'animation'], async (ctx) => {
    if (!isAdmin(ctx.from.id) || !ctx.session.broadcasting) return;

    try {
        const users = await User.find({});
        let success = 0;
        
        const progressMsg = await ctx.reply(`📤 Broadcast boshlanmoqda...`);
        
        for (const user of users) {
            try {
                await ctx.telegram.copyMessage(user.user_id, ctx.chat.id, ctx.message.message_id);
                success++;
                
                if (success % 100 === 0) {
                    try {
                        await ctx.telegram.editMessageText(
                            progressMsg.chat.id,
                            progressMsg.message_id,
                            null,
                            `📤 Broadcast davom etmoqda...\nYuborildi: ${success}/${users.length}`
                        );
                    } catch (e) {}
                }
                
                await new Promise(resolve => setTimeout(resolve, 50));
            } catch (e) {}
        }
        
        try {
            await ctx.telegram.deleteMessage(progressMsg.chat.id, progressMsg.message_id);
        } catch (e) {}
        
        ctx.session.broadcasting = false;
        ctx.reply(`✅ *Broadcast ${success} ta foydalanuvchiga yuborildi.*`, { 
            parse_mode: 'Markdown' 
        });
    } catch (err) {
        console.error('Broadcast xatosi:', err);
        ctx.session.broadcasting = false;
        ctx.reply('❌ Broadcastda xatolik yuz berdi.', { 
            parse_mode: 'Markdown' 
        });
    }
});

// Havola o'chirish callback handler
bot.action(/delete_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        return ctx.answerCbQuery('❌ Ruxsat yo\'q');
    }
    
    const id = ctx.match[1];
    
    try {
        const sub = await Subscription.findById(id);
        if (!sub) {
            return ctx.answerCbQuery('❌ Havola topilmadi');
        }
        
        await Subscription.deleteOne({ _id: id });
        
        await ctx.answerCbQuery('✅ Havola o\'chirildi');
        await ctx.editMessageText(`✅ *${sub.title}* havolasi o'chirildi.`, {
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error('Delete action xatosi:', error);
        ctx.answerCbQuery('❌ Xatolik yuz berdi');
    }
});

// ====================== ERROR HANDLING ======================

// Global error handler
bot.catch((err, ctx) => {
    console.error(`❌ Global error for ${ctx.updateType}:`, err);
    
    try {
        if (ctx.chat && ctx.chat.id) {
            ctx.reply('❌ Xatolik yuz berdi. Iltimos, birozdan keyin qayta urinib ko\'ring.');
        }
    } catch (e) {
        console.error('Error in error handler:', e);
    }
});

// ====================== WEBHOOK SOZLASH ======================

if (URL) {
    console.log('🚀 Webhook rejimida ishga tushyapman...');
    
    // Webhook path yaratish
    const webhookPath = `/telegraf/${bot.secretPathComponent()}`;
    const fullUrl = `${URL}${webhookPath}`;
    
    console.log(`📡 Webhook manzili: ${fullUrl}`);

    // Express server yaratish
    const app = express();
    app.use(express.json());

    // Asosiy sahifa
    app.get('/', (req, res) => {
        res.json({ 
            status: 'online',
            bot: 'Kino Bot',
            version: '1.0.0'
        });
    });

    // Health check
    app.get('/health', (req, res) => {
        res.json({ 
            status: 'healthy',
            timestamp: new Date().toISOString()
        });
    });

    // Webhook endpoint
    app.post(webhookPath, (req, res) => {
        const token = req.headers['x-telegram-bot-api-secret-token'];
        if (token !== WEBHOOK_SECRET) {
            console.warn('⚠️ Noto\'g\'ri secret token');
            return res.status(403).send('Forbidden');
        }
        
        return bot.handleUpdate(req.body, res).then(() => {
            res.status(200).end();
        }).catch(err => {
            console.error('❌ Webhook xatosi:', err);
            res.status(500).end();
        });
    });

    // Serverni ishga tushirish
    const server = app.listen(PORT, async () => {
        console.log(`✅ Server ${PORT} portda ishga tushdi`);
        
        // Webhook o'rnatish
        try {
            await bot.telegram.setWebhook(fullUrl, {
                secret_token: WEBHOOK_SECRET,
                drop_pending_updates: true,
                allowed_updates: [
                    'message', 
                    'callback_query',
                    'chat_member'
                ]
            });
            console.log(`✅ Webhook muvaffaqiyatli o'rnatildi`);
            console.log('🤖 Bot to\'liq ishga tushdi!');
        } catch (err) {
            console.error('❌ Webhook o\'rnatishda xato:', err.message);
        }
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log('🛑 SIGTERM signal qabul qilindi');
        server.close(() => {
            console.log('✅ Server yopildi');
            process.exit(0);
        });
    });

} else {
    console.log('🚀 Local polling rejimida ishga tushyapman...');
    
    // Local test uchun polling
    bot.launch({
        allowedUpdates: ['message', 'callback_query', 'chat_member'],
        dropPendingUpdates: true
    })
    .then(() => console.log('✅ Bot polling rejimida ishga tushdi'))
    .catch(err => console.error('❌ Xatolik:', err));

    // Graceful stop
    process.once('SIGINT', () => {
        console.log('🛑 SIGINT signal qabul qilindi');
        bot.stop('SIGINT');
    });
    
    process.once('SIGTERM', () => {
        console.log('🛑 SIGTERM signal qabul qilindi');
        bot.stop('SIGTERM');
    });
}

console.log('🎬 Kino Bot mukammal ishlashga tayyor!');
