/**
 * Agent Dashboard Server
 * =======================
 * 实时监控 Cherry Studio Agent 运行状态的看板后端
 *
 * 监控方式：
 *   1. 主动监听 Cherry Studio 会话文件变更（被动监控）
 *   2. POST API 手动上报（主动推送，兼容旧方式）
 *
 * API 端点：
 *   POST /api/agent/start   - 上报 agent 启动（主动推送）
 *   POST /api/agent/update  - 上报 agent 进度更新
 *   POST /api/agent/end     - 上报 agent 结束
 *   GET  /api/agents        - 获取所有 agent 状态
 *   GET  /api/events        - SSE 实时推送
 *   GET  /                  - 看板前端页面
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3457;

// ========== Cherry Studio 路径配置 ==========

const CHERRY_AGENTS_DIR = 'C:\\Users\\20556\\AppData\\Roaming\\CherryStudio\\Data\\Agents';
const CHERRY_PROJECTS_DIR = 'C:\\Users\\20556\\AppData\\Roaming\\CherryStudio\\.claude\\projects';

// Agent ID → 人类可读名称映射
const AGENT_NAMES = {
  's4cwkbm18': '主控',
  'efrbku7d5': '执行者',
  'u4btnfunx': '黑暗体系 HTML构建',
  'ob2phb4xi': '执笔人',
  'v8avpklnu': '著作者',
  't-default': 'Cherry Assistant',
  'w-default': 'Cherry Claw (看板君)'
};

// 需要监控的 agent 目录 ID 列表（排除 t-default 和 w-default）
const MONITORED_AGENT_IDS = Object.keys(AGENT_NAMES).filter(id => id !== 't-default' && id !== 'w-default');

// ========== 内存状态存储 ==========

const agents = new Map();       // id -> agent 对象
const eventLog = [];            // 事件时间线
const sseClients = new Set();   // SSE 连接客户端

// 已知会话跟踪: sessionId -> { agentId, agentName, sessionId, filePath, lastActivity, isSubAgent, parentSessionId }
const knownSessions = new Map();

// 子 agent 待处理队列: 当 .meta.json 先于 .jsonl 出现时暂存
const pendingSubAgents = new Map(); // agent-xxx -> { meta, dirPath, timestamp }

const MAX_LOG_ENTRIES = 500;
const INACTIVITY_TIMEOUT_MS = 120000; // 2 分钟无活动视为结束
const INACTIVITY_CHECK_INTERVAL = 30000; // 每 30 秒检查一次

// ========== 工具函数 ==========

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function now() {
  return Date.now();
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function elapsed(start, end) {
  const ms = (end || now()) - start;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m${s % 60}s` : `${s}s`;
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

function addLog(agentId, eventType, detail) {
  const entry = { agentId, eventType, detail, timestamp: now(), time: formatTime(now()) };
  eventLog.push(entry);
  if (eventLog.length > MAX_LOG_ENTRIES) eventLog.shift();
  broadcast({ type: 'log', entry });
}

// ========== Agent 操作 ==========

function startAgent({ id, name, type, parentId, stage, _sessionId }) {
  const agent = {
    id: id || generateId(),
    name: name || 'unnamed',
    type: type || 'sub',
    parentId: parentId || null,
    status: 'running',
    stage: stage || '初始化',
    progress: 0,
    startTime: now(),
    endTime: null,
    duration: '0s',
    error: null,
    _sessionId: _sessionId || null
  };
  agents.set(agent.id, agent);
  addLog(agent.id, 'start', `${agent.name} 启动`);
  broadcast({ type: 'agent_update', agent });
  return agent;
}

function updateAgent({ id, stage, progress }) {
  const agent = agents.get(id);
  if (!agent) return null;
  if (stage) agent.stage = stage;
  if (progress !== undefined) agent.progress = Math.min(100, Math.max(0, progress));
  agent.duration = elapsed(agent.startTime);
  addLog(agent.id, 'update', stage ? `${agent.name}: ${stage}` : `${agent.name}: 进度 ${agent.progress}%`);
  broadcast({ type: 'agent_update', agent });
  return agent;
}

function endAgent({ id, status, error }) {
  const agent = agents.get(id);
  if (!agent) return null;
  agent.status = status || 'completed';
  agent.endTime = now();
  agent.duration = elapsed(agent.startTime, agent.endTime);
  if (error) agent.error = error;
  agent.progress = status === 'completed' ? 100 : agent.progress;
  addLog(agent.id, status === 'completed' ? 'end' : 'fail',
    `${agent.name} ${status === 'completed' ? '完成' : '失败'}${error ? ': ' + error : ''}`);
  broadcast({ type: 'agent_update', agent });

  // 5秒后自动清理已完成的 agent
  setTimeout(() => {
    if (agent.status !== 'running') {
      agents.delete(agent.id);
      broadcast({ type: 'agent_removed', id: agent.id });
    }
  }, 5000);

  return agent;
}

function getStats() {
  let running = 0, completed = 0, failed = 0;
  for (const a of agents.values()) {
    if (a.status === 'running') running++;
    else if (a.status === 'completed') completed++;
    else if (a.status === 'failed') failed++;
  }
  return { total: agents.size, running, completed, failed };
}

// ========== 从文件路径提取信息 ==========

/**
 * 从项目目录名提取 agent ID
 * 例如 "C--Users-20556-AppData-Roaming-CherryStudio-Data-Agents-s4cwkbm18" → "s4cwkbm18"
 */
