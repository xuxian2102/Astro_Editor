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

cleanup_wayland() {
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
