// 凭证解析：三层优先级，确保「不装 CC Switch 也能用」
//
//   ① from-config  —— 用户在 token-pilot 设置里填的 key。永远可用。
//   ② from-native  —— 各平台自己的凭证文件（OpenCode auth.json、Kimi credentials、
//                     arkcli profile...）。装了该平台工具就有。
//   ③ from-ccswitch —— CC Switch 数据库。装了才有，只作为「省去手填」的便利。
//
// 关键约束：任何额度 provider 都必须能在只有 ① 的情况下工作。
// ③ 是锦上添花，绝不是必需品——这是产品决策，不是技术妥协。

import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';

const execFileP = promisify(execFile);

export type CredentialOrigin = 'config' | 'native' | 'ccswitch';

export interface ResolvedKey {
  key: string;
  origin: CredentialOrigin;
  /** 人话说明来源，UI/doctor 要展示 */
  detail: string;
}

/** 从 token-pilot 自己的配置读（优先级最高，用户显式填的） */
export function fromConfig(providerId: string): ResolvedKey | null {
  const cfg = loadConfig() as { quotaKeys?: Record<string, string> };
  const key = cfg.quotaKeys?.[providerId];
  if (!key || !key.trim()) return null;
  return { key: key.trim(), origin: 'config', detail: '来自 token-pilot 设置' };
}

/** 各平台的原生凭证位置（不依赖 CC Switch） */
const NATIVE_PATHS: Record<string, { file: string; pick: (d: unknown) => string | null }[]> = {
  deepseek: [
    {
      file: '~/.config/token-pilot/keys.json',
      pick: (d) => (d as Record<string, string>)?.deepseek ?? null,
    },
  ],
  moonshot: [
    {
      file: '~/.config/token-pilot/keys.json',
      pick: (d) => (d as Record<string, string>)?.moonshot ?? null,
    },
  ],
};

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function fromNative(providerId: string): ResolvedKey | null {
  const specs = NATIVE_PATHS[providerId];
  if (!specs) return null;
  for (const spec of specs) {
    const p = expandHome(spec.file);
    if (!existsSync(p)) continue;
    try {
      const key = spec.pick(JSON.parse(readFileSync(p, 'utf8')));
      if (key && key.trim()) {
        return { key: key.trim(), origin: 'native', detail: `来自 ${spec.file}` };
      }
    } catch {
      /* 单个来源解析失败不影响其它来源 */
    }
  }
  return null;
}

/**
 * 从 CC Switch 数据库读（可选增强）。
 *
 * 表结构：providers(id, name, app_type, settings_config)
 * settings_config 是 JSON，env 字段里存 ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY 等。
 *
 * 只读模式打开，绝不写入。用 CLI 读而不是引入 sqlite 依赖——
 * 我们的原则是零运行时依赖。
 */
export async function fromCcSwitch(providerNamePattern: string): Promise<ResolvedKey | null> {
  const dbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  if (!existsSync(dbPath)) return null;

  try {
    // 用 python3 的 sqlite3（macOS/Linux 自带），避免引入 npm 依赖
    const script = `
import sqlite3, json, sys, re
con = sqlite3.connect('file:${dbPath}?mode=ro', uri=True)
cur = con.cursor()
cur.execute("SELECT name, settings_config FROM providers")
pat = re.compile(sys.argv[1], re.I)
for name, cfg in cur.fetchall():
    if not pat.search(name or ''):
        continue
    try:
        d = json.loads(cfg) if isinstance(cfg, str) else cfg
    except Exception:
        continue
    env = (d or {}).get('env') or {}
    for k, v in env.items():
        ku = k.upper()
        if ('KEY' in ku or 'TOKEN' in ku) and isinstance(v, str) and v.strip():
            print(json.dumps({'name': name, 'envKey': k, 'value': v.strip()}))
            sys.exit(0)
print('')
`;
    const { stdout } = await execFileP('python3', ['-c', script, providerNamePattern], {
      timeout: 8000,
    });
    const line = stdout.trim();
    if (!line || line === '""') return null;
    const parsed = JSON.parse(line) as { name: string; envKey: string; value: string };
    return {
      key: parsed.value,
      origin: 'ccswitch',
      detail: `来自 CC Switch 的「${parsed.name}」配置`,
    };
  } catch {
    return null;
  }
}

/**
 * 三层依次尝试。全部失败返回 null，调用方负责给出「去哪里填」的提示。
 */
export async function resolveKey(
  providerId: string,
  ccSwitchPattern?: string,
): Promise<ResolvedKey | null> {
  return (
    fromConfig(providerId) ??
    fromNative(providerId) ??
    (ccSwitchPattern ? await fromCcSwitch(ccSwitchPattern) : null)
  );
}

/** 读取火山 profile 列表（判断有没有订阅，不需要 arkcli 登录态之外的权限） */
export async function volcProfiles(): Promise<{ defaultProfile?: string; names: string[] } | null> {
  try {
    const { stdout } = await execFileP('arkcli', ['profile', 'list', '--format', 'json'], {
      timeout: 15_000,
    });
    const d = JSON.parse(stdout) as {
      default_profile?: string;
      profiles?: { name: string; type?: string }[];
    };
    return {
      defaultProfile: d.default_profile,
      names: (d.profiles ?? []).map((p) => p.name),
    };
  } catch {
    return null;
  }
}
