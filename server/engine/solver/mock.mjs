// mock 求解器：不调用任何模型，给出确定性答案。
// 代码题的「正确」标志是写入 `// SOLVED` 注释，与 mock 上游的判定规则一致。
import { config } from '../../config.mjs';

export function createMockSolver() {
  return {
    name: 'mock',

    async solve(task) {
      const realUpstream = config.upstream === 'educoder';

      if (task.kind === 'choice') {
        const expected = Array.isArray(task.__answer) ? task.__answer : null;
        // 只有平台回吐的答案键才敢用；瞎猜会污染真实账号的作答记录
        if (expected) return { answers: expected.map(String) };
        if (realUpstream) throw unresolved('选择题需要模型或题库答案：把 SOLVER 改成 openai');
        const count = Math.max(1, task.optionCount ?? 1);
        return { answers: Array.from({ length: count }, () => 'A') };
      }

      // 接真平台时不许把占位内容写进用户的真实作业里
      if (realUpstream) throw unresolved('代码题需要配置模型：把 SOLVER 改成 openai 并填 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL');

      return {
        files: (task.files ?? []).map(file => ({
          path: file.path,
          content: fill(file.content),
        })),
      };
    },
  };
}

function unresolved(message) {
  return Object.assign(new Error(message), { code: 'model_provider_missing' });
}

function fill(content) {
  const source = String(content ?? '');
  if (source.includes('// SOLVED')) return source;
  // 把 TODO 占位换成一个能过编译的最小实现，并打上标记
  return source
    .replace(/(\s*)\/\/\s*TODO[^\n]*/g, (match, space) => `${space}// SOLVED: implemented by mock solver`)
    .replace(/\{\s*\n\s*return head;\s*\n\s*\}/, '{\n        // SOLVED: implemented by mock solver\n        return head;\n    }')
    .concat(source.includes('// SOLVED') ? '' : '\n// SOLVED\n');
}