function extractAgentIdFromDir(dirName) {
  const match = dirName.match(/Data-Agents-([^/\\]+?)$/);
  return match ? match[1] : null;
}

/**
 * 从项目目录名提取工作区名称（用于非 agent 会话的显示名）
 * 例如 "D--Desktop-cherryAi-texty-------" → "cherryAi_texty"
 */
function extractWorkspaceName(dirName) {
  // 尝试提取有意义的路径段
  const parts = dirName.split('--');
  if (parts.length >= 2) {
    // 取最后一个非空段（通常是项目名）
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] && parts[i] !== '-' && parts[i].length > 2) {
        return parts[i].replace(/-+/g, '_');
      }
    }
  }
  return null;
}

function getAgentName(agentId) {
  return AGENT_NAMES[agentId] || agentId;
}

/**
 * 判断是否为 agent 项目目录（不限监控列表，所有 agent 都识别）
 * 但后续是否创建卡片取决于是否有活跃写入
 */
function isAgentProjectDir(dirName) {
  const agentId = extractAgentIdFromDir(dirName);
  return agentId !== null;
}

/**
 * 为项目目录生成显示名称
 */
function getProjectDisplayName(dirName) {
  const agentId = extractAgentIdFromDir(dirName);
  if (agentId) {
    return getAgentName(agentId);
  }
  // 非 agent 项目，尝试提取工作区名称
  const wsName = extractWorkspaceName(dirName);
  if (wsName) {
    return '看板君 (' + wsName + ')';
  }
  return '会话-项目';
}

/**
 * 从 session 文件的 cwd 字段提取更精确的显示名
 * 例如 "D:\\Desktop\\cherryAi_texty\\分镜" → "分镜"
 */
function getDisplayNameFromCwd(cwd) {
  if (!cwd) return null;
  const parts = cwd.replace(/\\\\/g, '/').split('/');
  return parts[parts.length - 1] || null;
}

/**
 * 通过读取 session JSONL 文件头部获取 cwd
 */
function readCwdFromSession(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8').split('\n').slice(0, 10).join('\n');
    const match = content.match(/"cwd":"([^"]+)"/);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

/**
 * 为工作区项目生成更具辨识度的显示名（读取 cwd）
 */
function getSmartProjectDisplayName(dirName, sessionFilePath) {
  // 先读 cwd
  if (sessionFilePath) {
    const cwd = readCwdFromSession(sessionFilePath);
    if (cwd) {
      const folderName = getDisplayNameFromCwd(cwd);
      if (folderName) {
        // 特殊映射：分镜 → 分镜精炼师
        if (folderName === '分镜') return '分镜精炼师';
        return '看板君 (' + folderName + ')';
      }
    }
  }
  // 回退到原逻辑
  return getProjectDisplayName(dirName);
}

/**
 * 读取 session JSONL 文件的第一条用户消息，提取元信息
 */
