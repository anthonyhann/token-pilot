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

fn open_dashboard_impl() {
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
fn open_dashboard() {
    open_dashboard_impl();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![get_data, hide_panel, open_dashboard])
        .setup(|app| {
            let data = read_data();

            // 托盘菜单：今日金额 · 预算 / 打开面板 / 打开看板 / 退出
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
                .tooltip(&initial_title)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "open-panel" => show_panel(app),
                    "open-dashboard" => open_dashboard_impl(),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键点击托盘图标 → 面板显示/隐藏
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            match w.is_visible() {
                                Ok(true) => {
                                    let _ = w.hide();
                                }
                                _ => show_panel(app),
                            }
                        }
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
            // 关窗 = 隐藏，保持托盘常驻可再打开
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running token-pilot menubar");
}
