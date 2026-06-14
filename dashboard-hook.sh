#!/bin/bash
# dashboard-hook.sh
# ===================
# 供 Cherry Studio Agent 通过 Bash 工具调用的看板状态上报脚本。
# 用法: source dashboard-hook.sh <command> [args]
#
# 在 agent 代码中:
#   source /path/to/dashboard-hook.sh start "任务名" "main" "搜索中..."
#   source /path/to/dashboard-hook.sh update "$AGENT_ID" "分析数据" 60
#   source /path/to/dashboard-hook.sh end "$AGENT_ID" "completed"
#   source /path/to/dashboard-hook.sh end "$AGENT_ID" "failed" "连接超时"

DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3456}"
DASHBOARD_DEBUG="${DASHBOARD_DEBUG:-false}"

__dash_api() {
  local method="$1" path="$2" data="$3"
  if [ "$DASHBOARD_DEBUG" = "true" ]; then
    echo "[dashboard] $method $path $data" >&2
  fi
  # 使用 node 调用 report.js（静默降级，看板没启动不报错）
  local result
  result=$(node /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard/report.js "$@" 2>/dev/null)
  echo "$result"
}

dash_start() {
  local name="${1:-unnamed}" type="${2:-sub}" stage="${3:-初始化}"
  local result
  result=$(node /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard/report.js start \
    --name "$name" --type "$type" --stage "$stage" 2>/dev/null)
  if [ -n "$result" ] && [ "$result" != "null" ]; then
    AGENT_ID="$result"
    export AGENT_ID
    if [ "$DASHBOARD_DEBUG" = "true" ]; then
      echo "[dashboard] ✅ 启动上报成功: AGENT_ID=$AGENT_ID" >&2
    fi
  fi
}

dash_update() {
  local id="${1:-$AGENT_ID}" stage="$2" progress="$3"
  if [ -z "$id" ]; then
    [ "$DASHBOARD_DEBUG" = "true" ] && echo "[dashboard] ⚠ update 跳过: 无 AGENT_ID" >&2
    return
  fi
  node /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard/report.js update \
    --id "$id" ${stage:+--stage "$stage"} ${progress:+--progress "$progress"} 2>/dev/null
}

dash_end() {
  local id="${1:-$AGENT_ID}" status="${2:-completed}" error="$3"
  if [ -z "$id" ]; then
    [ "$DASHBOARD_DEBUG" = "true" ] && echo "[dashboard] ⚠ end 跳过: 无 AGENT_ID" >&2
    return
  fi
  node /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard/report.js end \
    --id "$id" --status "$status" ${error:+--error "$error"} 2>/dev/null
  unset AGENT_ID
}

dash_list() {
  node /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard/report.js list 2>/dev/null
}

# 根据命令自动执行
case "${1:-}" in
  start)   shift; dash_start "$@" ;;
  update)  shift; dash_update "$@" ;;
  end)     shift; dash_end "$@" ;;
  list)    dash_list ;;
  *)       echo "用法: source dashboard-hook.sh <start|update|end|list> [参数...]" >&2 ;;
esac