function readSessionHeader(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8').split('\n').slice(0, 20).join('\n');

    // 查找第一个 type=user 且 message 存在的行
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message) {
          return {
            sessionId: entry.sessionId || entry.uuid || null,
            isSidechain: entry.isSidechain || false,
            agentId: entry.agentId || null,
            userMessage: entry.message?.role === 'user' ? (entry.message.content || '').slice(0, 100) : '',
            entrypoint: entry.entrypoint || null,
            timestamp: entry.timestamp || null
          };
        }
      } catch (e) {
        // 跳过无法解析的行
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 读取子 agent meta 信息
 */
function readSubAgentMeta(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

// ========== Cherry Studio 文件监控核心逻辑 ==========

/**
 * 处理检测到的 agent 会话（主会话或子会话）
 */
function handleDetectedSession(agentId, sessionId, name, type, parentSessionId, stage) {
  // 如果已经存在相同 sessionId 的 agent，跳过
  for (const [aid, agent] of agents) {
    if (agent._sessionId === sessionId) {
      return agent; // 已存在
    }
  }

  const parentId = parentSessionId ? findAgentBySessionId(parentSessionId) : null;

  const agent = startAgent({
    id: generateId(),
    name: name,
    type: type,
    parentId: parentId,
    stage: stage || '运行中',
    _sessionId: sessionId
  });

  console.log(`  [监控] 检测到 agent 会话: ${name} (${type}, session=${sessionId.slice(0, 8)}...)`);
  return agent;
}

function findAgentBySessionId(sessionId) {
  for (const [aid, agent] of agents) {
    if (agent._sessionId === sessionId) {
      return aid;
    }
  }
  return null;
}

/**
 * 处理新检测到的子 agent（从 .meta.json + .jsonl）
 */
function handleSubAgentDetection(subAgentId, meta, dirPath, sessionFile) {
  const key = subAgentId; // e.g. "agent-a44894c68338187df"

  // 从父会话 session file 推断父 agent
  const parentSessionId = extractParentSessionId(dirPath);

  // 子 agent 名称：使用 description 或 agentType
  const name = meta.description || meta.agentType || subAgentId;
  const type = 'sub';

  const sessionInfo = sessionFile ? readSessionHeader(sessionFile) : null;
  const sessionId = sessionInfo?.sessionId || subAgentId;
  const stage = sessionInfo?.userMessage ? `执行: ${sessionInfo.userMessage.slice(0, 40)}` : `${meta.agentType || '任务'}`;

  handleDetectedSession(null, sessionId, name, type, parentSessionId, stage);

  // 从 pending 中移除
  pendingSubAgents.delete(key);
}

function extractParentSessionId(subAgentsDirPath) {
  // subAgentsDirPath 类似 ".../ffadc3e6-e18b-.../subagents/"
  // 父会话 session ID 就是上一级目录名
  const parentDir = path.dirname(subAgentsDirPath);
  const sessionId = path.basename(parentDir);
  return sessionId;
}

/**
 * 扫描现有的所有会话文件，初始化看板状态
 * 为所有已知 agent 会话创建卡片（初始状态为 running）
 * 后续文件变更 + 不活动检测机制会动态更新卡片状态
 */
function scanAllSessions() {
  console.log('  [监控] 扫描并初始化所有 agent 会话卡片...');

  try {
    const projectDirs = fs.readdirSync(CHERRY_PROJECTS_DIR, { withFileTypes: true });

    for (const dirent of projectDirs) {
      if (!dirent.isDirectory()) continue;

      const agentId = extractAgentIdFromDir(dirent.name);
      const projectPath = path.join(CHERRY_PROJECTS_DIR, dirent.name);
      const topDir = dirent.name;

      // 扫描项目目录下的所有 .jsonl 文件（不限 agent 类型）
      const entries = fs.readdirSync(projectPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const filePath = path.join(projectPath, entry.name);
          const sessionId = entry.name.replace('.jsonl', '');
          const mtime = fs.statSync(filePath).mtimeMs;

          const isAgentSession = agentId && MONITORED_AGENT_IDS.includes(agentId);
          const displayName = isAgentSession
            ? getAgentName(agentId)
            : null; // 非 agent 会话不创建初始卡片

          // 只记录 info 到 knownSessions
          knownSessions.set(sessionId, {
            agentId: agentId || 'workspace',
            agentName: displayName || 'unknown',
            sessionId,
            filePath,
            lastActivity: mtime,
            isSubAgent: false,
            parentSessionId: null
          });

          knownFiles.add(filePath);

          // ★ 只对最近活跃（5分钟内）的已知 agent 创建初始卡片
          if (isAgentSession && (now() - mtime < 300000)) {
            const info = readSessionHeader(filePath);
            const stage = info?.userMessage
              ? `最近: ${info.userMessage.slice(0, 40)}`
              : '就绪';
            // 检查是否已有同名 session 卡片
            const existingAgentId = findAgentBySessionId(sessionId);
            if (!existingAgentId) {
              handleDetectedSession(agentId, sessionId, displayName, 'main', null, stage);
            }
          }
        }
      }
    }

    console.log(`  [监控] 已初始化 ${knownSessions.size} 个会话，创建了 ${agents.size} 个 agent 卡片`);
  } catch (e) {
    console.error('  [监控] 扫描会话失败:', e.message);
  }
}

// ========== 文件变更监控 ==========

let watchReady = false;

function setupFileWatcher() {
  console.log('  [监控] 设置文件监听...');

  try {
    // 使用 fs.watch 递归监听 projects 目录
    const watcher = fs.watch(CHERRY_PROJECTS_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename || watchReady === false) return;

      const normalizedPath = filename.replace(/\\/g, '/');

      // 分解路径结构: agent-dir/session-id/subagents/file 或 agent-dir/session-id.jsonl
      const parts = normalizedPath.split('/');

      // 检查是否是 .jsonl 或 .meta.json
      const isJsonl = normalizedPath.endsWith('.jsonl');
      const isMeta = normalizedPath.endsWith('.meta.json');

      if (!isJsonl && !isMeta) return;

      // 判断路径类型：
      // 如果路径包含 subagents/ → 子 agent（不限制 agent 目录）
      const hasSubagents = parts.includes('subagents');

      if (!hasSubagents) {
        // 主会话 — 放行所有（不限 agent 目录）
        // extractAgentIdFromDir 会返回 null 但没关系，handleFileChange 会处理
      }

      const fullPath = path.join(CHERRY_PROJECTS_DIR, filename);
      const agentId = !hasSubagents ? extractAgentIdFromDir(parts[0]) : null;
      handleFileChange(normalizedPath, fullPath, agentId, isJsonl, isMeta);
    });

    watcher.on('error', (err) => {
      console.error('  [监控] 文件监听出错:', err.message);
    });

    // 同时设置轮询作为后备（每 5 秒）
    setInterval(pollForChanges, 5000);

    // 设置定期不活动检查
    setInterval(checkInactivity, INACTIVITY_CHECK_INTERVAL);

    setTimeout(() => { watchReady = true; }, 1000);
    console.log('  [监控] 文件监听已启动 (watch + 5s polling backup)');
  } catch (e) {
    console.error('  [监控] 设置文件监听失败:', e.message);
    console.log('  [监控] 降级到纯轮询模式 (每 5 秒)');

    setInterval(pollForChanges, 5000);
    setInterval(checkInactivity, INACTIVITY_CHECK_INTERVAL);
    setTimeout(() => { watchReady = true; }, 1000);
  }
}

