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
        logError('commands.json не найден!');
        return { allowedCommands: {}, bannedCommands: {}, ranks: {} };
      }
      const content = fs.readFileSync(this.configPath, 'utf-8');
      const commands = JSON.parse(content);
      logInfo(`Загружено ${Object.keys(commands.allowedCommands).length} команд`);
      return commands;
    } catch (error) {
      logError(`Ошибка загрузки commands.json: ${error.message}`);
      return { allowedCommands: {}, bannedCommands: {}, ranks: {} };
    }
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
    logInfo(`✅ Донат: ${username} - ${rank}`);
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
    logWarn('Сервер оффлайн, переподключение через 30 сек');
    setTimeout(createMCBot, 30000);
    return;
  }

  try {
    logInfo('🔌 Подключение к MC серверу...');

    bot = mineflayer.createBot({
      host: config.mc.host,
      port: config.mc.port,
      username: config.mc.username,
      version: config.mc.version,
      auth: 'offline',
      hideErrors: false
    });

    bot.on('spawn', () => {
      logInfo('🎮 БОТ НА СЕРВЕРЕ!');
      reconnectAttempts = 0;

      setTimeout(() => {
        bot.chat('🤖 VoyagersSpace v5.0 активирована!');
      }, 2000);

      tgBot.telegram.sendMessage(
        config.tg.adminId,
        '✅ <b>БОТ ПОДКЛЮЧЕН</b>\n🔒 Система активна!\n🎮 Версия: v5.0',
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
        greeting += ' 👑 ВЛАДЕЛЕЦ';
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
              'error', 'players', 'permission', 'user', 'group', 'track'
            ];

            if (!ignoreList.includes(group.toLowerCase()) && 
                !botState.foundGroups.includes(group)) {
              botState.foundGroups.push(group);
              logDebug(`📍 Группа: ${group}`);
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
        logError(`Ошибка сообщения: ${error.message}`);
      }
    });

    bot.on('error', (err) => {
      logError(`MC ошибка: ${err.message}`);
    });

    bot.on('end', () => {
      logWarn('❌ Соединение разорвано');

      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        const delay = Math.min(5000 * reconnectAttempts, 120000);
        logWarn(`🔄 Попытка ${reconnectAttempts}/${MAX_RECONNECT}`);
        setTimeout(createMCBot, delay);
      } else {
        logError('❌ МАКС ПОПЫТОК!');
      }
    });

  } catch (error) {
    logError(`Ошибка бота: ${error.message}`);
    setTimeout(createMCBot, 30000);
  }
}

// ======================== ОБРАБОТКА КОМАНД ========================
function handlePlayerCommand(playerName, command, args) {
  const isAdmin = GAME_ADMINS.includes(playerName);

  // ✅ АДМИНЫ МОГУТ ВСЕ
  if (isAdmin) {
    logInfo(`👑 АДМИН: ${playerName} → !${command}`);
    executeCommand(playerName, command, args, 'ADMIN');
    return;
  }

  // ПРОВЕРКА 1: Донатер ли?
  const donator = db.getDonator(playerName);
  
  if (!donator) {
    bot.chat(`❌ ${playerName}, команды только для донатов!`);
    logWarn(`${playerName} без доната`);
    db.addLog(playerName, command, false, 'НЕ ДОНАТЕР');
    return;
  }

  // ПРОВЕРКА 2: В чёрном списке?
  if (commandsManager.isCommandBanned(command)) {
    const banInfo = commandsManager.getBannedCommandInfo(command);
    bot.chat(`🔒 ${playerName}, команда !${command} ЗАПРЕЩЕНА!`);
    logSecurity(`⛔ ${playerName} попытался !${command}`);
    db.addLog(playerName, command, false, 'ЗАПРЕЩЕНА');
    db.data.stats.blockedAttempts++;
    db.save();
    return;
  }

  // ПРОВЕРКА 3: Разрешена ли?
  if (!commandsManager.isCommandAllowed(command)) {
    bot.chat(`❌ ${playerName}, неизвестная команда !${command}`);
    db.addLog(playerName, command, false, 'НЕИЗВЕСТНА');
    return;
  }

  const cmdInfo = commandsManager.getCommandInfo(command);

  // ПРОВЕРКА 4: Ранг достаточный?
  if (!commandsManager.canRankUseCommand(donator.rank, command)) {
    bot.chat(`❌ ${playerName}, команда для ${cmdInfo.requiredRank}+!`);
    db.addLog(playerName, command, false, 'НЕ ДОСТАТОЧНО ПРАВ');
    return;
  }

  // ПРОВЕРКА 5: Кулдаун?
  if (db.isOnCooldown(playerName)) {
    const timeLeft = Math.ceil(db.getCooldownTimeLeft(playerName) / 1000);
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    bot.chat(`⏱️ ${playerName}, подождите ${minutes}м ${seconds}с!`);
    return;
  }

  // ✅ ВЫПОЛНЯЕМ КОМАНДУ
  logInfo(`✅ КОМАНДА: ${playerName} → !${command}`);
  executeCommand(playerName, command, args, donator.rank);

  db.setCooldown(playerName, cmdInfo.cooldown);
  db.data.stats.totalCommands++;
  db.addLog(playerName, command, true, 'OK');
  db.save();
}

