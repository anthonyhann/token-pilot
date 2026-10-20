// 系统通知 — macOS 用 osascript，Windows 用 PowerShell toast，零依赖

import { spawnSync } from 'node:child_process';
import os from 'node:os';

export function notify(title: string, message: string): boolean {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
      const r = spawnSync('osascript', ['-e', script], { stdio: 'ignore' });
      return r.status === 0;
    }
    if (platform === 'win32') {
      // Windows Toast via PowerShell（BurntToast 或基础通知）
      const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($t)
$x.SelectSingleNode('//text[@id="1"]').AppendChild($x.CreateTextNode(${JSON.stringify(title)})) | Out-Null
$x.SelectSingleNode('//text[@id="2"]').AppendChild($x.CreateTextNode(${JSON.stringify(message)})) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('token-pilot').Show($x)
`;
      const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
      return r.status === 0;
    }
    // linux: notify-send
    const r = spawnSync('notify-send', [title, message], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}
