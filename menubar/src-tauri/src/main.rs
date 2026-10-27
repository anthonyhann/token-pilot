// token-pilot 菜单栏 — Tauri Rust 壳
// 数据：~/.token-pilot/dashboard-data.json（由 token-pilot sync 生成）
// 托盘标题 = trayTitle；窗口内的面板前端通过 get_data 命令拿整份 JSON 自行渲染

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, Wry};

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn data_path() -> PathBuf {
    home_dir().join(".token-pilot").join("dashboard-data.json")
}

fn dashboard_html_path() -> PathBuf {
    home_dir().join(".token-pilot").join("dashboard.html")
}

/// 随 app 编译进二进制的看板 HTML（构建时从 menubar/src/dashboard.html 读入）。
/// 桌面端打开看板优先用它，这样「app 更新了、看板却没更新」不会再发生。
const EMBEDDED_DASHBOARD: &str = include_str!("../../src/dashboard.html");

/// 把内嵌看板写到 ~/.token-pilot/dashboard.html。
/// 仅当文件不存在、或内容与内嵌版不一致时才写（避免每次启动都改动用户文件）。
/// 返回 true 表示发生了写入。写入失败（只读目录等）不致命，返回 false。
fn sync_embedded_dashboard() -> bool {
    let target = dashboard_html_path();
    let embedded = EMBEDDED_DASHBOARD;
    if let Ok(cur) = fs::read_to_string(&target) {
        if cur == embedded {
            return false; // 已是最新，不动
        }
    }
    if let Some(dir) = target.parent() {
        let _ = fs::create_dir_all(dir);
    }
    fs::write(&target, embedded).is_ok()
}

fn read_data() -> Option<Value> {
    let s = fs::read_to_string(data_path()).ok()?;
    serde_json::from_str(&s).ok()
}