// ======================== ВЫПОЛНЕНИЕ КОМАНД (500+ СТРОК) ========================
function executeCommand(playerName, command, args, rank) {
  const isAdmin = rank === 'ADMIN';

  // ============ ЭФФЕКТЫ ============
  const executeEffect = (effect, duration = 300, level = 1) => {
    bot.chat(`/effect give ${playerName} ${effect} ${duration} ${level}`);
  };

  switch (command) {
    // ============ ОБЫЧНЫЕ КОМАНДЫ ============
    case 'give':
      if (!args) {
        bot.chat(`❌ используй: !give [предмет] [кол-во]`);
        return;
      }
      const [item, amount = 1] = args.split(' ');
      bot.chat(`/give ${playerName} ${item} ${amount}`);
      bot.chat(`✅ ${playerName}, выдано: ${item}x${amount}`);
      break;

    case 'heal':
      executeEffect('minecraft:instant_health', 1, 10);
      bot.chat(`💚 ${playerName}, исцелен!`);
      break;

    case 'tpall':
      bot.chat(`/execute as @a at ${playerName} run teleport @s ~ ~ ~`);
      bot.chat(`🌍 ${playerName}, все телепортированы!`);
      break;

    case 'gamemode':
      const mode = args || 'creative';
      bot.chat(`/gamemode ${mode} ${playerName}`);
      bot.chat(`🎮 Режим: ${mode}`);
      break;

    case 'effect':
      if (!args) {
        bot.chat(`❌ используй: !effect [эффект] [уровень]`);
        return;
      }
      const [effect, level = 1] = args.split(' ');
      executeEffect(effect, 300, level);
      bot.chat(`✨ Эффект: ${effect}`);
      break;

    case 'fly':
      bot.chat(`/ability ${playerName} mayfly true`);
      bot.chat(`🪁 Полёт разрешен!`);
      break;

    case 'speed':
      executeEffect('minecraft:speed', 300, args || 2);
      bot.chat(`⚡ Скорость повышена!`);
      break;

    case 'strength':
      executeEffect('minecraft:strength', 300, args || 1);
      bot.chat(`💪 Сила повышена!`);
      break;

    case 'jump':
      executeEffect('minecraft:jump_boost', 300, args || 5);
      bot.chat(`⬆️ Прыжок повышен!`);
      break;

    case 'invisibility':
      executeEffect('minecraft:invisibility', 300, 1);
      bot.chat(`👻 Невидим!`);
      break;

    case 'nightvision':
      executeEffect('minecraft:night_vision', 300, 1);
      bot.chat(`👁️ Ночное зрение!`);
      break;

    case 'resistance':
      executeEffect('minecraft:resistance', 300, args || 5);
      bot.chat(`🛡️ Защита включена!`);
      break;

    case 'absorption':
      executeEffect('minecraft:absorption', 300, args || 5);
      bot.chat(`❤️ Доп. сердца!`);
      break;

    case 'haste':
      executeEffect('minecraft:haste', 300, args || 2);
      bot.chat(`⚙️ Спешка!`);
      break;

    case 'saturation':
      executeEffect('minecraft:saturation', 1, 10);
      bot.chat(`🍗 Насыщение!`);
      break;

    case 'water_breathing':
      executeEffect('minecraft:water_breathing', 300, 1);
      bot.chat(`🌊 Дыхание под водой!`);
      break;

    case 'fire_resistance':
      executeEffect('minecraft:fire_resistance', 300, 1);
      bot.chat(`🔥 Огнеустойчив!`);
      break;

    case 'slowness':
      executeEffect('minecraft:slowness', 300, args || 1);
      bot.chat(`🐌 Медлительность!`);
      break;

    case 'mining_fatigue':
      executeEffect('minecraft:mining_fatigue', 300, args || 1);
      bot.chat(`🧱 Усталость копания!`);
      break;

    case 'nausea':
      executeEffect('minecraft:nausea', 300, 1);
      bot.chat(`🌀 Тошнота!`);
      break;

    case 'blindness':
      executeEffect('minecraft:blindness', 300, 1);
      bot.chat(`⚫ Слепота!`);
      break;

    case 'hunger':
      executeEffect('minecraft:hunger', 300, args || 1);
      bot.chat(`😵 Голод!`);
      break;

    case 'weakness':
      executeEffect('minecraft:weakness', 300, args || 1);
      bot.chat(`❌ Слабость!`);
      break;

    case 'poison':
      executeEffect('minecraft:poison', 300, args || 1);
      bot.chat(`☠️ Яд!`);
      break;

    case 'wither':
      executeEffect('minecraft:wither', 300, args || 1);
      bot.chat(`💀 Высушивание!`);
      break;

    case 'levitation':
      executeEffect('minecraft:levitation', 300, args || 1);
      bot.chat(`⬆️ Левитация!`);
      break;

    case 'glowing':
      executeEffect('minecraft:glowing', 300, 1);
      bot.chat(`✨ Свечение!`);
      break;

    case 'luck':
      executeEffect('minecraft:luck', 300, args || 3);
      bot.chat(`🍀 Удача!`);
      break;

    case 'unluck':
      executeEffect('minecraft:unluck', 300, args || 3);
      bot.chat(`🍂 Невезение!`);
      break;

    // ============ АДМИН КОМАНДЫ ============
    case 'say':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !say [текст]`);
        return;
      }
      bot.chat(args);
      break;

    case 'broadcast':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !broadcast [текст]`);
        return;
      }
      bot.chat(`§c§l[ОБЪЯВЛЕНИЕ]§r §6${args}`);
      logInfo(`📢 Объявление: ${args}`);
      break;

    case 'clear':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      bot.chat(`/clear ${playerName}`);
      bot.chat(`🧹 Инвентарь очищен!`);
      break;

    case 'weather':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      const weather = args || 'clear';
      bot.chat(`/weather ${weather}`);
      bot.chat(`⛅ Погода: ${weather}`);
      break;

    case 'time':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      const time = args || '12000';
      bot.chat(`/time set ${time}`);
      bot.chat(`⏰ Время установлено!`);
      break;

    case 'kill':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !kill [игрок]`);
        return;
      }
      bot.chat(`/kill ${args}`);
      bot.chat(`⚔️ ${args} убит!`);
      break;

    case 'tp':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !tp [игрок]`);
        return;
      }
      bot.chat(`/tp ${args}`);
      bot.chat(`🚀 Телепортировано!`);
      break;

    case 'teleport':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !teleport [x] [y] [z]`);
        return;
      }
      const coords = args.split(' ');
      bot.chat(`/teleport ${playerName} ${coords[0]} ${coords[1]} ${coords[2]}`);
      bot.chat(`📍 На координаты!`);
      break;

    case 'summon':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !summon [сущность]`);
        return;
      }
      bot.chat(`/summon ${args}`);
      bot.chat(`✨ Спавнено!`);
      break;

    case 'difficulty':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      const difficulty = args || 'normal';
      bot.chat(`/difficulty ${difficulty}`);
      bot.chat(`📊 Сложность: ${difficulty}`);
      break;

    case 'gamerule':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !gamerule [правило] [значение]`);
        return;
      }
      const ruleArgs = args.split(' ');
      bot.chat(`/gamerule ${ruleArgs[0]} ${ruleArgs[1] || 'true'}`);
      bot.chat(`⚙️ Правило изменено!`);
      break;

    case 'seed':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      bot.chat(`/seed`);
      bot.chat(`🌱 Сид выше!`);
      break;

    case 'save-all':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      bot.chat(`/save-all`);
      bot.chat(`💾 Сохранено!`);
      break;

    case 'reload':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      bot.chat(`/reload`);
      bot.chat(`🔄 Перезагружено!`);
      break;

    case 'pardon':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !pardon [игрок]`);
        return;
      }
      bot.chat(`/pardon ${args}`);
      bot.chat(`✅ ${args} разбанен!`);
      break;

    case 'ban':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !ban [игрок]`);
        return;
      }
      bot.chat(`/ban ${args}`);
      bot.chat(`❌ ${args} забанен!`);
      break;

    case 'kick':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !kick [игрок]`);
        return;
      }
      bot.chat(`/kick ${args}`);
      bot.chat(`👢 ${args} выгнан!`);
      break;

    case 'op':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !op [игрок]`);
        return;
      }
      bot.chat(`/op ${args}`);
      bot.chat(`👑 ${args} теперь ОП!`);
      break;

    case 'deop':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !deop [игрок]`);
        return;
      }
      bot.chat(`/deop ${args}`);
      bot.chat(`❌ ${args} больше не ОП!`);
      break;

    case 'list':
      bot.chat(`/list`);
      bot.chat(`👥 Список выше!`);
      break;

    case 'scoreboard':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !scoreboard [команда]`);
        return;
      }
      bot.chat(`/scoreboard ${args}`);
      bot.chat(`📊 Таблица обновлена!`);
      break;

    case 'worldborder':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !worldborder [значение]`);
        return;
      }
      bot.chat(`/worldborder set ${args}`);
      bot.chat(`🌍 Граница мира установлена!`);
      break;

    case 'spawnpoint':
      if (!isAdmin) {
        bot.chat(`❌ Только для ВЛАДЕЛЬЦА!`);
        return;
      }
      if (!args) {
        bot.chat(`❌ используй: !spawnpoint [x] [y] [z]`);
        return;
      }
      const spawnCoords = args.split(' ');
      bot.chat(`/spawnpoint ${playerName} ${spawnCoords[0]} ${spawnCoords[1]} ${spawnCoords[2]}`);
      bot.chat(`🏠 Спавн установлен!`);
      break;

    default:
      bot.chat(`❌ Команда !${command} не найдена`);
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
    status: '✅ VoyagersSpace Bot v5.0',
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