/**
 * 处理单个文件变更事件
 */
function handleFileChange(normalizedPath, fullPath, agentId, isJsonl, isMeta) {
  // 路径示例:
  //   C--...-s4cwkbm18/ffadc3e6-....jsonl          → 主会话
  //   C--...-s4cwkbm18/ffadc3e6-..../subagents/agent-xxx.jsonl  → 子会话
  //   C--...-s4cwkbm18/ffadc3e6-..../subagents/agent-xxx.meta.json → 子 meta
  //   D--Desktop---/b59ce4a2-..../subagents/agent-xxx.jsonl      → 工作区子会话

  const parts = normalizedPath.split('/');

  // 如果是主会话 .jsonl (在项目根目录, parts.length === 2)
  if (isJsonl && parts.length === 2) {
    const sessionId = parts[1].replace('.jsonl', '');
    const topDir = parts[0];
    const dirAgentId = extractAgentIdFromDir(topDir);
    const effectiveAgentId = agentId || dirAgentId;

    // 判断是否为已知 agent（监控列表）还是会话工作区
    const isAgentSession = effectiveAgentId && MONITORED_AGENT_IDS.includes(effectiveAgentId);

    if (!knownSessions.has(sessionId)) {
      const displayName = isAgentSession
        ? getAgentName(effectiveAgentId)
        : getSmartProjectDisplayName(topDir, fullPath);

      knownSessions.set(sessionId, {
        agentId: effectiveAgentId || 'workspace',
        agentName: displayName,
        sessionId,
        filePath: fullPath,
        lastActivity: now(),
        isSubAgent: false,
        parentSessionId: null
      });

      // 读取会话头部获取更多信息
      const info = readSessionHeader(fullPath);
      const stage = info?.userMessage ? `执行: ${info.userMessage.slice(0, 40)}` : '运行中';

      // fs.watch 触发的文件变更，说明会话正在活跃写入 → 创建卡片
      handleDetectedSession(effectiveAgentId, sessionId, displayName, 'main', null, stage);
    } else {
      // 更新活动时间
      const session = knownSessions.get(sessionId);
      session.lastActivity = now();

      // 如果 agent 卡片已被清理但会话重新活跃，重新创建卡片
      const existingAgentId = findAgentBySessionId(sessionId);
      if (!existingAgentId) {
        const info = readSessionHeader(fullPath);
        const stage = info?.userMessage ? `执行: ${info.userMessage.slice(0, 40)}` : '运行中';
        const displayName = isAgentSession
          ? getAgentName(effectiveAgentId)
          : getSmartProjectDisplayName(topDir, fullPath);
        handleDetectedSession(effectiveAgentId, sessionId, displayName, 'main', null, stage);
      }
    }
    return;
  }

  // === 子 agent 文件（不论项目目录，只要在 subagents/ 下都检测）===

  // 处理 .meta.json
  if (isMeta && parts.includes('subagents')) {
    const subAgentId = parts[parts.length - 1].replace('.meta.json', '');
    const subAgentsDir = path.dirname(fullPath);
    const jsonlPath = path.join(subAgentsDir, subAgentId + '.jsonl');

    const meta = readSubAgentMeta(fullPath);
    if (!meta) return;

    const jsonlExists = fs.existsSync(jsonlPath);
    if (jsonlExists) {
      handleSubAgentDetection(subAgentId, meta, subAgentsDir, jsonlPath);
    } else {
      pendingSubAgents.set(subAgentId, { meta, dirPath: subAgentsDir, timestamp: now() });
    }
    return;
  }

  // 处理子会话 .jsonl (在 subagents/ 目录下)
  if (isJsonl && parts.includes('subagents')) {
    const subAgentId = parts[parts.length - 1].replace('.jsonl', '');
    const subAgentsDir = path.dirname(fullPath);

    if (pendingSubAgents.has(subAgentId)) {
      const pending = pendingSubAgents.get(subAgentId);
      handleSubAgentDetection(subAgentId, pending.meta, subAgentsDir, fullPath);
    } else {
      const metaPath = path.join(subAgentsDir, subAgentId + '.meta.json');
      const meta = fs.existsSync(metaPath) ? readSubAgentMeta(metaPath) : null;
      if (meta) {
        handleSubAgentDetection(subAgentId, meta, subAgentsDir, fullPath);
      }
    }
  }
}

