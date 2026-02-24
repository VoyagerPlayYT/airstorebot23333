import mineflayer from 'mineflayer';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ======================== КОНФИГУРАЦИЯ ========================
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

// ======================== ЛОГИРОВАНИЕ ========================
const log = (prefix, msg) => {
  const timestamp = new Date().toLocaleTimeString('ru-RU');
  console.log(`[${timestamp}] ${prefix} ${msg}`);
};

const logError = (msg) => log('❌', msg);
const logInfo = (msg) => log('✅', msg);
const logWarn = (msg) => log('⚠️', msg);
const logDebug = (msg) => log('🔍', msg);

// ======================== БД ДАННЫХ ========================
class Database {
  constructor() {
    this.dbPath = path.join(__dirname, 'data.json');
    this.data = {
      donators: {}, // { username: { rank: 'VIP', joinedAt: timestamp } }
      commandCooldowns: {}, // { username: { lastCommand: timestamp, command: 'name' } }
      stats: {
        totalCommands: 0,
        totalDonats: 0,
        activePlayers: 0
      }
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const content = fs.readFileSync(this.dbPath, 'utf-8');
        this.data = JSON.parse(content);
        logInfo('БД загружена');
      }
    } catch (error) {
      logError(`Ошибка загрузки БД: ${error.message}`);
    }
  }

  save() {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      logError(`Ошибка сохранения БД: ${error.message}`);
    }
  }

  addDonator(username, rank) {
    this.data.donators[username] = {
      rank,
      joinedAt: Date.now()
    };
    this.data.stats.totalDonats++;
    this.save();
    logInfo(`Донат добавлен: ${username} - ${rank}`);
  }

  getDonator(username) {
    return this.data.donators[username] || null;
  }

  getCooldown(username) {
    return this.data.commandCooldowns[username] || null;
  }

  setCooldown(username, cooldownMs = 300000) { // 5 минут по умолчанию
    this.data.commandCooldowns[username] = {
      lastCommand: Date.now(),
      expiresAt: Date.now() + cooldownMs
    };
    this.save();
  }

  isOnCooldown(username) {
    const cooldown = this.getCooldown(username);
    if (!cooldown) return false;

    const now = Date.now();
    if (now > cooldown.expiresAt) {
      delete this.data.commandCooldowns[username];
      this.save();
      return false;
    }
    return true;
  }

  getCooldownTimeLeft(username) {
    const cooldown = this.getCooldown(username);
    if (!cooldown) return 0;

    const timeLeft = cooldown.expiresAt - Date.now();
    return Math.max(0, timeLeft);
  }
}

const db = new Database();

