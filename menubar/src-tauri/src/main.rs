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

/// detached 方式跑 `token-pilot sync`，找不到命令就忽略
fn spawn_sync() {
    if let Ok(mut child) = Command::new("token-pilot")
        .arg("sync")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        // 后台线程回收子进程，避免僵尸；不阻塞 UI
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

/// 数据文件不存在或 mtime 超过 90s
fn data_stale() -> bool {
    match fs::metadata(data_path()) {
        Ok(m) => match m.modified() {
            Ok(t) => t.elapsed().map(|e| e.as_secs() > 90).unwrap_or(true),
            Err(_) => true,
        },
        Err(_) => true,
    }
}

fn dashboard_server_up() -> bool {
    let addr: std::net::SocketAddr = match "127.0.0.1:17895".parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// 打开完整看板：优先显示内置原生窗口（自带数据，不依赖 serve）；
/// 窗口不可用时退回浏览器（serve 或静态 bake 文件）。
fn open_dashboard_impl(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    if dashboard_server_up() {
        let _ = open::that("http://127.0.0.1:17895");
        return;
    }
    let html = dashboard_html_path();
    if html.exists() {
        let _ = open::that(&html);
        return;
    }
    let _ = open::that("http://127.0.0.1:17895");
}

/// 把面板定位到托盘图标下方（CatPaw 式 dropdown）；
/// 空间不够就翻到图标上方（Windows 底栏场景），左右贴边时收进屏幕。
fn position_panel_at(w: &tauri::WebviewWindow, rect: &tauri::Rect) {
    let (btn_x, btn_y, btn_w, btn_h) = match (rect.position, rect.size) {
        (tauri::Position::Physical(p), tauri::Size::Physical(s)) => {
            (p.x as f64, p.y as f64, s.width as f64, s.height as f64)
        }
        (tauri::Position::Logical(p), tauri::Size::Logical(s)) => (p.x, p.y, s.width, s.height),
        _ => return,
    };
    let scale = w.scale_factor().unwrap_or(1.0);

    // 屏幕边界（物理坐标）
    let mon = w
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| w.primary_monitor().ok().flatten());
    let (mx, my, mw, mh) = mon
        .map(|m| {
            let p = m.position();
            let s = m.size();
            (p.x as f64, p.y as f64, s.width as f64, s.height as f64)
        })
        .unwrap_or((0.0, 0.0, 2560.0, 1440.0));

    let margin = 10.0;
    let gap = 6.0;
    // 面板逻辑 400×720 → 物理尺寸
    let panel_w = 400.0 * scale;
    let panel_h = 720.0 * scale;

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

/// 左键点托盘图标：面板已显示就关掉，否则定位并弹出（CatPaw toggle 语义）
fn toggle_panel_at(app: &tauri::AppHandle, rect: &tauri::Rect) {
    let Some(w) = app.get_webview_window("main") else { return };
    match w.is_visible() {
        Ok(true) => {
            let _ = w.hide();
        }
        _ => {
            position_panel_at(&w, rect);
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            // 打开时触发一次数据刷新（sync 有单飞锁，不会堆积）
            spawn_sync();
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
    fs::read_to_string(data_path()).unwrap_or_else(|_| "{}".to_string())
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
#[tauri::command]
fn save_config(json: String) -> Result<(), String> {
    let patch: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let cfg_path = home_dir().join(".token-pilot").join("config.json");
    let mut cur: Value = fs::read_to_string(&cfg_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    for k in ["monthlyBudgetCny", "priceOverrides", "cloudApis", "subscriptions"] {
        if let Some(v) = patch.get(k) {
            cur[k] = v.clone();
        }
    }
    if let Some(dir) = cfg_path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let out = serde_json::to_string_pretty(&cur).map_err(|e| e.to_string())?;
    fs::write(&cfg_path, out + "\n").map_err(|e| e.to_string())?;
    // 写完后触发一次 sync，让看板立刻用新配置重算
    spawn_sync();
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![get_data, hide_panel, open_dashboard, save_config])
        .setup(|app| {
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
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&title_i, &panel_i, &dash_i, &quit_i])?;

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
                .expect("tray icon png");
            let initial_title = data
                .as_ref()
                .map(tray_title)
                .unwrap_or_else(|| "token-pilot".to_string());
            let tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false) // 左键给面板，菜单只走右键
                .tooltip(&initial_title)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "open-panel" => show_panel(app),
                    "open-dashboard" => open_dashboard_impl(app),
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

            // 每 60s：数据缺失或超过 90s 未更新 → 后台 token-pilot sync；然后重读并刷新托盘
            {
                let tray_h = tray.clone();
                let item_h = title_i.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(60));
                    if data_stale() {
                        spawn_sync();
                    }
                    if let Some(v) = read_data() {
                        update_tray(&tray_h, &item_h, &v);
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
                tauri::WindowEvent::Focused(false) if window.label() == "main" => {
                    let _ = window.hide();
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
        });
}
