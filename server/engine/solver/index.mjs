// 求解层：题库优先，未命中再调模型，做对了写回题库。
//
// 关键设计：题库的键用**原始模板**算（题目描述 + 选项 + 挖空文件的初始内容），
// 而不是「被改过之后的文件」。否则每修一次文件内容就变一次键，永远命中不了。
import { createHash } from 'node:crypto';
import { config } from '../../config.mjs';
import { bank } from '../../db.mjs';
import { createMockSolver } from './mock.mjs';
import { createOpenAISolver } from './openai.mjs';

const normalize = (value) => String(value ?? '')
  .replace(/—+/g, '___')
  .replace(/\s+/g, ' ')
  .trim();

/** 题库键：题干 + 选项集合 + 文件骨架（去空白差异） */
export function subjectKey(task) {
  const files = (task.files ?? []).map(file => `${file.path}::${normalize(file.content)}`).join('|');
  const options = (task.options ?? []).map(option => `${option.key}:${normalize(option.text)}`).join('|');
  const raw = [task.kind, normalize(task.subject), normalize(task.description), options, files].join('\u0000');
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * 宽松键：只用题型 + 题干 + 描述 + 选项，**不含文件内容**。
 * 为什么需要它：同一个账号做过的题，文件里已经有我们写进去的答案，
 * 而新账号拿到的是原始空模板——带文件内容算键，两边永远对不上，跨账号就命中不了。
 */
export function looseKey(task) {
  const options = (task.options ?? []).map(option => `${option.key}:${normalize(option.text)}`).join('|');
  // 客观题的选项在 questions 里（task.options 是空的），必须把题干和选项都算进指纹，
  // 否则不同课程里同名的「XX客观题测试（三）」会撞键——曾经因此把 4 选 1 的答案用到了判断题上。
  const questions = (task.questions ?? [])
    .map(question => [String(question.position ?? ''), normalize(question.subject), (question.options ?? []).map(option => option.key + ':' + normalize(option.text)).join(',')].join('|'))
    .join('||');
  const raw = [task.kind, normalize(task.subject), normalize(task.description), options, questions].join('\u0000');
  return createHash('sha256').update(raw).digest('hex');
}

export const keyVariants = (task) => [subjectKey(task), looseKey(task)];

/** 查题库：先用严格键（含文件），再退到宽松键（跨账号用） */
export function lookupAnswer(key) {
  const hit = bank.lookup(key);
  if (!hit) return null;
  return { key, answer: hit.answer, subject: hit.subject, savedAt: hit.updated_at };
}

/** 双键查库：严格键优先，其次宽松键 */
export function lookupTask(task) {
  for (const key of keyVariants(task)) {
    const hit = lookupAnswer(key);
    if (hit) return hit;
  }
  return null;
}

let cached = null;

export function solver() {
  if (cached) return cached;
  cached = config.solver.provider === 'openai' ? createOpenAISolver() : createMockSolver();
  return cached;
}

// ---------- 答案整形 ----------
// 模型（尤其是中转/小模型）经常不老实按 {"files":[...]} 返回：把整个文件塞进 content、
// 用 {路径: 内容} 的 map、或者干脆返回一段代码字符串。这里统一收口，别让格式差异把整关打成 INVALID_CANDIDATE。
function coerceFiles(task, answer) {
  const paths = (task.files ?? []).map(file => file.path);
  const asFile = (path, content) => ({ path: path || paths[0] || 'answer.txt', content: String(content ?? '') });
  const pickPath = (item) => item?.path ?? item?.filePath ?? item?.file_path ?? item?.filename ?? item?.name;

  if (Array.isArray(answer?.files)) {
    return answer.files
      .map((item) => {
        if (typeof item === 'string') return asFile(paths[0], item);
        if (!item || typeof item !== 'object') return null;
        const content = item.content ?? item.code ?? item.file_content ?? item.source ?? item.text;
        if (content === undefined) return null;
        return asFile(pickPath(item), content);
      })
      .filter(Boolean);
  }
  if (answer?.files && typeof answer.files === 'object') {
    return Object.entries(answer.files).map(([path, content]) => asFile(path, typeof content === 'object' ? content?.content : content));
  }
  for (const key of ['content', 'code', 'file_content', 'source', 'solution', 'answer', 'result']) {
    if (typeof answer?.[key] === 'string' && answer[key].trim()) return [asFile(paths[0], answer[key])];
  }
  if (Array.isArray(answer)) {
    const mapped = answer
      .map(item => (typeof item === 'string' ? asFile(paths[0], item) : (item && typeof item === 'object' ? asFile(pickPath(item), item.content ?? item.code) : null)))
      .filter(Boolean);
    if (mapped.length) return mapped;
  }
  return null;
}

function coerceAnswers(answer) {
  const list = answer?.answers ?? answer?.answer ?? answer?.selected ?? answer?.choices ?? answer?.result;
  const clean = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (Array.isArray(list)) return list.map(clean).filter(Boolean);
  if (typeof list === 'string') {
    const parts = list.split(/[^A-Za-z]+/).map(clean).filter(Boolean);
    if (parts.length) return parts;
  }
  return null;
}

function shapeAnswer(task, answer) {
  if (!answer || typeof answer !== 'object') return answer;
  if (task.kind === 'code') {
    const files = coerceFiles(task, answer);
    if (files?.length) return { ...answer, files };
    // 面型像命令、实际要写进脚本文件的关卡（头歌大量「命令行操作」关就是给一个 .sh/hint.txt 让你填）：
    // 模型往往按终端题返回 {"commands":[...]}，这里把命令拼成脚本内容写进唯一的文件。
    const commands = Array.isArray(answer.commands)
      ? answer.commands
      : (typeof answer.commands === 'string' ? answer.commands.split('\n') : null);
    if (commands?.length && (task.files ?? []).length === 1) {
      const target = task.files[0];
      const looksScript = /\.(sh|bash)$/i.test(target.path) || /^#!.*\b(ba)?sh\b/.test(String(target.content ?? '').trim());
      if (looksScript) {
        return { ...answer, files: [{ path: target.path, content: `${commands.join('\n')}\n` }] };
      }
    }
    return answer;
  }
  if (task.kind === 'choice') {
    const answers = coerceAnswers(answer);
    return answers?.length ? { ...answer, answers } : answer;
  }
  if (task.kind === 'terminal' && !Array.isArray(answer.commands)) {
    const raw = answer.commands ?? answer.command ?? answer.steps ?? answer.answer;
    const commands = Array.isArray(raw) ? raw.map(String) : (typeof raw === 'string' ? raw.split('\n').filter(Boolean) : null);
    return commands?.length ? { ...answer, commands } : answer;
  }
  return answer;
}

const isValidAnswer = (task, answer) => Boolean(answer) && (
  (task.kind === 'choice' && Array.isArray(answer.answers) && answer.answers.length > 0)
  || (task.kind === 'code' && Array.isArray(answer.files) && answer.files.length > 0)
  || (task.kind === 'terminal' && Array.isArray(answer.commands) && answer.commands.length > 0)
);

/** 只走模型，不碰题库 */
export async function solveWithModel(task) {
  const engine = solver();
  let answer = shapeAnswer(task, await engine.solve(task));
  // 格式不对就再要一次，明确告诉它缺什么键——比直接判失败划算得多
  if (!isValidAnswer(task, answer)) {
    const need = task.kind === 'code' ? '{"files":[{"path":"原路径","content":"完整文件内容"}]}'
      : task.kind === 'choice' ? '{"answers":["A","B"]}'
        : '{"commands":["命令1","命令2"]}';
    const retry = await engine.solve({
      ...task,
      feedback: `${task.feedback ? task.feedback + '\n' : ''}上一次返回不符合要求。只输出一个 JSON 对象，形如 ${need}，不要任何其他文字。`,
    });
    answer = shapeAnswer(task, retry);
  }
  if (!isValidAnswer(task, answer)) {
    throw Object.assign(new Error('生成的答案未满足提交要求'), { code: 'INVALID_CANDIDATE' });
  }
  return { answer, from: engine.name };
}

/** 先题库、后模型（脚本用；流水线里是分开调的，便于记账） */
export async function solve(task, { jobId } = {}) {
  const key = subjectKey(task);
  const hit = lookupAnswer(key);
  if (hit) return { from: 'bank', answer: hit.answer, key, jobId };
  const { answer, from } = await solveWithModel(task);
  return { from, answer, key, jobId };
}

/** 把「已通过评测」的答案写进题库：严格键 + 宽松键各存一份，跨账号才能命中 */
export function remember(key, task, answer, jobId) {
  const subject = String(task.subject ?? '').slice(0, 500);
  for (const variant of new Set([key, subjectKey(task), looseKey(task)])) {
    bank.save({ subjectKey: variant, subject, kind: task.kind, answer, sourceJob: jobId });
  }
  return key;
}

// ---------- 逐题题库：一道题一个键，跨关卡/跨作业复用 ----------
/** 单题的指纹：题干 + 选项。题目一样就算同一题，不管它在哪个关卡里 */
export function questionKey(question) {
  const options = (question.options ?? []).map(option => `${option.key}:${normalize(option.text)}`).join('|');
  return createHash('sha256').update(['question', normalize(question.subject), options].join('\u0000')).digest('hex');
}

export function lookupQuestion(question) {
  const hit = bank.lookup(questionKey(question));
  if (!hit) return null;
  const value = hit.answer?.value ?? hit.answer;
  return typeof value === 'string' ? value : null;
}

export function rememberQuestion(question, value, jobId) {
  if (!value) return;
  bank.save({
    subjectKey: questionKey(question),
    subject: String(question.subject ?? '').slice(0, 300),
    kind: 'question',
    answer: { value: String(value) },
    sourceJob: jobId ?? 'question',
  });
}