// ======================== ПРОВЕРКА СЕРВЕРА ========================
class ServerChecker {
  constructor(host, port, timeout = 5000) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.isOnline = false;
    this.lastCheckTime = 0;
  }

  async check() {
    return new Promise((resolve) => {
      const socket = require('net').createConnection(this.port, this.host);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, this.timeout);

      socket.on('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  async updateStatus() {
    const wasOnline = this.isOnline;
    this.isOnline = await this.check();
    this.lastCheckTime = Date.now();

    if (!wasOnline && this.isOnline) {
      logInfo('🟢 СЕРВЕР ОНЛАЙН!');
    } else if (wasOnline && !this.isOnline) {
      logWarn('🔴 СЕРВЕР ОФФЛАЙН!');
    }

    return this.isOnline;
  }
}

const serverChecker = new ServerChecker(config.mc.host, config.mc.port);

// ======================== TELEGRAM БОТ ========================
const tgBot = new Telegraf(config.tg.token);

let bot = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 20;

// ======================== MC БОТ ========================
function createMCBot() {
  if (!serverChecker.isOnline) {
    logWarn('Сервер оффлайн, отложу подключение на 30 сек');
    setTimeout(createMCBot, 30000);
    return;
  }

  try {
    logInfo('Попытка подключения к MC серверу...');

    bot = mineflayer.createBot({
      host: config.mc.host,
      port: config.mc.port,
      username: config.mc.username,
      version: config.mc.version,
      auth: 'offline',
      hideErrors: false
    });

    // ========== SPAWN ==========
    bot.on('spawn', () => {
      logInfo('🎮 БОТ УСПЕШНО ВОШЕЛ НА СЕРВЕР!');
      reconnectAttempts = 0;

      setTimeout(() => {
        bot.chat('🤖 VoyagersSpace система активирована!');
      }, 2000);

      tgBot.telegram.sendMessage(
        config.tg.adminId,
        '✅ <b>БОТ ПОДКЛЮЧЕН К СЕРВЕРУ</b>\n\n🎮 Система готова к работе!\n⏰ Время: ' + new Date().toLocaleTimeString('ru-RU'),
        { parse_mode: 'HTML' }
      ).catch(err => logError(`Ошибка отправки уведомления: ${err.message}`));
    });

    // ========== PLAYERS ==========
    bot.on('playerJoined', (player) => {
      if (player.username === bot.username) return;

      logInfo(`👤 Игрок присоединился: ${player.username}`);
      const donator = db.getDonator(player.username);
      const rankText = donator ? ` (${donator.rank})` : '';

      bot.chat(`👋 Добро пожаловать, ${player.username}${rankText}!`);

      tgBot.telegram.sendMessage(
        config.tg.adminId,
        `🚀 <b>Игрок присоединился</b>\n<code>${player.username}</code>${rankText}\n👥 Онлайн: ${Object.keys(bot.players).length}`,
        { parse_mode: 'HTML' }
      ).catch(err => logError(`Ошибка: ${err.message}`));
    });

    bot.on('playerLeft', (player) => {
      logInfo(`👋 Игрок вышел: ${player.username}`);
    });

    // ========== ЧАТЫ ИГРОКОВ ==========
    bot.on('message', (jsonMsg) => {
      try {
        const message = jsonMsg.toString();
        logDebug(`Чат: ${message}`);

        // Парсим сообщения игроков (для групп при сканировании)
        if (botState.isCapturingGroups) {
          const match = message.match(/-\s*([a-zA-Z0-9_]+)/);
          if (match && match[1]) {
            const group = match[1];
            const ignoreList = ['lp', 'luckperms', 'groups', 'info', 'usage', 'default', 'error', 'players', 'error', 'permission'];

            if (!ignoreList.includes(group.toLowerCase()) && !botState.foundGroups.includes(group)) {
              botState.foundGroups.push(group);
              logDebug(`📍 Найдена группа: ${group}`);
            }
          }
        }

        // Парсим команды от доната: !command аргумент
        const commandMatch = message.match(/^<([^>]+)>\s*!(\w+)\s*(.*)/);
        if (commandMatch) {
          const playerName = commandMatch[1];
          const commandName = commandMatch[2].toLowerCase();
          const args = commandMatch[3].trim();

          handlePlayerCommand(playerName, commandName, args);
        }

      } catch (error) {
        logError(`Ошибка обработки сообщения: ${error.message}`);
      }
    });

    // ========== ОШИБКИ ==========
    bot.on('error', (err) => {
      logError(`Ошибка MC: ${err.message}`);
    });

    bot.on('end', () => {
      logWarn('Соединение с сервером разорвано');

      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        const delay = Math.min(5000 * reconnectAttempts, 120000);
        logWarn(`🔄 Переподключение ${reconnectAttempts}/${MAX_RECONNECT} через ${delay}мс`);

        setTimeout(createMCBot, delay);

        tgBot.telegram.sendMessage(
          config.tg.adminId,
          `⚠️ Попытка переподключения ${reconnectAttempts}/${MAX_RECONNECT}`,
          { parse_mode: 'HTML' }
        ).catch(err => logError(`Ошибка: ${err.message}`));
      } else {
        logError('КРИТИЧЕСКАЯ ОШИБКА: Максимум попыток достигнут!');
        tgBot.telegram.sendMessage(
          config.tg.adminId,
          '🚨 <b>КРИТИЧЕСКАЯ ОШИБКА</b>\nБот не может переподключиться к серверу!\n\nПроверь:\n• Aternos запущен\n• Правильный адрес сервера\n• Интернет соединение',
          { parse_mode: 'HTML' }
        ).catch(err => logError(`Ошибка: ${err.message}`));
      }
    });

  } catch (error) {
    logError(`Критическая ошибка при создании бота: ${error.message}`);
    setTimeout(createMCBot, 30000);
  }
}

