// 上游工厂：按 config.upstream 选择适配器。
import { config } from '../config.mjs';
import { createMockUpstream } from './mock.mjs';
import { createEduCoderUpstream } from './educoder.mjs';

let cached = null;

export function upstream() {
  if (cached) return cached;
  cached = config.upstream === 'educoder' ? createEduCoderUpstream() : createMockUpstream();
  return cached;
}
