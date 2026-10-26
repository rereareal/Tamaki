export interface ProactiveConfig {
  enabled: boolean;
  chance: number;
  idleMs: number;
  cooldownMs: number;
  maxPerHour: number;
  minTextLength: number;
  groups: number[];
}

interface State {
  lastBotAt: number;
  lastProactiveAt: number;
  windowStart: number;
  count: number;
}

/**
 * P1：空闲概率触发。
 * 只有当前角色在群里已经 idleMs 没说话、冷却已过、每小时次数未超限，
 * 且随机数命中时，才允许对一条普通群消息插话。
 */
export class ProactiveGate {
  private readonly groups: Set<number>;
  private readonly chance: number;
  private readonly maxPerHour: number;
  private readonly state = new Map<number, State>();

  constructor(
    private readonly cfg: ProactiveConfig,
    private readonly random: () => number = Math.random,
  ) {
    this.groups = new Set(cfg.groups);
    this.chance = Math.max(0, Math.min(1, cfg.chance));
    this.maxPerHour = Math.max(0, Math.floor(cfg.maxPerHour));
  }

  get enabled(): boolean {
    return this.cfg.enabled && this.groups.size > 0;
  }

  shouldInterject(groupId: number | undefined, textLength: number, now = Date.now()): boolean {
    if (!this.cfg.enabled || groupId === undefined || !this.groups.has(groupId)) return false;
    if (textLength < this.cfg.minTextLength) return false;

    let state = this.state.get(groupId);
    if (!state) {
      // 第一次看到这个群时，从当前时刻开始计算空闲时间。
      state = { lastBotAt: now, lastProactiveAt: 0, windowStart: now, count: 0 };
      this.state.set(groupId, state);
    }

    if (now - state.lastBotAt < this.cfg.idleMs) return false;
    if (now - state.lastProactiveAt < this.cfg.cooldownMs) return false;

    if (now - state.windowStart >= 3_600_000) {
      state.windowStart = now;
      state.count = 0;
    }
    if (state.count >= this.maxPerHour) return false;
    if (this.random() >= this.chance) return false;

    state.lastProactiveAt = now;
    state.count++;
    return true;
  }

  /** bot 在任何情况下（直接回复或主动插话）发言后，重置该群的空闲计时。 */
  noteBotMessage(groupId: number | undefined, now = Date.now()): void {
    if (groupId === undefined) return;
    const state = this.state.get(groupId);
    if (state) state.lastBotAt = now;
    else this.state.set(groupId, { lastBotAt: now, lastProactiveAt: 0, windowStart: now, count: 0 });
  }
}