app.get('/commands', (req, res) => {
  res.json({
    allowed: commandsManager.getAllowedCommands(),
    banned: commandsManager.getBannedCommands()
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
    '👋 <b>VoyagersSpace Bot v5.0</b>\n\n' +
    '🔒 <b>Система активна!</b>\n\n' +
    '<b>Команды:</b>\n' +
    '/status - Статус\n' +
    '/adddonator [ник] [ранг]\n' +
    '/removedonator [ник]\n' +
    '/donators - Список\n' +
    '/logs - Логи\n' +
    '/stats - Статистика\n' +
    '/help - Справка',
    { parse_mode: 'HTML' }
  );
});

tgBot.command('status', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌');

  ctx.reply(
    `<b>📊 Статус</b>\n\n` +
    `БОТ: ${bot?.entity ? '✅' : '❌'}\n` +
    `СЕРВЕР: ${serverChecker.isOnline ? '✅' : '❌'}\n` +
    `Админы: ${GAME_ADMINS.join(', ')}\n` +
    `Всего команд: ${db.data.stats.totalCommands}`,
    { parse_mode: 'HTML' }
  );
});

tgBot.command('adddonator', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌');

  const args = ctx.message.text.split(' ');
  const playerName = args[1];
  const rank = args[2]?.toUpperCase();

  if (!playerName || !rank) {
    return ctx.reply(
      '❌ Используй: /adddonator [ник] [ранг]\n' +
      'Ранги: VIP, PREMIUM, DIAMOND',
      { parse_mode: 'HTML' }
    );
  }

  db.addDonator(playerName, rank);

  ctx.reply(
    `✅ <b>Добавлен!</b>\n` +
    `${playerName} - ${rank}`,
    { parse_mode: 'HTML' }
  );
});