/**
 * 轮询检测变更（后备方案）
 */
let lastPollTime = 0;
const knownFiles = new Set();

function pollForChanges() {
  const nowTime = now();
  if (nowTime - lastPollTime < 4000) return; // 防抖

  try {
    const projectDirs = fs.readdirSync(CHERRY_PROJECTS_DIR, { withFileTypes: true });

    for (const dirent of projectDirs) {
      if (!dirent.isDirectory()) continue;

      const agentId = extractAgentIdFromDir(dirent.name);
      const projectPath = path.join(CHERRY_PROJECTS_DIR, dirent.name);

      // 所有项目目录都扫描主会话（不限 agent 类型）
      collectMainSessionFiles(projectPath, agentId);

      // 所有项目目录都扫描 subagents/（无论是否已知 agent）
      collectSubAgentFiles(projectPath);
    }

    // 处理待处理的子 agent（等待 .jsonl 超过 10 秒的强制处理）
    for (const [key, pending] of pendingSubAgents) {
      if (now() - pending.timestamp > 10000) {
        const jsonlPath = path.join(pending.dirPath, key + '.jsonl');
        if (fs.existsSync(jsonlPath)) {
          handleSubAgentDetection(key, pending.meta, pending.dirPath, jsonlPath);
        } else {
          handleDetectedSession(null, key, pending.meta.description || pending.meta.agentType || key, 'sub',
            extractParentSessionId(pending.dirPath), pending.meta.agentType || '任务');
          pendingSubAgents.delete(key);
        }
      }
    }

    lastPollTime = nowTime;
  } catch (e) {
    // 轮询出错，忽略
  }
}

/**
 * 扫描已知 agent 项目目录下所有会话中的 subagents/
 */
