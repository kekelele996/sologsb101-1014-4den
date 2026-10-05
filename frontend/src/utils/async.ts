/**
 * 异步重试工具
 * 林业站备案侧独立保存，写失败时只重试备案侧本身，不回滚、不牵连项目部侧数据。
 */

export interface RetryOptions {
  /** 最大尝试次数（含首次） */
  retries?: number;
  /** 首次重试前的基础等待（毫秒），后续按倍数退避 */
  baseDelayMs?: number;
  /** 重试前的回调（用于上报保存状态） */
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * 执行一个异步操作，失败时按指数退避重试。
 * 只重试传入的操作本身，不涉及其他副作用。
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 3, baseDelayMs = 300, onRetry } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        onRetry?.(attempt, error);
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
      }
    }
  }
  throw lastError;
}