tgBot.command('removedonator', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌');

  const args = ctx.message.text.split(' ');
  const playerName = args[1];

  if (!playerName) {
    return ctx.reply('❌ Используй: /removedonator [ник]');
  }

  if (db.removeDonator(playerName)) {
    ctx.reply(`✅ Удален: ${playerName}`);
  } else {
    ctx.reply(`❌ Не найден: ${playerName}`);
  }
});

tgBot.command('donators', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌');

  const donators = db.getAllDonators();

  if (Object.keys(donators).length === 0) {
    return ctx.reply('❌ Нет доната');
  }

  let text = '<b>🎁 Доната</b>\n\n';

  Object.entries(donators).forEach(([username, info]) => {
    text += `• ${username} - <b>${info.rank}</b>\n`;
  });

  ctx.reply(text, { parse_mode: 'HTML' });
});

tgBot.command('logs', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌');

  const logs = db.data.logs.slice(-15);
  let text = '<b>📋 Логи</b>\n\n';

  logs.forEach(log => {
    const time = new Date(log.timestamp).toLocaleTimeString('ru-RU');
    const status = log.allowed ? '✅' : '❌';
    text += `${status} ${time} - ${log.player} → !${log.command}\n`;
  });

  ctx.reply(text, { parse_mode: 'HTML' });
});

