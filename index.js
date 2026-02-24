const mineflayer = require('mineflayer');
const { Telegraf, Markup } = require('telegraf');
const express = require('express');

const TG_TOKEN = '8403946776:AAGzARz2F2LlzBxmjcqZlq8ollRCUQg4A9c'; 
const ADMIN_ID = 115408334; 

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Бот VoyagersSpace активен!'));
app.listen(port);

const tgBot = new Telegraf(TG_TOKEN);

const bot = mineflayer.createBot({
    host: 'voyagersspace.aternos.me', 
    port: 11989,
    username: 'Asadbek_Manager',
    version: '1.20.1'
});

// --- МОНИТОРИНГ ИГРОКОВ ---
bot.on('playerJoined', (player) => {
    if (player.username === bot.username) return; // Игнорируем самого себя

    // Приветствие в чат игры
    bot.chat(`Привет, ${player.username}! Добро пожаловать на сервер VoyagersSpace!`);

    // Уведомление тебе в Telegram
    tgBot.telegram.sendMessage(ADMIN_ID, `🚀 Игрок ${player.username} зашел на сервер!`);
});

// --- ЛОГИКА ГРУПП (ИСПРАВЛЕННАЯ) ---
let pendingPlayer = ""; 
let isCapturingGroups = false;
let foundGroups = [];

bot.on('message', (jsonMsg) => {
    const message = jsonMsg.toString();
    
    if (isCapturingGroups) {
        // Улучшенный поиск групп: ищем слова после дефиса или в списке
        // LuckPerms обычно присылает список в формате " - имя_группы"
        const match = message.match(/-\s*(\w+)/); 
        if (match && match[1]) {
            const group = match[1];
            if (!foundGroups.includes(group) && group.toLowerCase() !== 'groups') {
                foundGroups.push(group);
            }
        }
    }
});

tgBot.start(ctx => {
    if (ctx.from.id == ADMIN_ID) ctx.reply('Система VoyagersSpace готова. Введи ник игрока.');
});

tgBot.on('text', async ctx => {
    if (ctx.from.id != ADMIN_ID) return;
    
    pendingPlayer = ctx.message.text;
    foundGroups = [];
    isCapturingGroups = true;
    
    ctx.reply(`🔎 Запрашиваю список донатов для ${pendingPlayer}...`);
    bot.chat('/lp listgroups');
    
    // Ждем чуть дольше (3 сек), чтобы собрать все группы
    setTimeout(() => {
        isCapturingGroups = false;
        
        if (foundGroups.length == 0) {
            return ctx.reply('Группы не найдены. Убедись, что у бота есть права OP, и попробуй еще раз.');
        }

        // Создаем кнопки: одна строка — одна кнопка
        const buttons = foundGroups.map(g => [Markup.button.callback(`🎁 Выдать ${g}`, `set_${g}`)]);
        
        ctx.reply(`Список доступных групп:`, Markup.inlineKeyboard(buttons));
    }, 3000);
});

tgBot.action(/set_(.+)/, ctx => {
    const rank = ctx.match[1];
    bot.chat(`/lp user ${pendingPlayer} parent set ${rank}`);
    ctx.reply(`✅ Игроку ${pendingPlayer} успешно выдан ранг: ${rank}`);
});

tgBot.launch();
bot.on('spawn', () => console.log('✅ Бот в игре!'));
bot.on('error', err => console.log('Ошибка:', err.message));
