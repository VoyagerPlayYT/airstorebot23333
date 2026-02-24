import mineflayer from 'mineflayer';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';

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

// ======================== АДМИНЫ В ИГРЕ ========================
const GAME_ADMINS = ['voyagerplay', 'Asadbek_Manager'];

// ======================== ЛОГИРОВАНИЕ ========================
const log = (prefix, msg) => {
  const timestamp = new Date().toLocaleTimeString('ru-RU');
  console.log(`[${timestamp}] ${prefix} ${msg}`);
};

const logError = (msg) => log('❌', msg);
const logInfo = (msg) => log('✅', msg);
const logWarn = (msg) => log('⚠️', msg);
const logDebug = (msg) => log('🔍', msg);
const logSecurity = (msg) => log('🔒', msg);

// ======================== КОМАНДЫ КОНФИГ ========================
class CommandsManager {
  constructor() {
    this.configPath = path.join(__dirname, 'commands.json');
    this.config = this.loadCommands();
  }

  loadCommands() {
    try {
      if (!fs.existsSync(this.configPath)) {
        logError('commands.json не найден! Создаю...');
        this.createDefaultConfig();
      }
      const content = fs.readFileSync(this.configPath, 'utf-8');
      const commands = JSON.parse(content);
      logInfo(`Загружено ${Object.keys(commands.allowedCommands).length} разрешённых команд`);
      logInfo(`Загружено ${Object.keys(commands.bannedCommands).length} запрещённых команд`);
      return commands;
    } catch (error) {
      logError(`Ошибка загрузки commands.json: ${error.message}`);
      return { allowedCommands: {}, bannedCommands: {}, ranks: {} };
    }
  }

  createDefaultConfig() {
    const defaultConfig = {
      allowedCommands: {},
      bannedCommands: {},
      ranks: {}
    };
    fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2));
  }

  isCommandAllowed(commandName) {
    const cmd = this.config.allowedCommands[commandName.toLowerCase()];
    return cmd && cmd.enabled === true;
  }

  isCommandBanned(commandName) {
    const cmd = this.config.bannedCommands[commandName.toLowerCase()];
    return cmd && cmd.blocked === true;
  }

  getCommandInfo(commandName) {
    return this.config.allowedCommands[commandName.toLowerCase()] || null;
  }

  getBannedCommandInfo(commandName) {
    return this.config.bannedCommands[commandName.toLowerCase()] || null;
  }

  getRankLevel(rank) {
    return this.config.ranks[rank]?.level || 0;
  }

  canRankUseCommand(rank, command) {
    const cmdInfo = this.getCommandInfo(command);
    if (!cmdInfo) return false;

    const playerRankLevel = this.getRankLevel(rank);
    const requiredRankLevel = this.getRankLevel(cmdInfo.requiredRank);

    return playerRankLevel >= requiredRankLevel;
  }

  getAllowedCommands() {
    return this.config.allowedCommands;
  }

  getBannedCommands() {
    return this.config.bannedCommands;
  }
}

const commandsManager = new CommandsManager();

