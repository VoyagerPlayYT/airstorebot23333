import mineflayer from 'mineflayer';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import pino from 'pino';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// Logger setup
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      }
    }
  },
  pino.destination(path.join(logsDir, 'bot.log'))
);

// Configuration validation
const config = {
  tg: {
    token: process.env.TG_TOKEN,
    adminId: parseInt(process.env.ADMIN_ID)
  },
  mc: {
    host: process.env.MC_HOST || 'Voyagersspace.aternos.me',
    port: parseInt(process.env.MC_PORT) || 11989,
    username: process.env.MC_USERNAME || 'Asadbek_Manager',
    version: process.env.MC_VERSION || '1.20.1'
  },
  server: {
    port: parseInt(process.env.PORT) || 10000
  }
};

// Validation
if (!config.tg.token) {
  logger.error('❌ TG_TOKEN не установлен в .env');
  process.exit(1);
}

if (!config.tg.adminId) {
  logger.error('❌ ADMIN_ID не установлен в .env');
  process.exit(1);
}

// Express Server
const app = express();
const port = config.server.port;

app.get('/', (req, res) => {
  res.status(200).json({
    status: '✅ Система VoyagersSpace активна',
    timestamp: new Date().toISOString(),
    botConnected: !!bot?.entity,
    version: '2.0.0'
  });
});

app.get('/health', (req, res) => {
  const health = {
    status: bot?.entity ? 'healthy' : 'initializing',
    botOnline: !!bot?.entity,
    uptime: process.uptime()
  };
  res.status(bot?.entity ? 200 : 503).json(health);
});

app.listen(port, () => {
  logger.info(`🌐 Express сервер запущен на порту ${port}`);
});

// Telegram Bot
const tgBot = new Telegraf(config.tg.token);
let bot;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Bot state management
const botState = {
  pendingPlayer: '',
  isCapturingGroups: false,
  foundGroups: [],
  lastGroupListTime: 0,
  commandCooldown: new Map(),
  activeSessions: new Map()
};

// Helper: Check if user is admin
const isAdmin = (userId) => userId === config.tg.adminId;

// Helper: Cooldown check
const checkCooldown = (userId, command, cooldownMs = 3000) => {
  const key = `${userId}:${command}`;
  const now = Date.now();
  const lastRun = botState.commandCooldown.get(key) || 0;

  if (now - lastRun < cooldownMs) {
    return false;
  }
  botState.commandCooldown.set(key, now);
  return true;
};