function collectSubAgentFiles(projectPath) {
  try {
    const entries = fs.readdirSync(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'memory' || entry.name.startsWith('.')) continue;

      const subDir = path.join(projectPath, entry.name, 'subagents');
      if (!fs.existsSync(subDir)) continue;

      const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.isFile() && sub.name.endsWith('.meta.json')) {
          const metaPath = path.join(subDir, sub.name);
          const subAgentKey = sub.name.replace('.meta.json', '');
          const jsonlPath = path.join(subDir, subAgentKey + '.jsonl');

          if (!knownFiles.has(metaPath)) {
            knownFiles.add(metaPath);
            const meta = readSubAgentMeta(metaPath);
            if (meta) {
              const jsonlExists = fs.existsSync(jsonlPath);
              if (jsonlExists) {
                knownFiles.add(jsonlPath);
                // 只显示 10 分钟内活跃的子 agent
                const mtime = fs.statSync(jsonlPath).mtimeMs;
                if (now() - mtime < 600000) {
                  handleSubAgentDetection(subAgentKey, meta, subDir, jsonlPath);
                }
              } else {
                pendingSubAgents.set(subAgentKey, { meta, dirPath: subDir, timestamp: now() });
              }
            }
          }
        }

        if (sub.isFile() && sub.name.endsWith('.jsonl') && sub.name.startsWith('agent-')) {
          const jsonlPath = path.join(subDir, sub.name);
          const subAgentKey = sub.name.replace('.jsonl', '');

          if (!knownFiles.has(jsonlPath)) {
            knownFiles.add(jsonlPath);
            const metaPath = path.join(subDir, subAgentKey + '.meta.json');
            const meta = fs.existsSync(metaPath) ? readSubAgentMeta(metaPath) : null;
            if (meta) {
              const mtime = fs.statSync(jsonlPath).mtimeMs;
              if (now() - mtime < 600000) {
                handleSubAgentDetection(subAgentKey, meta, subDir, jsonlPath);
              }
            }
          }
        }
      }
    }
  } catch (e) {
    // 忽略错误
  }
}

/**
 * 扫描所有项目目录的主会话文件（不限 agent 类型）
 */
function collectMainSessionFiles(projectPath, agentId) {
  try {
    const topDir = path.basename(projectPath);
    const entries = fs.readdirSync(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) {
        const fullPath = path.join(projectPath, entry.name);
        const sessionId = entry.name.replace('.jsonl', '');

        // 这个项目目录的显示名
        const isAgentSession = agentId && MONITORED_AGENT_IDS.includes(agentId);
        const displayName = isAgentSession
          ? getAgentName(agentId)
          : getSmartProjectDisplayName(topDir, fullPath);

        // 检查文件修改时间 - 只关心最近活跃的会话（5分钟内）
        let stat;
        try { stat = fs.statSync(fullPath); } catch(e) { continue; }
        const fileMtime = stat.mtimeMs;
        const isRecentlyActive = (now() - fileMtime) < 300000; // 5分钟

        // 检查文件是否被修改过（根据 mtime）
        let isModified = false;
        if (knownFiles.has(fullPath)) {
          try {
            const known = knownSessions.get(sessionId);
            if (known && fileMtime > known.lastActivity) {
              isModified = true;
              // 更新 lastActivity 为当前时间（活跃会话持续刷新）
              known.lastActivity = now();
            }
          } catch(e) {}
        } else {
          knownFiles.add(fullPath);
          // ★ 只有最近活跃的会话才被视为 "新" 并创建卡片
          if (isRecentlyActive) {
            isModified = true;
          }
        }

        if (!isModified) continue;

        if (!knownSessions.has(sessionId)) {
          knownSessions.set(sessionId, {
            agentId: agentId || 'workspace',
            agentName: displayName,
            sessionId,
            filePath: fullPath,
            lastActivity: now(),
            isSubAgent: false,
            parentSessionId: null
          });

          const info = readSessionHeader(fullPath);
          const stage = info?.userMessage ? `执行: ${info.userMessage.slice(0, 40)}` : '运行中';
          handleDetectedSession(agentId, sessionId, displayName, 'main', null, stage);
        } else {
          const session = knownSessions.get(sessionId);
          session.lastActivity = now();

          // 如果 agent 卡片已被清理，重新创建
          const existingAgentId = findAgentBySessionId(sessionId);
          if (!existingAgentId && isRecentlyActive) {
            const info = readSessionHeader(fullPath);
            const stage = info?.userMessage ? `执行: ${info.userMessage.slice(0, 40)}` : '运行中';
            handleDetectedSession(agentId, sessionId, displayName, 'main', null, stage);
          }
        }
      }
    }
  } catch (e) {
    // 忽略目录读取错误
  }
}