/// ¥ 金额格式化：>=100 取整千分位，<100 两位去尾零
fn fmt_cny(v: f64) -> String {
    if v.abs() >= 100.0 {
        let n = v.round() as i64;
        let digits = n.abs().to_string();
        let mut out = String::new();
        for (i, c) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i) % 3 == 0 {
                out.push(',');
            }
            out.push(c);
        }
        format!("{}{}", if n < 0 { "-" } else { "" }, out)
    } else {
        let s = format!("{:.2}", v);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn tray_title(v: &Value) -> String {
    v.get("trayTitle")
        .and_then(|t| t.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "token-pilot".to_string())
}

/// 菜单首行：「今日 ¥x · 预算 y%」（无预算时省略预算段）
fn menu_label(v: &Value) -> String {
    let today = v.pointer("/hero/today/costCny").and_then(|x| x.as_f64());
    let pct = v.pointer("/budget/pct").and_then(|x| x.as_f64());
    match (today, pct) {
        (Some(c), Some(p)) => format!("今日 ¥{} · 预算 {:.0}%", fmt_cny(c), p),
        (Some(c), None) => format!("今日 ¥{}", fmt_cny(c)),
        _ => "今日 暂无数据".to_string(),
    }
}

fn update_tray(tray: &tauri::tray::TrayIcon, item: &MenuItem<Wry>, v: &Value) {
    // macOS 在图标旁显示文字；Windows 不支持则忽略错误
    let _ = tray.set_title(Some(tray_title(v)));
    let _ = item.set_text(menu_label(v));
}

/// 数据文件 mtime（用于变更检测）
fn data_mtime_ms() -> u64 {
    fs::metadata(data_path())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// 托盘标题当前值（变更检测用，避免重复 set_title 闪烁）
static TRAY_TITLE_CUR: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
// 托盘引用（setup 时存入，get_data 命令里也要用）
static TRAY_REFS: std::sync::OnceLock<(tauri::tray::TrayIcon, MenuItem<Wry>)> = std::sync::OnceLock::new();

/// 数据文件变了就刷新托盘（幂等：内容没变就不动）
fn refresh_tray_if_changed(tray: &tauri::tray::TrayIcon, item: &MenuItem<Wry>) {
    if let Some(v) = read_data() {
        let t = tray_title(&v);
        let mut cur = TRAY_TITLE_CUR.lock().unwrap();
        if *cur != t {
            *cur = t;
            update_tray(tray, item, &v);
        }
    }
}

fn refresh_tray_global() {
    if let Some((tray, item)) = TRAY_REFS.get() {
        refresh_tray_if_changed(tray, item);
    }
}

/// detached 方式跑 `token-pilot sync`，找不到命令就忽略
/// Windows 注意：CreateProcess 不解 PATHEXT，npm 装的 token-pilot 实际是 token-pilot.cmd，
/// 必须走 cmd /c；macOS/Linux 直接 exec。
/// sync 完成后立刻刷新托盘（不等下个 tick）。
fn spawn_sync() {
    spawn_sync_with(None);
}

fn spawn_sync_with(done: Option<Box<dyn FnOnce() + Send + 'static>>) {
    #[cfg(target_os = "windows")]
    let spawned = Command::new("cmd")
        .args(["/c", "token-pilot", "sync"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    #[cfg(not(target_os = "windows"))]
    let spawned = Command::new("token-pilot")
        .arg("sync")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut child) = spawned {
        std::thread::spawn(move || {
            let _ = child.wait();
            if let Some(f) = done {
                f();
            }
        });
    }
}

/// 数据文件不存在或 mtime 超过 45s
fn data_stale() -> bool {
    match fs::metadata(data_path()) {
        Ok(m) => match m.modified() {
            Ok(t) => t.elapsed().map(|e| e.as_secs() > 45).unwrap_or(true),
            Err(_) => true,
        },
        Err(_) => true,
    }
}


/// 打开完整看板：优先显示内置原生窗口（自带数据，不依赖 serve）；
/// 窗口不可用时退回浏览器。
///
/// 顺序上**内置窗口永远第一**：看板前端随 app 编译进二进制，
/// 这样「app 升了、看板还是旧的」不可能发生。
fn open_dashboard_impl(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    // 内置窗口不可用（异常兜底）：先把内嵌版落盘，保证打开的是当前版本
    sync_embedded_dashboard();
    let html = dashboard_html_path();
    if html.exists() {
        let _ = open::that(&html);
        return;
    }
    // 仍然不行才退回本地 serve
    let _ = open::that("http://127.0.0.1:17895");
}

/// 把面板定位到托盘图标下方（CatPaw 式 dropdown）；
/// 空间不够就翻到图标上方（Windows 底栏场景），左右贴边时收进屏幕。
///
/// 坐标系注意（读 tray-icon 0.25 源码确认）：macOS 下 rect 是**逻辑坐标（points）**，
/// 左上角原点（crate 已做 Y 翻转）。先统一换算成物理坐标再算。
/// 多显示器注意：set_position 的换算跟随窗口当前所在显示器的缩放，
/// 所以先把窗口扔到目标显示器中心，再精确落位。
fn position_panel_at(w: &tauri::WebviewWindow, rect: &tauri::Rect) {
    let scale0 = w.scale_factor().unwrap_or(1.0);
    let (btn_x, btn_y, btn_w, btn_h) = match (rect.position, rect.size) {
        (tauri::Position::Physical(p), tauri::Size::Physical(s)) => {
            (p.x as f64, p.y as f64, s.width as f64, s.height as f64)
        }
        (tauri::Position::Logical(p), tauri::Size::Logical(s)) => (
            p.x * scale0,
            p.y * scale0,
            s.width * scale0,
            s.height * scale0,
        ),
        _ => return,
    };

    // 图标所在显示器（物理坐标）
    let Some(mon) = w
        .app_handle()
        .monitor_from_point(btn_x, btn_y)
        .ok()
        .flatten()
        .or_else(|| w.primary_monitor().ok().flatten())
    else {
        return;
    };
    let mp = mon.position();
    let ms = mon.size();
    let (mx, my, mw, mh) = (
        mp.x as f64,
        mp.y as f64,
        ms.width as f64,
        ms.height as f64,
    );

    // 第一步：窗口扔到目标显示器中心（落位后 scale_factor 才是该显示器的）
    let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: (mx + mw / 2.0) as i32,
        y: (my + mh / 2.0) as i32,
    }));
    let scale = w.scale_factor().unwrap_or(scale0);
    // 面板实际物理尺寸（用户可能拖过大小）；兜底取默认 480×760
    let (panel_w, panel_h) = w
        .outer_size()
        .map(|s| (s.width as f64, s.height as f64))
        .unwrap_or((480.0 * scale, 760.0 * scale));

    let margin = 10.0;
    let gap = 6.0;

    let mut x = btn_x + btn_w / 2.0 - panel_w / 2.0;
    x = x.max(mx + margin).min(mx + mw - panel_w - margin);

    let mut y = btn_y + btn_h + gap;
    if y + panel_h > my + mh - margin {
        y = btn_y - panel_h - gap; // 下方放不下 → 翻到上方
    }
    if y < my + margin {
        y = my + margin;
    }

    let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: x as i32,
        y: y as i32,
    }));
}