// ======================== ОБРАБОТКА КОМАНД ИГРОКОВ ========================
function handlePlayerCommand(playerName, command, args) {
  const donator = db.getDonator(playerName);

  // Только доны могут писать команды
  if (!donator) {
    bot.chat(`❌ ${playerName}, команды доступны только донатерам!`);
    logWarn(`${playerName} пытался использовать команду без доната`);
    return;
  }

  // Проверяем кулдаун
  if (db.isOnCooldown(playerName)) {
    const timeLeft = Math.ceil(db.getCooldownTimeLeft(playerName) / 1000);
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    bot.chat(`⏱️ ${playerName}, подождите ${minutes}м ${seconds}с перед следующей командой!`);
    logWarn(`${playerName} на кулдауне: осталось ${timeLeft}с`);
    return;
  }

  // Команды в зависимости от ранга
  const commands = {
    vip: ['give', 'heal'],
    premium: ['give', 'heal', 'tpall'],
    diamond: ['give', 'heal', 'tpall', 'gamemode', 'effect']
  };

  const allowedCommands = commands[donator.rank.toLowerCase()] || [];

  if (!allowedCommands.includes(command)) {
    bot.chat(`❌ ${playerName}, команда !${command} недоступна для вашего ранга`);
    logWarn(`${playerName} (${donator.rank}) попытался использовать !${command}`);
    return;
  }

  // Выполнение команд
  executeCommand(playerName, command, args, donator.rank);
  
  // Установка кулдауна
  db.setCooldown(playerName, 300000); // 5 минут
  db.data.stats.totalCommands++;
  db.save();

  logInfo(`Команда выполнена: ${playerName} - !${command}`);
}

function executeCommand(playerName, command, args, rank) {
  switch (command) {
    case 'give':
      if (!args) {
        bot.chat(`❌ ${playerName}, используй: !give [предмет] [количество]`);
        return;
      }
      const [item, amount = 1] = args.split(' ');
      bot.chat(`/give ${playerName} ${item} ${amount}`);
      bot.chat(`✅ ${playerName}, выдано: ${item}x${amount}`);
      break;

    case 'heal':
      bot.chat(`/effect give ${playerName} minecraft:instant_health 1 10`);
      bot.chat(`💚 ${playerName}, ты исцелен!`);
      break;

    case 'tpall':
      if (rank !== 'PREMIUM' && rank !== 'DIAMOND') {
        bot.chat(`❌ ${playerName}, команда только для PREMIUM+`);
        return;
      }
      bot.chat(`/execute as @a at ${playerName} run teleport @s ~ ~ ~`);
      bot.chat(`🌍 ${playerName}, все телепортированы к тебе!`);
      break;

    case 'gamemode':
      if (rank !== 'DIAMOND') {
        bot.chat(`❌ ${playerName}, команда только для DIAMOND`);
        return;
      }
      const mode = args || 'creative';
      bot.chat(`/gamemode ${mode} ${playerName}`);
      bot.chat(`🎮 ${playerName}, режим: ${mode}`);
      break;

    case 'effect':
      if (rank !== 'DIAMOND') {
        bot.chat(`❌ ${playerName}, команда только для DIAMOND`);
        return;
      }
      if (!args) {
        bot.chat(`❌ ${playerName}, используй: !effect [эффект] [уровень]`);
        return;
      }
      const [effect, level = 1] = args.split(' ');
      bot.chat(`/effect give ${playerName} ${effect} 300 ${level}`);
      bot.chat(`✨ ${playerName}, применен эффект: ${effect}`);
      break;

    default:
      bot.chat(`❌ ${playerName}, неизвестная команда`);
  }
}

