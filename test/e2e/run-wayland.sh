#!/usr/bin/env bash
set -euo pipefail

for required_command in wl-copy wl-paste; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "缺少 $required_command；Arch Linux 请安装 wl-clipboard" >&2
    exit 1
  fi
done

runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/blog-editor-wayland.XXXXXX")
chmod 700 "$runtime_dir"
compositor_log="$runtime_dir/compositor.log"
compositor_pid=""
compositor_name=""
close_smoke_pid=""
workspace_root=$(realpath "$(dirname "${BASH_SOURCE[0]}")/../..")

cleanup_wayland() {
  if [[ -n "$close_smoke_pid" ]]; then
    kill "$close_smoke_pid" 2>/dev/null || true
    wait "$close_smoke_pid" 2>/dev/null || true
  fi
  if [[ -n "$compositor_pid" ]]; then
    kill "$compositor_pid" 2>/dev/null || true
    wait "$compositor_pid" 2>/dev/null || true
  fi
  if [[ -d "$runtime_dir" ]]; then
    rm -r "$runtime_dir"
  fi
}
trap cleanup_wayland EXIT

start_sway() {
  compositor_name="sway"
  local sway_config="$runtime_dir/sway.conf"
  printf '%s\n' \
    'xwayland disable' \
    'swaybg_command -' \
    'seat seat0 fallback true' \
    'output * mode 1280x800' >"$sway_config"
  env -u DISPLAY -u WAYLAND_DISPLAY \
    XDG_RUNTIME_DIR="$runtime_dir" \
    WLR_BACKENDS=headless \
    WLR_HEADLESS_OUTPUTS=1 \
    WLR_LIBINPUT_NO_DEVICES=1 \
    WLR_RENDERER=pixman \
    sway --unsupported-gpu --config "$sway_config" \
    >"$compositor_log" 2>&1 &
  compositor_pid=$!
}

# KWin 的 virtual backend 只作为 Arch 开发机上的等价隔离后备；CI 安装并使用
# wlroots/Sway，和个人机器上的 Hyprland 走同一类 data-control 剪贴板协议。
start_kwin() {
  compositor_name="kwin_wayland"
  env -u DISPLAY -u WAYLAND_DISPLAY \
    XDG_RUNTIME_DIR="$runtime_dir" \
    QT_QPA_PLATFORM=offscreen \
    kwin_wayland --virtual --socket wayland-e2e \
    --width 1280 --height 800 --no-lockscreen --no-global-shortcuts \
    >"$compositor_log" 2>&1 &
  compositor_pid=$!
}

if command -v sway >/dev/null 2>&1; then
  start_sway
elif command -v kwin_wayland >/dev/null 2>&1; then
  start_kwin
else
  echo "缺少隔离 Wayland compositor；Arch Linux 请安装 sway" >&2
  exit 1
fi

wayland_socket=""
for _attempt in {1..200}; do
  for socket_candidate in "$runtime_dir"/wayland-*; do
    if [[ -S "$socket_candidate" ]]; then
      wayland_socket=$(basename "$socket_candidate")
      break 2
    fi
  done
  if ! kill -0 "$compositor_pid" 2>/dev/null; then
    break
  fi
  sleep 0.05
done

if [[ -z "$wayland_socket" ]]; then
  echo "隔离 Wayland compositor 未能启动：" >&2
  sed -n '1,240p' "$compositor_log" >&2
  exit 1
fi

echo "[wayland-e2e] compositor=$compositor_name socket=$wayland_socket DISPLAY=<unset>"

wayland_environment=(
  env
  -u DISPLAY
  -u XDG_CURRENT_DESKTOP
  -u XDG_SESSION_DESKTOP
  -u DESKTOP_SESSION
  XDG_RUNTIME_DIR="$runtime_dir"
  WAYLAND_DISPLAY="$wayland_socket"
  XDG_SESSION_TYPE=wayland
  XDG_CACHE_HOME="$runtime_dir/cache"
  XDG_CONFIG_HOME="$runtime_dir/config"
  XDG_DATA_HOME="$runtime_dir/data"
  GDK_BACKEND=wayland
  WEBKIT_DISABLE_DMABUF_RENDERER=1
)
wayland_test=(
  pnpm exec wdio run test/e2e/wdio.conf.mjs
)

if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]] && command -v dbus-run-session >/dev/null 2>&1; then
  "${wayland_environment[@]}" dbus-run-session -- "${wayland_test[@]}"
else
  "${wayland_environment[@]}" "${wayland_test[@]}"
fi

