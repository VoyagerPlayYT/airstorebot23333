const mineflayer = require('mineflayer');
const { Telegraf, Markup } = require('telegraf');
const express = require('express');

// --- ТВОИ ДАННЫЕ ---
const TG_TOKEN = '8403946776:AAGzARz2F2LlzBxmjcqZlq8ollRCUQg4A9c'; 
const ADMIN_ID = 115408334; 

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Бот Асадбека на Render запущен!'));
app.listen(port, () => console.log(`Веб-сервер активен на порту ${port}`));

const tgBot = new Telegraf(TG_TOKEN);

const bot = mineflayer.createBot({
    host: '51.15.238.21', // Твой новый IP
    port: 11989,
    username: 'Asadbek_Manager',
    version: '1.20.1'
});

bot.on('spawn', () => {
    console.log('✅ БОТ ЗАШЕЛ В МАЙНКРАФТ!');
    bot.chat('Админ-панель через Telegram подключена.');
});

let pendingPlayer = ""; 
let isCapturingGroups = false;
let foundGroups = [];

bot.on('message', (jsonMsg) => {
    const message = jsonMsg.toString();
    if (isCapturingGroups && message.includes('- ')) { 
        const group = message.replace('-', '').trim().split(' ')[0];
        if (group && !foundGroups.includes(group)) foundGroups.push(group);
    }
});

tgBot.start(ctx => {
    if (ctx.from.id == ADMIN_ID) ctx.reply('Привет, Асадбек! Введи ник игрока для выдачи доната.');
});

tgBot.on('text', async ctx => {
    if (ctx.from.id != ADMIN_ID) return;
    pendingPlayer = ctx.message.text;
    foundGroups = [];
    isCapturingGroups = true;
    ctx.reply(`Спрашиваю у сервера список донатов для ${pendingPlayer}...`);
    bot.chat('/lp listgroups');
    
    setTimeout(() => {
        isCapturingGroups = false;
        if (foundGroups.length == 0) return ctx.reply('Не удалось получить список групп. Проверь права бота (/op).');
        const btns = foundGroups.map(g => [Markup.button.callback(`Выдать ${g}`, `set_${g}`)]);
        ctx.reply(`Выбери донат для ${pendingPlayer}:`, Markup.inlineKeyboard(btns));
    }, 2500);
});

tgBot.action(/set_(.+)/, ctx => {
    const rank = ctx.match[1];
    bot.chat(`/lp user ${pendingPlayer} parent set ${rank}`);
    ctx.reply(`✅ Готово! Игроку ${pendingPlayer} установлен ранг ${rank}`);
});

tgBot.launch().catch(err => console.error('Ошибка TG:', err.message));

bot.on('error', err => console.log('Ошибка MC:', err.message));
bot.on('kicked', reason => console.log('Кикнут с сервера:', reason));