// ======================== STATE ========================
const botState = {
  pendingPlayer: '',
  isCapturingGroups: false,
  foundGroups: []
};

// ======================== EXPRESS СЕРВЕР ========================
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).json({
    status: '✅ VoyagersSpace Bot активен',
    timestamp: new Date().toISOString(),
    botConnected: !!bot?.entity,
    serverOnline: serverChecker.isOnline,
    version: '3.0.0',
    stats: db.data.stats
  });
});

app.get('/health', (req, res) => {
  const health = {
    status: bot?.entity ? 'healthy' : 'initializing',
    botOnline: !!bot?.entity,
    serverOnline: serverChecker.isOnline,
    uptime: process.uptime()
  };

  const statusCode = bot?.entity && serverChecker.isOnline ? 200 : 503;
  res.status(statusCode).json(health);
});

app.get('/stats', (req, res) => {
  if (!bot?.entity) {
    return res.status(503).json({ error: 'Bot не подключен' });
  }

  res.json({
    botUsername: bot.username,
    playersOnline: Object.keys(bot.players).length,
    players: Object.values(bot.players).map(p => ({
      username: p.username,
      isDonator: !!db.getDonator(p.username)
    })),
    serverStatus: serverChecker.isOnline ? 'ONLINE' : 'OFFLINE',
    stats: db.data.stats,
    donators: db.data.donators
  });
});

app.listen(config.server.port, '0.0.0.0', () => {
  logInfo(`🌐 Express сервер запущен на ${config.server.port}`);
});

// ======================== TELEGRAM КОМАНДЫ ========================
const isAdmin = (userId) => userId === config.tg.adminId;

tgBot.start(ctx => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ Доступ запрещен');
  }

  ctx.reply(
    '👋 <b>Привет, Асадбек!</b>\n\n' +
    '🤖 <b>VoyagersSpace Bot v3.0</b>\n\n' +
    '<b>📋 Команды:</b>\n' +
    '  /status - Статус бота\n' +
    '  /players - Список игроков\n' +
    '  /donators - Список донатов\n' +
    '  /stats - Статистика\n' +
    '  /help - Справка\n\n' +
    '🎁 Введи ник игрока для выдачи доната',
    { parse_mode: 'HTML' }
  );
});

tgBot.command('status', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  const botStatus = bot?.entity ? '✅ Онлайн' : '❌ Оффлайн';
  const serverStatus = serverChecker.isOnline ? '✅ Онлайн' : '❌ Оффлайн';
  const playerCount = bot?.entity ? Object.keys(bot.players).length : 0;

  ctx.reply(
    `<b>📊 Статус системы</b>\n\n` +
    `БОТ: ${botStatus}\n` +
    `СЕРВЕР: ${serverStatus}\n` +
    `Игроков: ${playerCount}\n` +
    `Версия MC: ${config.mc.version}\n` +
    `Хост: ${config.mc.host}:${config.mc.port}`,
    { parse_mode: 'HTML' }
  );
});

tgBot.command('players', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  if (!bot?.entity) {
    return ctx.reply('❌ Бот не подключен');
  }

  const players = Object.values(bot.players)
    .map(p => {
      const donator = db.getDonator(p.username);
      return `• ${p.username}${donator ? ` [${donator.rank}]` : ''}`;
    })
    .join('\n') || 'Сервер пуст';

  ctx.reply(
    `<b>👥 Игроки онлайн (${Object.keys(bot.players).length})</b>\n\n${players}`,
    { parse_mode: 'HTML' }
  );
});

tgBot.command('donators', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  if (Object.keys(db.data.donators).length === 0) {
    return ctx.reply('❌ Донатов еще нет');
  }

  const donatorList = Object.entries(db.data.donators)
    .map(([username, info]) => `• ${username} - <b>${info.rank}</b>`)
    .join('\n');

  ctx.reply(
    `<b>🎁 Список донатов</b>\n\n${donatorList}`,
    { parse_mode: 'HTML' }
  );
});