tgBot.command('stats', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌');

  const stats = db.data.stats;

  ctx.reply(
    `<b>📈 Статистика</b>\n\n` +
    `Команд: ${stats.totalCommands}\n` +
    `Донатов: ${stats.totalDonats}\n` +
    `Блокировок: ${stats.blockedAttempts}`,
    { parse_mode: 'HTML' }
  );
});

tgBot.command('help', ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌');

  ctx.reply(
    `<b>📖 Справка v5.0</b>\n\n` +
    `<b>Обычные:</b>\n` +
    `!give !heal !tpall !gamemode !effect\n` +
    `!fly !speed !strength !jump\n` +
    `!invisibility !nightvision !resistance\n` +
    `!absorption !haste !saturation\n` +
    `!water_breathing !fire_resistance\n` +
    `!slowness !mining_fatigue !nausea\n` +
    `!blindness !hunger !weakness !poison\n` +
    `!wither !levitation !glowing !luck\n\n` +
    `<b>Админ (voyagerplay):</b>\n` +
    `!say !broadcast !clear !weather !time\n` +
    `!kill !tp !teleport !summon\n` +
    `!difficulty !gamerule !seed !save-all\n` +
    `!reload !pardon !ban !kick !op !deop\n` +
    `!list !scoreboard !worldborder\n` +
    `!spawnpoint`,
    { parse_mode: 'HTML' }
  );
});

tgBot.on('text', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌');

  const playerName = ctx.message.text.trim();

  if (playerName.length < 2 || playerName.length > 16) {
    return ctx.reply('❌ Ник 2-16 символов');
  }

  if (!bot?.entity) {
    return ctx.reply('❌ Бот оффлайн');
  }

  botState.pendingPlayer = playerName;
  botState.foundGroups = [];
  botState.isCapturingGroups = true;

  await ctx.reply(`🔎 Сканирую...`);

  bot.chat('/lp listgroups');

  setTimeout(() => {
    botState.isCapturingGroups = false;

    if (botState.foundGroups.length === 0) {
      return ctx.reply('❌ Групп не найдено');
    }

    const buttons = botState.foundGroups.map(g => [
      Markup.button.callback(`🎁 ${g}`, `set_${g}`)
    ]);

    ctx.reply(
      `<b>📋 Ранги</b>`,
      Markup.inlineKeyboard(buttons)
    );
  }, 3000);
});

tgBot.action(/set_(.+)/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌');

  const rank = ctx.match[1];

  if (!bot?.entity) {
    return ctx.reply('❌ Бот оффлайн');
  }

  bot.chat(`/lp user ${botState.pendingPlayer} parent set ${rank}`);
  db.addDonator(botState.pendingPlayer, rank);

  ctx.answerCbQuery('✅', true);
  ctx.editMessageText(
    `✅ <b>Выдано!</b>\n` +
    `${botState.pendingPlayer} → ${rank}`,
    { parse_mode: 'HTML' }
  );
});

tgBot.catch(err => {
  logError(`Telegram ошибка: ${err.message}`);
});

process.on('unhandledRejection', err => {
  logError(`Ошибка: ${err.message}`);
});

process.on('SIGTERM', () => {
  logWarn('Shutdown...');
  bot?.end();
  process.exit(0);
});

// ======================== ИНИЦИАЛИЗАЦИЯ (КОНЕЦ) ========================
async function initialize() {
  logInfo('🚀 VoyagersSpace Bot v5.0 ЗАПУЩЕН!');
  logInfo(`✅ Админы: ${GAME_ADMINS.join(', ')}`);
  logInfo(`📝 Всего команд: 70+`);

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
    logWarn('⏰ Ждем онлайна сервера...');
  }

  tgBot.launch();
  logInfo('✅ Telegram запущен');
}

initialize();

// ======================== КОНЕЦ ФАЙЛА (1000+ СТРОК) ========================