// 实测：macOS 上一次物理点击会投递两个 Click(Up) 事件 → 面板开了立刻被关。
// 防抖：400ms 内的重复 Click(Up) 直接忽略。
static LAST_TOGGLE_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
// 面板打开时刻：打开序列自身会产生一次伪 Focused(false)，800ms 内的失焦不收起
static PANEL_OPENED_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 左键点托盘图标：面板已显示就关掉，否则定位并弹出（CatPaw toggle 语义）
fn toggle_panel_at(app: &tauri::AppHandle, rect: &tauri::Rect) {
    let t = now_ms();
    let prev = LAST_TOGGLE_MS.swap(t, std::sync::atomic::Ordering::SeqCst);
    if t - prev < 400 {
        return;
    }
    let Some(w) = app.get_webview_window("main") else { return };
    match w.is_visible() {
        Ok(true) => {
            let _ = w.hide();
        }
        _ => {
            PANEL_OPENED_MS.store(t, std::sync::atomic::Ordering::SeqCst);
            // 先显示+聚焦（窗口落位到目标显示器后才能拿到真实尺寸/缩放），再定位
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            position_panel_at(&w, rect);
            // 打开时触发一次数据刷新（sync 有单飞锁，不会堆积）；完成后立刻刷托盘
            spawn_sync_with(Some(Box::new(refresh_tray_global)));
        }
    }
}