// ======================== БД ДАННЫХ ========================
class Database {
  constructor() {
    this.dbPath = path.join(__dirname, 'data.json');
    this.data = {
      donators: {},
      commandCooldowns: {},
      logs: [],
      stats: {
        totalCommands: 0,
        totalDonats: 0,
        blockedAttempts: 0
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
      } else {
        this.save();
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

  addLog(playerName, command, allowed, reason = '') {
    this.data.logs.push({
      timestamp: Date.now(),
      player: playerName,
      command: command,
      allowed: allowed,
      reason: reason
    });

    if (this.data.logs.length > 1000) {
      this.data.logs = this.data.logs.slice(-1000);
    }

    this.save();
  }

  addDonator(username, rank) {
    this.data.donators[username] = {
      rank,
      joinedAt: Date.now()
    };
    this.data.stats.totalDonats++;
    this.save();
    logInfo(`✅ Донат добавлен: ${username} - ${rank}`);
  }

  getDonator(username) {
    return this.data.donators[username] || null;
  }

  setCooldown(username, cooldownMs = 300000) {
    this.data.commandCooldowns[username] = {
      lastCommand: Date.now(),
      expiresAt: Date.now() + cooldownMs
    };
    this.save();
  }

  isOnCooldown(username) {
    const cooldown = this.data.commandCooldowns[username];
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
    const cooldown = this.data.commandCooldowns[username];
    if (!cooldown) return 0;

    const timeLeft = cooldown.expiresAt - Date.now();
    return Math.max(0, timeLeft);
  }

  removeDonator(username) {
    if (this.data.donators[username]) {
      delete this.data.donators[username];
      this.save();
      return true;
    }
    return false;
  }

  getAllDonators() {
    return this.data.donators;
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
  }

  async check() {
    return new Promise((resolve) => {
      const socket = net.createConnection(this.port, this.host);
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

    bot.on('spawn', () => {
      logInfo('🎮 БОТ ВОШЕЛ НА СЕРВЕР!');
      reconnectAttempts = 0;

      setTimeout(() => {
        bot.chat('🤖 VoyagersSpace v4.1 активирована!');
      }, 2000);

      tgBot.telegram.sendMessage(
        config.tg.adminId,
        '✅ <b>БОТ ПОДКЛЮЧЕН</b>\n\n🔒 Система защиты команд активна!\n🎮 Версия: v4.1',
        { parse_mode: 'HTML' }
      ).catch(err => logError(`Ошибка: ${err.message}`));
    });

    bot.on('playerJoined', (player) => {
      if (player.username === bot.username) return;

      logInfo(`👤 ${player.username} присоединился`);
      const isAdmin = GAME_ADMINS.includes(player.username);
      const donator = db.getDonator(player.username);
      
      let greeting = `👋 Добро пожаловать, ${player.username}!`;
      if (isAdmin) {
        greeting += ' 👑 (ВЛАДЕЛЕЦ)';
      } else if (donator) {
        greeting += ` (${donator.rank})`;
      }

      bot.chat(greeting);

      tgBot.telegram.sendMessage(
        config.tg.adminId,
        `🚀 ${isAdmin ? '👑' : '🎮'} <b>${player.username}</b> присоединился`,
        { parse_mode: 'HTML' }
      ).catch(err => logError(`Ошибка: ${err.message}`));
    });

    bot.on('playerLeft', (player) => {
      logInfo(`👋 ${player.username} вышел`);
    });

    bot.on('message', (jsonMsg) => {
      try {
        const message = jsonMsg.toString();
        logDebug(`Чат: ${message}`);

        // ========== ПАРСИНГ ГРУПП LUCKPERMS ==========
        if (botState.isCapturingGroups) {
          const groupMatch = message.match(/^[-–]\s+([a-zA-Z0-9_]+)$/m);
          
          if (groupMatch && groupMatch[1]) {
            const group = groupMatch[1];
            const ignoreList = [
              'lp', 'luckperms', 'groups', 'info', 'usage', 'default', 
              'error', 'players', 'permission', 'user', 'group', 'track',
              'log', 'sync', 'editor', 'verbose', 'tree', 'search'
            ];

            if (!ignoreList.includes(group.toLowerCase()) && 
                !botState.foundGroups.includes(group)) {
              botState.foundGroups.push(group);
              logDebug(`📍 Найдена группа: ${group}`);
            }
          }
        }

        // ========== ПАРСИНГ КОМАНД ИГРОКОВ ==========
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

    bot.on('error', (err) => {
      logError(`Ошибка MC: ${err.message}`);
    });

    bot.on('end', () => {
      logWarn('Соединение разорвано');

      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        const delay = Math.min(5000 * reconnectAttempts, 120000);
        logWarn(`🔄 Попытка ${reconnectAttempts}/${MAX_RECONNECT}`);
        setTimeout(createMCBot, delay);
      } else {
        logError('КРИТИЧЕСКАЯ ОШИБКА: Максимум попыток!');
      }
    });

  } catch (error) {
    logError(`Ошибка создания бота: ${error.message}`);
    setTimeout(createMCBot, 30000);
  }
}

// ======================== ОБРАБОТКА КОМАНД ========================
function handlePlayerCommand(playerName, command, args) {
  // ✅ ПРОВЕРЯЕМ ЕСЛИ ЭТО АДМИН
  const isAdmin = GAME_ADMINS.includes(playerName);

  if (isAdmin) {
    logInfo(`👑 АДМИН КОМАНДА: ${playerName} → !${command} ${args}`);
    executeCommand(playerName, command, args, 'ADMIN');
    return;
  }

  // ПРОВЕРКА 1: Только доны могут писать команды
  const donator = db.getDonator(playerName);
  
  if (!donator) {
    bot.chat(`❌ ${playerName}, команды доступны только донатерам!`);
    logWarn(`${playerName} попытался команду без доната`);
    db.addLog(playerName, command, false, 'НЕ ДОНАТЕР');
    return;
  }

  // ПРОВЕРКА 2: Команда в чёрном списке
  if (commandsManager.isCommandBanned(command)) {
    const banInfo = commandsManager.getBannedCommandInfo(command);
    bot.chat(`🔒 ${playerName}, команда !${command} ЗАПРЕЩЕНА! (${banInfo.reason})`);
    logSecurity(`⛔ ПОПЫТКА ЗАПРЕЩЁННОЙ КОМАНДЫ: ${playerName} → !${command}`);
    db.addLog(playerName, command, false, 'В ЧЁРНОМ СПИСКЕ');
    db.data.stats.blockedAttempts++;
    db.save();
    return;
  }

  // ПРОВЕРКА 3: Команда разрешена
  if (!commandsManager.isCommandAllowed(command)) {
    bot.chat(`❌ ${playerName}, неизвестная команда !${command}`);
    logWarn(`${playerName} попытался неизвестную команду: !${command}`);
    db.addLog(playerName, command, false, 'НЕИЗВЕСТНАЯ КОМАНДА');
    return;
  }

  const cmdInfo = commandsManager.getCommandInfo(command);

  // ПРОВЕРКА 4: Уровень ранга
  if (!commandsManager.canRankUseCommand(donator.rank, command)) {
    bot.chat(`❌ ${playerName}, команда !${command} недоступна для вашего ранга!`);
    logWarn(`${playerName} (${donator.rank}) попытался команду выше рангом: !${command}`);
    db.addLog(playerName, command, false, 'НЕ ДОСТАТОЧНО ПРАВ');
    return;
  }

  // ПРОВЕРКА 5: Кулдаун
  if (db.isOnCooldown(playerName)) {
    const timeLeft = Math.ceil(db.getCooldownTimeLeft(playerName) / 1000);
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    bot.chat(`⏱️ ${playerName}, подождите ${minutes}м ${seconds}с!`);
    return;
  }

  // ✅ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ
  logInfo(`✅ КОМАНДА ОДОБРЕНА: ${playerName} → !${command}`);
  executeCommand(playerName, command, args, donator.rank);

  db.setCooldown(playerName, cmdInfo.cooldown);
  db.data.stats.totalCommands++;
  db.addLog(playerName, command, true, 'УСПЕШНО');
  db.save();
}

// ======================== ВЫПОЛНЕНИЕ КОМАНД ========================
function executeCommand(playerName, command, args, rank) {
  const isAdmin = rank === 'ADMIN';

  switch (command) {
    // ОБЫЧНЫЕ КОМАНДЫ
    case 'give':
      if (!args) {
        bot.chat(`❌ ${playerName}, используй: !give [предмет] [кол-во]`);
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
      bot.chat(`/execute as @a at ${playerName} run teleport @s ~ ~ ~`);
      bot.chat(`🌍 ${playerName}, все телепортированы!`);
      break;

    case 'gamemode':
      const mode = args || 'creative';
      bot.chat(`/gamemode ${mode} ${playerName}`);
      bot.chat(`🎮 ${playerName}, режим: ${mode}`);
      break;

    case 'effect':
      if (!args) {
        bot.chat(`❌ ${playerName}, используй: !effect [эффект] [уровень]`);
        return;
      }
      const [effect, level = 1] = args.split(' ');
      bot.chat(`/effect give ${playerName} ${effect} 300 ${level}`);
      bot.chat(`✨ ${playerName}, применен эффект!`);
      break;

    case 'fly':
      bot.chat(`/ability ${playerName} mayfly true`);
      bot.chat(`🪁 ${playerName}, полёт разрешен!`);
      break;

    case 'speed':
      const speedLevel = args || '2';
      bot.chat(`/effect give ${playerName} minecraft:speed 300 ${speedLevel}`);
      bot.chat(`⚡ ${playerName}, скорость повышена!`);
      break;

    // АДМИН КОМАНДЫ
    case 'say':
      if (!isAdmin) {
        bot.chat(`❌ ${playerName}, эта команда только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ ${playerName}, используй: !say [сообщение]`);
        return;
      }
      bot.chat(args);
      break;

    case 'clear':
      if (!isAdmin) {
        bot.chat(`❌ ${playerName}, эта команда только для ВЛАДЕЛЬЦА!`);
        return;
      }
      bot.chat(`/clear ${playerName}`);
      bot.chat(`🧹 ${playerName} очистил свой инвентарь!`);
      break;

    case 'weather':
      if (!isAdmin) {
        bot.chat(`❌ ${playerName}, эта команда только для ВЛАДЕЛЬЦА!`);
        return;
      }
      const weather = args || 'clear';
      bot.chat(`/weather ${weather}`);
      bot.chat(`⛅ ${playerName}, погода изменена!`);
      break;

    case 'time':
      if (!isAdmin) {
        bot.chat(`❌ ${playerName}, эта команда только для ВЛАДЕЛЬЦА!`);
        return;
      }
      const time = args || '12000';
      bot.chat(`/time set ${time}`);
      bot.chat(`⏰ ${playerName}, время установлено!`);
      break;

    case 'broadcast':
      if (!isAdmin) {
        bot.chat(`❌ ${playerName}, эта команда только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ ${playerName}, используй: !broadcast [сообщение]`);
        return;
      }
      bot.chat(`§c§l[ОБЪЯВЛЕНИЕ]§r §6${args}`);
      logInfo(`📢 Объявление: ${args}`);
      break;

    default:
      bot.chat(`❌ ${playerName}, неизвестная команда !${command}`);
  }
}

// ======================== STATE ========================
const botState = {
  pendingPlayer: '',
  isCapturingGroups: false,
  foundGroups: []
};

// ======================== EXPRESS ========================
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).json({
    status: '✅ VoyagersSpace Bot v4.1',
    botConnected: !!bot?.entity,
    serverOnline: serverChecker.isOnline,
    admins: GAME_ADMINS,
    stats: db.data.stats
  });
});

app.get('/health', (req, res) => {
  res.status(bot?.entity && serverChecker.isOnline ? 200 : 503).json({
    status: bot?.entity ? 'healthy' : 'initializing',
    botOnline: !!bot?.entity,
    serverOnline: serverChecker.isOnline
  });
});

app.listen(config.server.port, '0.0.0.0', () => {
  logInfo(`🌐 Express на ${config.server.port}`);
});

// ======================== TELEGRAM КОМАНДЫ ========================
const isAdmin = (userId) => userId === config.tg.adminId;

tgBot.start(ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  ctx.reply(
    '👋 <b>VoyagersSpace Bot v4.1</b>\n\n' +
    '🔒 <b>Система защиты команд активна!</b>\n\n' +
    '<b>📋 Основные команды:</b>\n' +
    '/status - Статус\n' +
    '/commands - Все команды\n' +
    '/logs - Логи\n' +
    '/stats - Статистика\n\n' +
    '<b>🎁 Управление донатами:</b>\n' +
    '/adddonator [ник] [ранг]\n' +
    '/removedonator [ник]\n' +
    '/donators - Список\n\n' +
    '<b>👑 Администрирование:</b>\n' +
    '/help - Полная справка',
    { parse_mode: 'HTML' }
  );
});

tgBot.command('status', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  ctx.reply(
    `<b>📊 Статус системы</b>\n\n` +
    `БОТ: ${bot?.entity ? '✅ Онлайн' : '❌ Оффлайн'}\n` +
    `Сервер: ${serverChecker.isOnline ? '✅ Онлайн' : '❌ Оффлайн'}\n` +
    `Админы: ${GAME_ADMINS.join(', ')}\n` +
    `Всего команд: ${db.data.stats.totalCommands}`,
    { parse_mode: 'HTML' }
  );
});

tgBot.command('adddonator', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  const args = ctx.message.text.split(' ');
  const playerName = args[1];
  const rank = args[2]?.toUpperCase();

  if (!playerName || !rank) {
    return ctx.reply(
      '❌ <b>Используй:</b> /adddonator [ник] [ранг]\n\n' +
      '<b>Примеры:</b>\n' +
      '/adddonator player DIAMOND\n' +
      '/adddonator player PREMIUM\n' +
      '/adddonator player VIP',
      { parse_mode: 'HTML' }
    );
  }

  const validRanks = ['VIP', 'PREMIUM', 'DIAMOND'];
  if (!validRanks.includes(rank)) {
    return ctx.reply(`❌ Ранг должен быть: ${validRanks.join(', ')}`);
  }

  db.addDonator(playerName, rank);

  ctx.reply(
    `✅ <b>Донат добавлен!</b>\n\n` +
    `Игрок: <code>${playerName}</code>\n` +
    `Ранг: <code>${rank}</code>`,
    { parse_mode: 'HTML' }
  );
});

tgBot.command('removedonator', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  const args = ctx.message.text.split(' ');
  const playerName = args[1];

  if (!playerName) {
    return ctx.reply('❌ <b>Используй:</b> /removedonator [ник]', { parse_mode: 'HTML' });
  }

  if (db.removeDonator(playerName)) {
    ctx.reply(`✅ Донат удален: ${playerName}`);
  } else {
    ctx.reply(`❌ ${playerName} не найден`);
  }
});

tgBot.command('donators', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  const donators = db.getAllDonators();

  if (Object.keys(donators).length === 0) {
    return ctx.reply('❌ Донатов еще нет');
  }

  let text = '<b>🎁 Список донатов</b>\n\n';

  Object.entries(donators).forEach(([username, info]) => {
    text += `• <code>${username}</code> - <b>${info.rank}</b>\n`;
  });

  ctx.reply(text, { parse_mode: 'HTML' });
});