// Create Minecraft Bot with enhanced error handling
function createMCBot() {
  try {
    logger.info('🔌 Подключение к Minecraft серверу...');

    bot = mineflayer.createBot({
      host: config.mc.host,
      port: config.mc.port,
      username: config.mc.username,
      version: config.mc.version,
      auth: 'offline'
    });

    bot.on('spawn', () => {
      logger.info('✅ Бот успешно зашел на сервер!');
      reconnectAttempts = 0;
      
      setTimeout(() => {
        bot.chat('🤖 Система VoyagersSpace подключена и готова к работе!');
      }, 2000);

      tgBot.telegram.sendMessage(
        config.tg.adminId,
        '✅ <b>Бот подключился к серверу</b>\n\nСистема готова к управлению донатами.',
        { parse_mode: 'HTML' }
      ).catch(err => logger.error('Ошибка отправки уведомления:', err));
    });

    bot.on('playerJoined', (player) => {
      if (player.username === bot.username) return;

      logger.info(`👤 Игрок ${player.username} присоединился`);
      bot.chat(`👋 Привет, <c>${player.username}</c>! Добро пожаловать на VoyagersSpace!`);

      tgBot.telegram.sendMessage(
        config.tg.adminId,
        `🚀 <b>Игрок присоединился</b>\n<code>${player.username}</code>\n\nОнлайн: ${Object.keys(bot.players).length} игроков`,
        { parse_mode: 'HTML' }
      ).catch(err => logger.error('Ошибка уведомления:', err));
    });

    bot.on('playerLeft', (player) => {
      logger.info(`👤 Игрок ${player.username} вышел`);
      tgBot.telegram.sendMessage(
        config.tg.adminId,
        `🚪 <b>Игрок вышел</b>\n<code>${player.username}</code>`,
        { parse_mode: 'HTML' }
      ).catch(err => logger.error('Ошибка уведомления:', err));
    });

    bot.on('message', (jsonMsg) => {
      const message = jsonMsg.toString();

      if (botState.isCapturingGroups) {
        const match = message.match(/-\s*([a-zA-Z0-9_]+)/);
        if (match && match[1]) {
          const group = match[1];
          const ignoreList = ['lp', 'luckperms', 'groups', 'info', 'usage', 'default', 'error', 'players'];
          
          if (!ignoreList.includes(group.toLowerCase()) && !botState.foundGroups.includes(group)) {
            botState.foundGroups.push(group);
            logger.debug(`📍 Найдена группа: ${group}`);
          }
        }
      }
    });

    bot.on('error', (err) => {
      logger.error(`⚠️ Ошибка Minecraft: ${err.message}`);
    });

    bot.on('end', () => {
      logger.warn('❌ Соединение с сервером разорвано');
      
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = Math.min(10000 * reconnectAttempts, 60000);
        logger.info(`🔄 Переподключение попытка ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} через ${delay}мс`);
        
        setTimeout(createMCBot, delay);
        
        tgBot.telegram.sendMessage(
          config.tg.adminId,
          `⚠️ <b>Бот отключился</b>\nПереподключение попытка ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
          { parse_mode: 'HTML' }
        ).catch(err => logger.error('Ошибка уведомления:', err));
      } else {
        logger.error('❌ Максимальное количество попыток переподключения достигнуто');
        tgBot.telegram.sendMessage(
          config.tg.adminId,
          '❌ <b>Критическая ошибка</b>\nНе удается переподключиться к серверу. Проверь конфигурацию.',
          { parse_mode: 'HTML' }
        ).catch(err => logger.error('Ошибка уведомления:', err));
      }
    });

  } catch (error) {
    logger.error(`❌ Критическая ошибка при создании бота: ${error.message}`);
    setTimeout(createMCBot, 30000);
  }
}

// Initialize MC Bot
createMCBot();

// Telegram Bot Commands
tgBot.start(ctx => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ Доступ запрещен');
  }

  ctx.reply(
    '👋 <b>Привет, Асадбек!</b>\n\n' +
    '🤖 Бот на связи с Aternos\n\n' +
    '<b>Команды:</b>\n' +
    '/status - Статус бота\n' +
    '/players - Список игроков\n' +
    '/help - Справка\n\n' +
    '📝 Введи никнейм игрока для выдачи донат-ранга',
    { parse_mode: 'HTML' }
  );
});

tgBot.command('status', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  const status = bot?.entity ? '✅ Онлайн' : '❌ Оффлайн';
  const playerCount = bot?.entity ? Object.keys(bot.players).length : 0;

  ctx.reply(
    `<b>📊 Статус бота</b>\n\n` +
    `Статус: ${status}\n` +
    `Игроков онлайн: ${playerCount}\n` +
    `Версия: ${config.mc.version}\n` +
    `Хост: ${config.mc.host}:${config.mc.port}`,
    { parse_mode: 'HTML' }
  );
});

tgBot.command('players', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  if (!bot?.entity) {
    return ctx.reply('❌ Бот не подключен к серверу');
  }

  const players = Object.values(bot.players).map(p => `• ${p.username}`).join('\n');
  const playerList = players || 'Сервер пуст';

  ctx.reply(
    `<b>👥 Игроки онлайн (${Object.keys(bot.players).length})</b>\n\n${playerList}`,
    { parse_mode: 'HTML' }
  );
});

tgBot.command('help', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  ctx.reply(
    `<b>📖 Справка</b>\n\n` +
    `<b>Команды:</b>\n` +
    `/status - Статус бота и сервера\n` +
    `/players - Список игроков\n` +
    `/help - Эта справка\n\n` +
    `<b>Выдача рангов:</b>\n` +
    `Просто введи никнейм игрока и выбери донат-ранг из списка`,
    { parse_mode: 'HTML' }
  );
});

// Text handler for player nicknames
tgBot.on('text', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  if (!checkCooldown(ctx.from.id, 'text_input', 2000)) {
    return ctx.reply('⏱️ Подождите перед следующей командой');
  }

  const playerName = ctx.message.text.trim();

  if (playerName.length < 2 || playerName.length > 16) {
    return ctx.reply('❌ Никнейм должен быть от 2 до 16 символов');
  }

  if (!bot?.entity) {
    return ctx.reply('❌ Бот не подключен к серверу. Подожди переподключения...');
  }

  botState.pendingPlayer = playerName;
  botState.foundGroups = [];
  botState.isCapturingGroups = true;
  botState.lastGroupListTime = Date.now();

  try {
    await ctx.reply(`🔎 <b>Сканирую группы для:</b> <code>${playerName}</code>`, {
      parse_mode: 'HTML'
    });

    bot.chat('/lp listgroups');

    // Wait for groups to be captured
    setTimeout(() => {
      botState.isCapturingGroups = false;

      if (botState.foundGroups.length === 0) {
        return ctx.reply(
          '❌ <b>Группы не найдены</b>\n\n' +
          'Убедись что:\n' +
          '• Бот имеет права OP\n' +
          '• LuckPerms установлен на сервере\n' +
          '• Группы созданы',
          { parse_mode: 'HTML' }
        );
      }

      const buttons = botState.foundGroups.map(g => [
        Markup.button.callback(`🎁 ${g}`, `set_${g}`)
      ]);

      ctx.reply(
        `<b>📋 Донат-ранги для ${playerName}:</b>`,
        Markup.inlineKeyboard(buttons)
      ).catch(err => logger.error('Ошибка отправки кнопок:', err));

    }, 3000);

  } catch (error) {
    logger.error(`Ошибка при обработке никнейма: ${error.message}`);
    ctx.reply('❌ Ошибка при обработке команды');
  }
});

// Handle rank selection
tgBot.action(/set_(.+)/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Доступ запрещен');

  if (!checkCooldown(ctx.from.id, `set_${ctx.match[1]}`, 2000)) {
    return ctx.answerCbQuery('⏱️ Подождите перед следующей выдачей', true);
  }

  const rank = ctx.match[1];

  if (!bot?.entity) {
    return ctx.reply('❌ Ошибка: бот не в сети');
  }

  try {
    bot.chat(`/lp user ${botState.pendingPlayer} parent set ${rank}`);
    
    logger.info(`✅ Ранг ${rank} выдан игроку ${botState.pendingPlayer}`);

    ctx.answerCbQuery('✅ Команда отправлена', true);
    ctx.editMessageText(
      `✅ <b>Успешно!</b>\n\n` +
      `Игрок: <code>${botState.pendingPlayer}</code>\n` +
      `Ранг: <code>${rank}</code>\n\n` +
      `Изменения применены на сервере`,
      { parse_mode: 'HTML' }
    ).catch(err => logger.error('Ошибка редактирования:', err));

    tgBot.telegram.sendMessage(
      config.tg.adminId,
      `🎁 <b>Ранг выдан</b>\n` +
      `Игрок: <code>${botState.pendingPlayer}</code>\n` +
      `Ранг: <code>${rank}</code>`,
      { parse_mode: 'HTML' }
    ).catch(err => logger.error('Ошибка уведомления:', err));

  } catch (error) {
    logger.error(`Ошибка при выдаче ранга: ${error.message}`);
    ctx.reply('❌ Ошибка при выдаче ранга');
  }
});

// Error handling
tgBot.catch(err => {
  logger.error('🚨 Ошибка Telegram бота:', err);
});

process.on('unhandledRejection', err => {
  logger.error('⚠️ Необработанное отклонение:', err);
});

process.on('SIGINT', () => {
  logger.info('🛑 Бот завершает работу...');
  bot?.end();
  process.exit(0);
});

logger.info('🚀 VoyagersSpace Bot v2.0.0 запущен!');
