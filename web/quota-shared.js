/* ───────── 订阅额度与余额：看板与面板共用的口径（唯一编辑点）─────────
 *
 * 为什么不做成 <script src> 外部文件：两个页面都要支持 file:// 直开
 * （看板内嵌落盘版、面板 Tauri 打包版），单文件自包含是硬约束，
 * 外部 JS 在落盘场景会 404。所以本文件由 scripts/sync-web-assets.js
 * 内联进 web/dashboard.html 与 web/panel.html 的 @inline 标记区，
 * 改这里之后跑 npm run sync:assets（CI 的 verify:assets 会查是否新鲜）。
 *
 * 这里只放「口径」不放排版：两个页面的排版刻意不同
 * （看板分组卡片 / 面板 480px 紧凑单行），但阈值、文案、格式化规则
 * 必须一致——历史 bug 就是改了看板忘了面板。
 */

/* 数据来源徽标文案 */
var TPQ_SOURCE_LABEL={api:'官方接口',cli:'官方 CLI',computed:'本地计算',manual:'手动登记'};
/* 现金余额低于此值（元）标红提醒 */
var TPQ_LOW_BALANCE=20;
/* 进度条阈值：>=90 危险 / >=70 预警。看板用颜色值、面板用 class 名，阈值必须同源 */
function tpqClampPct(p){return Math.max(0,Math.min(100,+p||0))}
function tpqBarColor(pct){if(pct>=90)return 'var(--warn)';if(pct>=70)return 'color-mix(in oklab,var(--warn) 55%,var(--pos))';return 'var(--pos)'}
function tpqBarClass(pct){return pct>=90?'hot':(pct>=70?'mid':'')}
/* 「还有多久重置」的人话描述 */
function tpqResetText(iso){
  if(!iso)return '';
  var t=Date.parse(iso);if(isNaN(t))return '';
  var ms=t-Date.now();
  if(ms<=0)return '即将重置';
  var mins=Math.floor(ms/60000);
  if(mins<60)return mins+' 分钟后';
  var h=Math.floor(mins/60);
  if(h<24)return h+' 小时后';
  return Math.floor(h/24)+' 天后';
}
