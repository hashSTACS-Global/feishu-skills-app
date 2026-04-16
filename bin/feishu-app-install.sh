#!/usr/bin/env bash
# feishu-app-install.sh — 在 EC/OpenClaw 沙箱中安装或升级 Feishu Skills APP。
#
# 幂等：首次运行 = 安装，再次运行 = 升级。
#
# 用法（在 EC chat 或飞书中让 bot 执行）：
#   bash <(curl -sL https://raw.githubusercontent.com/hashSTACS-Global/feishu-skills-app/main/bin/feishu-app-install.sh)
#
# 或者先 clone 再运行：
#   git clone https://github.com/hashSTACS-Global/feishu-skills-app.git
#   bash feishu-skills-app/bin/feishu-app-install.sh

set -e

REPO_URL="https://github.com/hashSTACS-Global/feishu-skills-app.git"
REMOTE_CONFIG_URL="https://raw.githubusercontent.com/hashSTACS-Global/feishu-skills-app/main/feishu-skills.yaml"

# ---------------------------------------------------------------------------
# 版本比较辅助函数
# ---------------------------------------------------------------------------
get_local_version() {
  local config="$1/feishu-skills.yaml"
  [ -f "$config" ] && grep -m1 '^version:' "$config" | sed 's/version: *//' || echo "0.0.0"
}

get_remote_version() {
  curl -sL --max-time 5 "$REMOTE_CONFIG_URL" 2>/dev/null | grep -m1 '^version:' | sed 's/version: *//' || echo ""
}

# 返回 0 如果 $1 < $2（需要升级），返回 1 如果 $1 >= $2（已是最新）
version_lt() {
  [ "$1" = "$2" ] && return 1
  local lowest
  lowest=$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)
  [ "$lowest" = "$1" ]
}

# ---------------------------------------------------------------------------
# 1. 检测 tenant root
# ---------------------------------------------------------------------------
TENANT_ROOT="$(pwd | sed -E 's|(.*/\.enclaws/tenants/[^/]+).*|\1|')"
if [ "$TENANT_ROOT" = "$(pwd)" ] || [ ! -d "$TENANT_ROOT" ]; then
  echo "未检测到 EC 沙箱环境。如果你在本地机器上，请直接 clone 后用 node 跑 bin/feishu-runner.mjs："
  echo "  git clone $REPO_URL"
  echo "  cd feishu-skills-app && node bin/feishu-runner.mjs list"
  exit 1
fi

REPO_DIR="$TENANT_ROOT/feishu-skills-app"
SKILL_DIR="$TENANT_ROOT/skills/feishu-skills"

# ---------------------------------------------------------------------------
# 2. 安装或升级
# ---------------------------------------------------------------------------
if [ -d "$REPO_DIR/.git" ]; then
  # 已存在 → 检查是否需要升级
  LOCAL_VER=$(get_local_version "$REPO_DIR")
  REMOTE_VER=$(get_remote_version)

  if [ -z "$REMOTE_VER" ]; then
    echo "⚠️ 无法获取远端版本号，跳过版本检查，直接升级..."
    cd "$REPO_DIR"
    git pull --ff-only
    echo "✅ 代码已更新。"
  elif version_lt "$LOCAL_VER" "$REMOTE_VER"; then
    echo "检测到新版本：$LOCAL_VER → $REMOTE_VER，正在升级..."
    cd "$REPO_DIR"
    git pull --ff-only
    echo "✅ 已升级到 $REMOTE_VER"
  else
    echo "✅ 当前版本 $LOCAL_VER 已是最新，无需升级。"
  fi
else
  # 不存在 → 首次安装
  echo "正在安装 feishu-skills-app..."

  # 如果当前目录下有刚 clone 的 feishu-skills-app，直接移过去
  if [ -d "feishu-skills-app/.git" ]; then
    rm -rf "$REPO_DIR"
    mv feishu-skills-app "$REPO_DIR"
  else
    git clone --depth 1 "$REPO_URL" "$REPO_DIR"
  fi

  echo "✅ 代码已安装到 $REPO_DIR"
fi

# ---------------------------------------------------------------------------
# 3. 注册 skill 入口（每次都刷新，确保 SKILL.md 是最新的）
# ---------------------------------------------------------------------------
mkdir -p "$SKILL_DIR"
cp "$REPO_DIR/SKILL.md" "$SKILL_DIR/SKILL.md"
echo "✅ skill 入口已注册到 $SKILL_DIR/SKILL.md"

# ---------------------------------------------------------------------------
# 4. 报告结果
# ---------------------------------------------------------------------------
echo ""
echo "=== 安装完成 ==="
echo "请开启新会话以加载最新 skill。"
echo "首次使用时会通过飞书 OAuth 卡片引导你完成授权。"
echo ""
echo "可用 pipeline 列表："
node "$REPO_DIR/bin/feishu-runner.mjs" list 2>/dev/null || echo "（运行 node bin/feishu-runner.mjs list 查看）"