tgBot.command('stats', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  const stats = db.data.stats;

  ctx.reply(
    `<b>📈 Статистика</b>\n\n` +
    `Всего команд: ${stats.totalCommands}\n` +
    `Всего донатов: ${stats.totalDonats}\n` +
    `Активных игроков: ${Object.keys(bot?.players || {}).length}`,
    { parse_mode: 'HTML' }
  );
});

tgBot.command('help', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  ctx.reply(
    `<b>📖 Справка</b>\n\n` +
    `<b>Команды боту в чате:</b>\n` +
    `!give [предмет] [кол-во] - Выдать предмет\n` +
    `!heal - Исцелить\n` +
    `!tpall - Телепортировать всех (PREMIUM+)\n` +
    `!gamemode [mode] - Сменить режим (DIAMOND)\n` +
    `!effect [эффект] [уровень] - Применить эффект (DIAMOND)\n\n` +
    `<b>Ограничения:</b>\n` +
    `⏱️ 1 команда в 5 минут на игрока\n` +
    `🎁 Только для донатов`,
    { parse_mode: 'HTML' }
  );
});

tgBot.on('text', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  const playerName = ctx.message.text.trim();

  if (playerName.length < 2 || playerName.length > 16) {
    return ctx.reply('❌ Ник: 2-16 символов');
  }

  if (!bot?.entity) {
    return ctx.reply('❌ Бот оффлайн');
  }

  botState.pendingPlayer = playerName;
  botState.foundGroups = [];
  botState.isCapturingGroups = true;

  await ctx.reply(`🔎 Сканирую группы для <code>${playerName}</code>`, {
    parse_mode: 'HTML'
  });

  bot.chat('/lp listgroups');

  setTimeout(() => {
    botState.isCapturingGroups = false;

    if (botState.foundGroups.length === 0) {
      return ctx.reply('❌ Группы не найдены', { parse_mode: 'HTML' });
    }

    const buttons = botState.foundGroups.map(g => [
      Markup.button.callback(`🎁 ${g}`, `set_${g}`)
    ]);

    ctx.reply(
      `<b>📋 Ранги для ${playerName}</b>`,
      Markup.inlineKeyboard(buttons)
    );
  }, 3000);
});

tgBot.action(/set_(.+)/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Доступ запрещен');

  const rank = ctx.match[1];

  if (!bot?.entity) {
    return ctx.reply('❌ Бот оффлайн');
  }

  bot.chat(`/lp user ${botState.pendingPlayer} parent set ${rank}`);
  db.addDonator(botState.pendingPlayer, rank);

  ctx.answerCbQuery('✅ Отправлено', true);
  ctx.editMessageText(
    `✅ <b>Успешно!</b>\n` +
    `Игрок: <code>${botState.pendingPlayer}</code>\n` +
    `Ранг: <code>${rank}</code>`,
    { parse_mode: 'HTML' }
  );
});

tgBot.catch(err => {
  logError(`Ошибка Telegram: ${err.message}`);
});

// ======================== ПРОЦЕССЫ ========================
process.on('unhandledRejection', err => {
  logError(`Необработанное отклонение: ${err.message}`);
});

process.on('SIGTERM', () => {
  logWarn('Graceful shutdown...');
  bot?.end();
  process.exit(0);
});

// ======================== ИНИЦИАЛИЗАЦИЯ ========================
async function initialize() {
  logInfo('🚀 Инициализация VoyagersSpace Bot v3.0');
  
  // Проверяем сервер каждые 30 секунд
  setInterval(async () => {
    await serverChecker.updateStatus();
    if (serverChecker.isOnline && !bot?.entity) {
      logInfo('Сервер онлайн, пытаюсь подключиться...');
      createMCBot();
    }
  }, 30000);

  // Первая проверка
  await serverChecker.updateStatus();
  
  if (serverChecker.isOnline) {
    createMCBot();
  } else {
    logWarn('⏰ Сервер оффлайн, жду онлайна...');
  }

  tgBot.launch();
  logInfo('✅ Telegram бот запущен');
}

initialize();