tgBot.command('logs', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  const logs = db.data.logs.slice(-15);
  let text = '<b>📋 Последние логи</b>\n\n';

  logs.forEach(log => {
    const time = new Date(log.timestamp).toLocaleTimeString('ru-RU');
    const status = log.allowed ? '✅' : '❌';
    text += `${status} ${time} - ${log.player} → !${log.command}\n`;
  });

  ctx.reply(text, { parse_mode: 'HTML' });
});

tgBot.command('stats', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  const stats = db.data.stats;

  ctx.reply(
    `<b>📈 Статистика</b>\n\n` +
    `Всего команд: ${stats.totalCommands}\n` +
    `Всего донатов: ${stats.totalDonats}\n` +
    `Блокировок: ${stats.blockedAttempts}`,
    { parse_mode: 'HTML' }
  );
});

tgBot.command('help', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Доступ запрещен');

  ctx.reply(
    `<b>📖 Справка</b>\n\n` +
    `<b>Обычные команды:</b>\n` +
    `!give [предмет] [кол-во]\n` +
    `!heal\n` +
    `!tpall\n` +
    `!gamemode [режим]\n` +
    `!effect [эффект] [уровень]\n` +
    `!fly\n` +
    `!speed [уровень]\n\n` +
    `<b>Админ команды (только voyagerplay):</b>\n` +
    `!say [сообщение]\n` +
    `!clear\n` +
    `!weather [тип]\n` +
    `!time [время]\n` +
    `!broadcast [сообщение]`,
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
      return ctx.reply('❌ Группы не найдены!');
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
  logInfo('🚀 VoyagersSpace Bot v4.1 запущен!');
  logInfo(`✅ Админы в игре: ${GAME_ADMINS.join(', ')}`);

  setInterval(async () => {
    await serverChecker.updateStatus();
    if (serverChecker.isOnline && !bot?.entity) {
      createMCBot();
    }
  }, 30000);

  await serverChecker.updateStatus();

  if (serverChecker.isOnline) {
    createMCBot();
  } else {
    logWarn('⏰ Сервер оффлайн, жду...');
  }

  tgBot.launch();
  logInfo('✅ Telegram бот запущен');
}

initialize();