/**
 * 检查不活动的会话，标记为已完成
 */
function checkInactivity() {
  const nowTime = now();

  for (const [sessionId, session] of knownSessions) {
    if (session.lastActivity && (nowTime - session.lastActivity) > INACTIVITY_TIMEOUT_MS) {
      // 找对应的 agent
      const agentId = findAgentBySessionId(sessionId);
      if (agentId) {
        const agent = agents.get(agentId);
        if (agent && agent.status === 'running') {
          console.log(`  [监控] 会话 ${sessionId.slice(0, 8)}... 已不活动，标记为完成`);
          endAgent({ id: agentId, status: 'completed' });
        }
      }
      // 从 knownSessions 中移除（但保留记录避免重复触发）
      // 实际上我们保留它但更新 lastActivity 为 null 表示已处理
      session.lastActivity = null;
    }
  }
}

// ========== 初始化监控 ==========

function initFileMonitoring() {
  console.log('\n  ┌──────────────────────────────────────────┐');
  console.log('  │  🕵️  Cherry Studio 文件监控              │');
  console.log('  ├──────────────────────────────────────────┤');
  console.log(`  │  监控目录: ${CHERRY_PROJECTS_DIR.slice(0, 50)}...│`);
  console.log('  │  监控模式: 文件监听 + 轮询 + 不活动检测   │');
  console.log('  │  监控范围: 所有 agent + 工作区会话       │');
  console.log('  │  已知 Agent:');
  for (const id of Object.keys(AGENT_NAMES)) {
    console.log(`  │    ${id} → ${getAgentName(id)}`);
  }
  console.log('  └──────────────────────────────────────────┘\n');

  scanAllSessions();
  setupFileWatcher();
}

// ========== HTTP 请求解析 ==========

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJSON(res, { error: 'Not Found' }, 404);
    } else {
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      res.end(data);
    }
  });
}

// ========== 路由处理 ==========

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS 预检
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // SSE 端点
  if (pathname === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // 发送当前所有 agent 状态
    const allAgents = Array.from(agents.values());
    res.write(`data: ${JSON.stringify({ type: 'init', agents: allAgents, log: eventLog.slice(-50), stats: getStats() })}\n\n`);

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // API 路由
  if (pathname === '/api/agent/start' && method === 'POST') {
    const body = await parseBody(req);
    const agent = startAgent(body);
    return sendJSON(res, { ok: true, agent });
  }

  if (pathname === '/api/agent/update' && method === 'POST') {
    const body = await parseBody(req);
    const agent = updateAgent(body);
    return sendJSON(res, { ok: !!agent, agent });
  }

  if (pathname === '/api/agent/end' && method === 'POST') {
    const body = await parseBody(req);
    const agent = endAgent(body);
    return sendJSON(res, { ok: !!agent, agent });
  }

  if (pathname === '/api/agents' && method === 'GET') {
    const allAgents = Array.from(agents.values());
    return sendJSON(res, { agents: allAgents, stats: getStats(), log: eventLog.slice(-100) });
  }

  // 静态文件
  if (pathname === '/') {
    return sendFile(res, path.join(__dirname, 'public', 'index.html'));
  }

  const filePath = path.join(__dirname, 'public', pathname);
  return sendFile(res, filePath);
}

// ========== 启动服务 ==========

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`\n  🚀 Agent 监控看板已启动！`);
  console.log(`  ─────────────────────────────`);
  console.log(`  看板地址: http://localhost:${PORT}`);
  console.log(`  API 端点: http://localhost:${PORT}/api/agents`);
  console.log(`  SSE 推送: http://localhost:${PORT}/api/events`);
  console.log(`  ─────────────────────────────`);
  console.log(`  主动推送 API (备用):`);
  console.log(`  POST /api/agent/start  { name, type, stage }`);
  console.log(`  POST /api/agent/update { id, stage, progress }`);
  console.log(`  POST /api/agent/end    { id, status, error }`);
  console.log(`\n`);

  // 启动文件监控
  initFileMonitoring();
});