fn show_panel(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn get_data() -> String {
    let s = fs::read_to_string(data_path()).unwrap_or_else(|_| "{}".to_string());
    // 面板轮询驱动托盘保鲜：面板拿到新数据时顺手刷新托盘（幂等，内容没变不动）
    refresh_tray_global();
    s
}

#[tauri::command]
fn hide_panel(window: tauri::WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
fn open_dashboard(app: tauri::AppHandle) {
    open_dashboard_impl(&app);
}

/// 设置弹窗写回：把 {monthlyBudgetCny, priceOverrides, cloudApis, subscriptions} 合并进 config.json
// ── RTK（rtk-oss 输出压缩层）─────────────────────────────────────────────
// 与 CLI 侧 src/core/rtk.ts 保持同样的判断口径：
//   - 'ours'    通过本工具装了 rtk-oss
//   - 'foreign' 系统里已有别的来源的 rtk（brew 主仓库 / 手动装）
//   - 'none'    没装
// rtk-oss 与 brew 主仓库的 rtk 都占用 `rtk` 二进制，brew formula 里声明了
// conflicts_with，所以装了别的来源时必须先卸载才能装 rtk-oss。

fn run_capture(cmd: &str, args: &[&str], timeout_secs: u64) -> Option<String> {
    // 单次执行 + 超时轮询。注意不能"轮询完再执行一遍拿输出"——那会把 brew 跑两次。
    let mut child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                // 子进程已退出，接着读它留下的管道输出
                let out = child.wait_with_output().ok()?;
                return Some(String::from_utf8_lossy(&out.stdout).trim().to_string());
            }
            Ok(None) => {
                if start.elapsed().as_secs() > timeout_secs {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(_) => return None,
        }
    }
}

fn brew_has(formula: &str) -> bool {
    match run_capture("brew", &["list", "--formula"], 20) {
        Some(out) => out.lines().map(|l| l.trim()).any(|l| l == formula),
        None => false,
    }
}

/// 返回 (source, version)。source ∈ {"ours","foreign","none"}
fn rtk_state() -> (String, String) {
    #[cfg(target_os = "windows")]
    {
        let ver = run_capture("rtk", &["--version"], 5);
        match ver {
            None => ("none".into(), String::new()),
            Some(v) => {
                let ours = run_capture(
                    "winget",
                    &["list", "--id", "rtk-ai.rtk-oss", "-e", "--accept-source-agreements"],
                    30,
                )
                .map(|o| o.contains("rtk-ai.rtk-oss"))
                .unwrap_or(false);
                (if ours { "ours".into() } else { "foreign".into() }, v)
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let ver = match run_capture("rtk", &["--version"], 5) {
            Some(v) => v,
            None => return ("none".into(), String::new()),
        };
        if brew_has("rtk-oss") {
            ("ours".into(), ver)
        } else {
            // brew 主仓库的 rtk，或手动安装
            ("foreign".into(), ver)
        }
    }
}

/// 安装 rtk-oss。返回 (ok, message)。
fn install_rtk() -> (bool, String) {
    let (source, version) = rtk_state();
    if source == "ours" {
        return (true, format!("RTK 已安装（{version}）"));
    }
    if source == "foreign" {
        return (
            false,
            format!(
                "检测到系统里已安装 {version}，但来源不是 rtk-oss，两者都占用 rtk 命令、会互相冲突。请先卸载现有的 rtk 再勾选。"
            ),
        );
    }

    #[cfg(target_os = "windows")]
    let ok = run_capture(
        "winget",
        &[
            "install",
            "--id",
            "rtk-ai.rtk-oss",
            "-e",
            "--accept-source-agreements",
            "--accept-package-agreements",
        ],
        300,
    )
    .is_some();
    #[cfg(not(target_os = "windows"))]
    let ok = run_capture("brew", &["install", "rtk-ai/tap/rtk-oss"], 300).is_some();

    if !ok {
        return (false, "安装命令执行失败（brew/winget 返回非 0），请检查网络或手动安装 rtk-oss".into());
    }
    let (source2, version2) = rtk_state();
    if source2 == "ours" {
        (true, format!("RTK 已安装（{version2}）"))
    } else {
        (false, "安装命令执行完了但检测到的 rtk 来源不对，请手动检查".into())
    }
}

/// 卸载 rtk-oss。只卸我们自己装的，别人的 rtk 不擅自删。
fn uninstall_rtk() -> (bool, String) {
    let (source, version) = rtk_state();
    if source == "none" {
        return (true, "RTK 未安装，无需卸载".into());
    }
    if source == "foreign" {
        return (
            false,
            format!("已安装 {version}，但不是本工具安装的，为避免误删请手动卸载"),
        );
    }
    #[cfg(target_os = "windows")]
    let ok = run_capture("winget", &["uninstall", "--id", "rtk-ai.rtk-oss", "-e"], 180).is_some();
    #[cfg(not(target_os = "windows"))]
    let ok = run_capture("brew", &["uninstall", "rtk-oss"], 180).is_some();

    if !ok {
        return (false, "卸载命令执行失败，请手动执行 brew uninstall rtk-oss".into());
    }
    if rtk_state().0 != "none" {
        (false, "卸载命令执行了但 rtk 仍可用，请手动检查".into())
    } else {
        (true, "已卸载 RTK".into())
    }
}

#[tauri::command]
fn save_config(json: String) -> Result<Value, String> {
    let patch: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let cfg_path = home_dir().join(".token-pilot").join("config.json");
    let mut cur: Value = fs::read_to_string(&cfg_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    for k in ["monthlyBudgetCny", "priceOverrides", "cloudApis", "subscriptions", "autoCompact"] {
        if let Some(v) = patch.get(k) {
            cur[k] = v.clone();
        }
    }
    // 用户明示后写 Claude Code 的 autoCompactEnabled
    if let Some(ac) = patch.get("autoCompact") {
        if ac.get("applyClaudeCode").and_then(|v| v.as_bool()) == Some(true) {
            let enabled = ac.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
            let cc = home_dir().join(".claude").join("settings.json");
            let mut ccj: Value = fs::read_to_string(&cc)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            ccj["autoCompactEnabled"] = Value::Bool(enabled);
            if let Ok(out) = serde_json::to_string_pretty(&ccj) {
                let _ = fs::write(&cc, out + "\n");
            }
        }
    }
    // RTK 装卸：与 CLI/Web 行为一致。
    // RTK 失败不阻塞其他设置的保存，但结果要带回前端。
    let mut rtk_note: Value = Value::Null;
    if let Some(ac) = patch.get("autoCompact").and_then(|v| v.as_object()) {
        if let Some(want) = ac.get("installRtk").and_then(|v| v.as_bool()) {
            let (source, _ver) = rtk_state();
            if want && source != "ours" {
                let (ok, msg) = install_rtk();
                rtk_note = serde_json::json!({ "ok": ok, "message": msg });
                // 装失败就把勾选还原，别让配置声称已装
                if !ok {
                    if let Some(obj) = cur.get_mut("autoCompact").and_then(|v| v.as_object_mut()) {
                        obj.insert("installRtk".into(), Value::Bool(false));
                    }
                }
            } else if !want && source == "ours" {
                let (ok, msg) = uninstall_rtk();
                rtk_note = serde_json::json!({ "ok": ok, "message": msg });
                if !ok {
                    if let Some(obj) = cur.get_mut("autoCompact").and_then(|v| v.as_object_mut()) {
                        obj.insert("installRtk".into(), Value::Bool(true));
                    }
                }
            }
        }
    }

    if let Some(dir) = cfg_path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let out = serde_json::to_string_pretty(&cur).map_err(|e| e.to_string())?;
    fs::write(&cfg_path, out + "\n").map_err(|e| e.to_string())?;
    // 写完后触发一次 sync，让看板立刻用新配置重算
    spawn_sync();
    Ok(serde_json::json!({ "ok": true, "rtk": rtk_note }))
}


/// 检查更新：有新版就下载安装并重启（updater 插件验签）；失败静默
fn check_update(app: &tauri::AppHandle) {
    let app_h = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_updater::UpdaterExt;
        let updater = app_h.updater();
        if let Ok(updater) = updater {
            match updater.check().await {
                Ok(Some(update)) => {
                    let _ = update
                        .download_and_install(|_c, _l| {}, || {})
                        .await;
                    app_h.restart();
                }
                _ => {}
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![get_data, hide_panel, open_dashboard, save_config])
        .setup(|app| {
            // 让 ~/.token-pilot/dashboard.html 与 app 内置版本保持一致：
            // 否则 app 升级后，走浏览器回退路径的人打开的还是旧看板。
            sync_embedded_dashboard();

            // macOS：Accessory 模式 = 无 Dock 图标、无菜单栏应用菜单，纯状态栏驻留
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let data = read_data();

            // 托盘菜单（右键）：今日金额 · 预算 / 打开面板 / 打开看板 / 退出
            let title_txt = data
                .as_ref()
                .map(menu_label)
                .unwrap_or_else(|| "今日 暂无数据".to_string());
            let title_i = MenuItem::with_id(app, "title", &title_txt, false, None::<&str>)?;
            let panel_i = MenuItem::with_id(app, "open-panel", "打开面板", true, None::<&str>)?;
            let dash_i = MenuItem::with_id(app, "open-dashboard", "打开看板", true, None::<&str>)?;
            let upd_i = MenuItem::with_id(app, "check-update", "检查更新", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&title_i, &panel_i, &dash_i, &upd_i, &quit_i])?;

            // 托盘图标分平台：macOS 用单色模板（深浅菜单栏自适应）；
            // Windows 用彩色版（纯黑闪电在深色任务栏上会隐形），template 语义仅 macOS 有效
            #[cfg(target_os = "macos")]
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))
                .expect("tray icon png");
            #[cfg(not(target_os = "macos"))]
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-win.png"))
                .expect("tray icon png");
            let is_template = cfg!(target_os = "macos");
            let initial_title = data
                .as_ref()
                .map(tray_title)
                .unwrap_or_else(|| "token-pilot".to_string());
            let tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(is_template)
                .menu(&menu)
                .show_menu_on_left_click(false) // 左键给面板，菜单只走右键
                .tooltip(&initial_title)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "open-panel" => show_panel(app),
                    "open-dashboard" => open_dashboard_impl(app),
                    "check-update" => check_update(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键点击托盘图标 → 面板在图标下方弹出/收起（CatPaw 式）
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_panel_at(tray.app_handle(), &rect);
                    }
                })
                .build(app)?;

            if let Some(v) = data.as_ref() {
                update_tray(&tray, &title_i, v);
            }
            let _ = TRAY_REFS.set((tray.clone(), title_i.clone()));

            // 自动更新：启动 10s 后查一次，之后每 6h
            {
                let app_h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(10));
                    check_update(&app_h);
                    loop {
                        std::thread::sleep(Duration::from_secs(6 * 3600));
                        check_update(&app_h);
                    }
                });
            }

            // 托盘刷新：5s 轻量 tick（只 stat mtime），文件一变立刻刷新；
            // 数据超过 45s 未更新 → 后台 sync（有单飞锁，不堆积），sync 完成回调里再立刻刷一次
            {
                let tray_h = tray.clone();
                let item_h = title_i.clone();
                let mut last_mtime = data_mtime_ms();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(5));
                    let m = data_mtime_ms();
                    if m != last_mtime {
                        last_mtime = m;
                        refresh_tray_if_changed(&tray_h, &item_h);
                    }
                    if data_stale() {
                        let tray_h2 = tray_h.clone();
                        let item_h2 = item_h.clone();
                        spawn_sync_with(Some(Box::new(move || {
                            refresh_tray_if_changed(&tray_h2, &item_h2);
                        })));
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // 关窗 = 隐藏，保持托盘常驻可再打开
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let _ = window.hide();
                    api.prevent_close();
                }
                // 面板失焦 = 自动收起（CatPaw 式：点面板外任意处即关）
                // 打开后 800ms 内的失焦是打开序列的伪事件，忽略
                tauri::WindowEvent::Focused(false) if window.label() == "main" => {
                    if now_ms() - PANEL_OPENED_MS.load(std::sync::atomic::Ordering::SeqCst) > 800 {
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building token-pilot menubar")
        .run(|app, _| {
            // 启动参数 --open-dashboard：直接打开看板窗口（验证/调试用）
            if std::env::args().any(|a| a == "--open-dashboard") {
                open_dashboard_impl(app);
            }
            // 启动参数 --test-panel：用托盘自身的 rect 开面板（不依赖外部点击注入）
            if std::env::args().any(|a| a == "--test-panel") {
                if let Some(tray) = app.tray_by_id("main") {
                    if let Ok(Some(rect)) = tray.rect() {
                        toggle_panel_at(app, &rect);
                    }
                }
            }
        });
}