run_native_close_smoke() {
  if [[ "$compositor_name" != "sway" ]]; then
    echo "[wayland-e2e] 原生关闭握手 smoke 跳过：需要 Sway IPC（CI 固定使用 Sway）"
    return
  fi

  local sway_socket=""
  local socket_candidate
  for socket_candidate in "$runtime_dir"/sway-ipc.*.sock; do
    if [[ -S "$socket_candidate" ]]; then
      sway_socket="$socket_candidate"
      break
    fi
  done
  if [[ -z "$sway_socket" ]]; then
    echo "找不到隔离 Sway 的 IPC socket" >&2
    sed -n '1,240p' "$compositor_log" >&2
    return 1
  fi

  local app_binary="${BLOG_EDITOR_CLOSE_SMOKE_BINARY:-$workspace_root/src-tauri/target/debug/blog-editor-e2e}"
  if [[ "$app_binary" != /* ]]; then
    app_binary="$workspace_root/$app_binary"
  fi
  if [[ ! -x "$app_binary" ]]; then
    echo "原生关闭握手 smoke 缺少可执行文件：$app_binary" >&2
    return 1
  fi

  local app_output="$runtime_dir/close-smoke-output.log"
  # debug smoke 二进制包含测试专用 WebDriver；端口 0 让内核分配临时端口，
  # 避免上一段 WDIO 会话刚退出时与默认 4445 端口竞争。release 会忽略它。
  "${wayland_environment[@]}" TAURI_WEBDRIVER_PORT=0 "$app_binary" >"$app_output" 2>&1 &
  close_smoke_pid=$!

  local window_seen=0
  local tree
  for _attempt in {1..200}; do
    if ! kill -0 "$close_smoke_pid" 2>/dev/null; then
      break
    fi
    tree=$(swaymsg -s "$sway_socket" -r -t get_tree 2>/dev/null || true)
    if printf '%s' "$tree" | grep -Eq "\"pid\"[[:space:]]*:[[:space:]]*$close_smoke_pid([,}])"; then
      window_seen=1
      break
    fi
    sleep 0.05
  done
  if ((window_seen == 0)); then
    echo "应用窗口没有出现在隔离 Sway 中" >&2
    sed -n '1,240p' "$app_output" >&2
    return 1
  fi

  # 窗口映射早于 React effect；等待关闭监听器完成注册，再让 compositor 发出
  # 真实 xdg_toplevel.close，覆盖 onCloseRequested -> destroy 的完整权限握手。
  sleep 0.5
  if ! swaymsg -s "$sway_socket" "[pid=\"$close_smoke_pid\"] kill" \
    >"$runtime_dir/close-smoke-swaymsg.log" 2>&1; then
    echo "Sway 无法发送原生关闭请求" >&2
    sed -n '1,240p' "$runtime_dir/close-smoke-swaymsg.log" >&2
    return 1
  fi

  for _attempt in {1..100}; do
    if ! kill -0 "$close_smoke_pid" 2>/dev/null; then
      break
    fi
    sleep 0.05
  done
  if kill -0 "$close_smoke_pid" 2>/dev/null; then
    echo "原生关闭请求后应用仍在运行；关闭握手失败" >&2
    sed -n '1,240p' "$app_output" >&2
    return 1
  fi

  local app_status=0
  wait "$close_smoke_pid" || app_status=$?
  close_smoke_pid=""
  if ((app_status != 0)); then
    echo "应用收到原生关闭请求后异常退出：status=$app_status" >&2
    sed -n '1,240p' "$app_output" >&2
    return 1
  fi

  local diagnostic_log="$app_output"
  if [[ "${BLOG_EDITOR_CLOSE_SMOKE_EXPECT_FILE_LOG:-0}" == "1" ]]; then
    diagnostic_log="$runtime_dir/data/dev.xuxian.blogeditor/logs/blog-editor.log"
    if [[ ! -f "$diagnostic_log" ]]; then
      echo "release 应用没有创建预期日志：$diagnostic_log" >&2
      sed -n '1,240p' "$app_output" >&2
      return 1
    fi
  fi
  for expected_log in "已启动" "应用退出清理完成"; do
    if ! grep -Fq "$expected_log" "$diagnostic_log"; then
      echo "诊断日志缺少生命周期记录：$expected_log" >&2
      sed -n '1,240p' "$diagnostic_log" >&2
      return 1
    fi
  done

  echo "[wayland-e2e] 原生关闭握手 smoke 通过（binary=$(basename "$app_binary")）"
}

run_native_close_smoke
