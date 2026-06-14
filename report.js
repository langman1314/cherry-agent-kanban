#!/usr/bin/env node
/**
 * Dashboard Reporter (CLI)
 * ========================
 * 供 Cherry Studio Agent 在运行时通过 Bash 工具调用的状态上报脚本。
 *
 * 用法：
 *   node report.js start    --name "任务名" --type main --stage "初始化"
 *   node report.js update   --id <agent-id> --stage "搜索中" --progress 50
 *   node report.js end      --id <agent-id> --status completed
 *   node report.js end      --id <agent-id> --status failed --error "错误信息"
 *   node report.js list                              # 查看当前所有 agent
 */

const http = require('http');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3456';

function api(path, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, DASHBOARD_URL);
    const body = JSON.stringify(data);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let resp = '';
      res.on('data', chunk => resp += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(resp)); }
        catch { resolve({ ok: false, error: resp }); }
      });
    });
    req.on('error', (err) => {
      // 看板未启动时不报错，静默降级
      if (process.env.DASHBOARD_DEBUG) {
        console.error(`[dashboard] 上报失败: ${err.message}`);
      }
      resolve({ ok: false, error: err.message });
    });
    req.write(body);
    req.end();
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const params = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        params[key] = val;
        i++;
      } else {
        params[key] = true;
      }
    }
  }
  return { cmd, params };
}

async function main() {
  const { cmd, params } = parseArgs();

  switch (cmd) {
    case 'start': {
      const result = await api('/api/agent/start', {
        name: params.name || 'unnamed',
        type: params.type || 'sub',
        stage: params.stage || '初始化',
        parentId: params.parentId || null
      });
      if (result.ok && result.agent) {
        // 输出 agent id 到 stdout，供后续命令使用
        console.log(result.agent.id);
      } else {
        console.error('启动上报失败');
        process.exit(1);
      }
      break;
    }

    case 'update': {
      if (!params.id) {
        console.error('缺少 --id 参数');
        process.exit(1);
      }
      await api('/api/agent/update', {
        id: params.id,
        stage: params.stage || undefined,
        progress: params.progress ? parseInt(params.progress) : undefined
      });
      break;
    }

    case 'end': {
      if (!params.id) {
        console.error('缺少 --id 参数');
        process.exit(1);
      }
      await api('/api/agent/end', {
        id: params.id,
        status: params.status || 'completed',
        error: params.error || undefined
      });
      break;
    }

    case 'list': {
      const url = new URL('/api/agents', DASHBOARD_URL);
      http.get(url.href, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            console.log(`Agent 总数: ${result.stats.total}`);
            console.log(`  运行中: ${result.stats.running}`);
            console.log(`  已完成: ${result.stats.completed}`);
            console.log(`  失败: ${result.stats.failed}`);
            console.log('---');
            result.agents.forEach(a => {
              console.log(`[${a.status}] ${a.name} (${a.type}) ⏱${a.duration} 📌${a.stage}`);
            });
          } catch {
            console.error('解析失败');
          }
        });
      });
      break;
    }

    default:
      console.log('用法: node report.js <start|update|end|list> [选项]');
      console.log('');
      console.log('  start   --name <名称> --type <main|sub> --stage <阶段> [--parentId <父id>]');
      console.log('  update  --id <agent-id> [--stage <阶段>] [--progress <0-100>]');
      console.log('  end     --id <agent-id> [--status <completed|failed>] [--error <信息>]');
      console.log('  list');
      process.exit(1);
  }
}

main().catch(err => {
  if (process.env.DASHBOARD_DEBUG) {
    console.error(`[dashboard] ${err.message}`);
  }
});