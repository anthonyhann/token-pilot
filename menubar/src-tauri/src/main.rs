// token-pilot 菜单栏 — Tauri Rust 壳
// 读 ~/.token-pilot/metrics-summary.json，托盘显示今日金额，点开加载本地看板

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Summary {
    today: Option<DayAgg>,
    month: Option<DayAgg>,
    budget: Option<Budget>,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DayAgg {
    tokens: Option<u64>,
    cost_usd: Option<f64>,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Budget {
    monthly_usd: Option<f64>,
    spent_usd: Option<f64>,
    percent: Option<f64>,
    overspent: Option<bool>,
}

fn summary_path() -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join(".token-pilot").join("metrics-summary.json")
}

fn read_summary() -> Summary {
    fs::read_to_string(summary_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn fmt_usd(n: f64) -> String {
    format!("${:.2}", n)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let summary = read_summary();
            let today_cost = summary.today.as_ref().and_then(|d| d.cost_usd).unwrap_or(0.0);
            let budget = summary.budget.as_ref();
            let pct = budget.and_then(|b| b.percent).unwrap_or(0.0);

            // 托盘菜单
            let title = format!("token-pilot · 今日 {}", fmt_usd(today_cost));
            let title_i = MenuItem::with_id(app, "title", &title, false, None::<&str>)?;
            let open_i = MenuItem::with_id(app, "open", "打开看板", true, None::<&str>)?;
            let budget_txt = budget
                .map(|b| {
                    format!(
                        "本月 {} / {}（{:.0}%{}）",
                        fmt_usd(b.spent_usd.unwrap_or(0.0)),
                        fmt_usd(b.monthly_usd.unwrap_or(0.0)),
                        pct,
                        if b.overspent.unwrap_or(false) { " 超支" } else { "" }
                    )
                })
                .unwrap_or_else(|| "未设预算".to_string());
            let budget_i = MenuItem::with_id(app, "budget", &budget_txt, false, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&title_i, &budget_i, &open_i, &quit_i])?;

            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip(format!("token-pilot · 今日 {}", fmt_usd(today_cost)))
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "open" => {
                        // 打开本地看板
                        let _ = open::that("http://127.0.0.1:8765");
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running token-pilot menubar");
}
