// OpenAI 兼容求解器（OpenAI / DeepSeek / vLLM / Ollama 都能用，只要走 /chat/completions）。
import { config } from '../../config.mjs';
import { postJsonViaProxy } from './proxy.mjs';

const SYSTEM = `你是高校课程作业的解题器。给你一道题目（选择题或代码题），你要输出可以直接提交的答案。
只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字。

选择题：{"reasons": ["每题一句理由"], "answers": ["B","C"]}  —— answers 严格按题目给出的位置顺序，每个元素是该空/该题的原始选项字母；reasons 用于先推理再作答。
代码题：{"files": [{"path": "原路径", "content": "完整文件内容"}]}  —— 必须返回完整文件，不要省略号，不要 diff。
终端题：{"commands": ["命令1", "命令2"]}  —— 你没法交互式操作，所有步骤都要写成非交互命令（例如用 vi -c wq 文件 保存退出，用 <<EOF 或 -c 传参），按顺序执行，每条一行。

规则：
1. 如果给了判分测试集，期望输出是唯一标准；实际输出与期望输出逐字不一致就是没通过，按差异改。
2. 测试集里给出的「正确退出码: X」是判分程序的断言，**不是让你把 X 写死进代码**。它说明子进程由测试程序自己创建、由你只负责等待回收：不要自己 fork，只写 wait/waitpid + WIFEXITED + WEXITSTATUS 这类回收逻辑，让返回值等于实际子进程的退出码。
3. 如果题目描述里出现了具体的命令示例（例如「可以使用如下命令：du -a」），那就是判分依据，按示例写，不要自创参数组合或改写路径写法。
4. 如果题目里出现连续的长破折号（U+2014）组成的空位，那是平台挖的空，必须替换成合法代码。
5. 如果给了上一轮的评测反馈，说明上一版没通过，必须针对反馈改，不要原样重发。
6. 代码题的输出必须完全匹配，包括换行、空格、大小写，不要多打印任何提示语。
7. 只补题目挖空的部分（BEGIN/END 之间），不要重写函数签名、不要增删函数外的代码、不要加 main。`;

function firstJSON(text) {
  const trimmed = String(text ?? '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw Object.assign(new Error('模型返回内容格式不正确'), { code: 'MODEL_RESPONSE_INVALID' });
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw Object.assign(new Error('模型返回内容格式不正确'), { code: 'MODEL_RESPONSE_INVALID' });
  }
}

// 题干太长会把生成拖到 60 秒以上，中转站的网关直接 504。
// 保留开头（题目背景）+ 结尾（编程要求/测试说明），中间省略——实测同一道题从 90 秒降到 18 秒。
function trimDescription(text, budget = 2600) {
  const raw = String(text ?? '');
  if (raw.length <= budget) return raw;
  const head = Math.floor(budget * 0.2);
  const tail = budget - head;
  return `${raw.slice(0, head)}\n……（中间省略 ${raw.length - budget} 字）……\n${raw.slice(-tail)}`;
}

function prompt(task) {
  const parts = [`题型：${task.kind === 'choice' ? '选择题' : '代码题'}`, `题目：${task.subject ?? ''}`, '', trimDescription(task.description)];
  if (task.options?.length) {
    parts.push('', '选项：');
    for (const option of task.options) parts.push(`${option.key}. ${option.text}`);
  }
  // 客观题：description 只有一句「完成 N 道选择题」，真正的题干和选项在 questions 里
  if (task.questions?.length) {
    parts.push('', `本关共 ${task.questions.length} 道题，按 position 顺序作答：`);
    for (const question of task.questions) {
      const stem = String(question.subject ?? '').replace(/!\[[^\]]*\]\([^)]*\)/g, '（题中包含一张图片）');
      parts.push('', `第 ${question.position} 题：${stem}`);
      for (const option of question.options ?? []) parts.push(`  ${option.key}. ${option.text}`);
    }
    const letters = [...new Set(task.questions.flatMap(question => (question.options ?? []).map(option => option.key)))].sort().join('/');
    parts.push('', '作答要求（很重要）：');
    parts.push('1) 先逐题判断，在 reasons 里写一句不超过 30 字的理由，必须点明是哪个选项的关键词让你做出这个选择；');
    parts.push(`2) 再在 answers 里给最终答案，数组长度必须等于 ${task.questions.length}，按 position 顺序，一项对应一题；`);
    parts.push(`3) 每一项只能是本关存在的选项字母（本关只有 ${letters}），绝不能出现之外的字母；`);
    parts.push('4) 题干若问「哪几个 / 包括哪些 / 正确的是」，说明可能有多项正确：把**真正正确的那些**选项都写上（可能是 2 个、3 个，也可能只有 1 个），答案长度由题目内容决定，**绝不能因为是多选题就把 ABCD 全选上**；');
    parts.push('5) 只输出 JSON：{"reasons": ["...", "..."], "answers": ["...", "..."]}，答案要严格落在本关给定的选项里。');
  }
  if (task.files?.length) {
    for (const file of task.files) {
      parts.push('', `文件 ${file.path}：`, '```', String(file.content ?? ''), '```');
    }
  }
  // 平台的测试集就是判分标准：期望输出是唯一真相，最终代码必须让它逐字匹配
  // 但超长输出会拖慢生成（实测同一道题 300 秒 → 60 秒），这里只保留头尾各 300 字
  const clip = (value, budget = 600) => {
    const text = JSON.stringify(value ?? '');
    if (text.length <= budget) return text;
    return `${text.slice(0, budget / 2)}……（中间省略 ${text.length - budget} 字）……${text.slice(-budget / 2)}`;
  };
  if (task.testSets?.length) {
    parts.push('', '判分测试集（必须让「实际输出」等于「期望输出」，逐字匹配）：');
    for (const [index, test] of task.testSets.entries()) {
      parts.push(`  用例 ${index + 1}：`);
      if (test.input) parts.push(`    输入：${clip(test.input)}`);
      parts.push(`    期望输出：${JSON.stringify(test.output ?? '')}`);
      if (test.actual_output !== undefined && test.actual_output !== null) {
        parts.push(`    上一版实际输出：${clip(test.actual_output)}`);
      }
      if (test.result === true) parts.push('    （这条已通过）');
    }
  }
  if (task.feedback) parts.push('', '上一轮评测反馈：', String(task.feedback));
  return parts.join('\n');
}

export function createOpenAISolver() {
  return {
    name: 'openai',

    async solve(task, strictJSON = config.solver.strictJson) {
      if (!config.solver.apiKey) {
        throw Object.assign(new Error('考试模型尚未配置'), { code: 'MODEL_PROVIDER_MISSING' });
      }
      const endpoint = `${config.solver.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const requestBody = JSON.stringify({
        model: config.solver.model,
        temperature: config.solver.temperature,
        // 大多数端点支持强制 JSON；不支持的会在下面自动降级重试
        ...(strictJSON ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt(task) },
        ],
      });
      // 配了代理就走代理：本机系统代理只对 .NET/浏览器生效，Node 的 fetch 不走代理会直接被对端 reset
      const sendRequest = async () => {
        if (config.solver.proxy) {
          const result = await postJsonViaProxy(config.solver.proxy, endpoint, {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.solver.apiKey}`,
              Accept: 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36',
            },
            body: requestBody,
            timeoutMs: config.solver.timeoutMs,
          });
          return {
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            text: async () => result.text,
            json: async () => JSON.parse(result.text),
          };
        }
        return fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.solver.apiKey}`,
          },
          body: requestBody,
          signal: AbortSignal.timeout(config.solver.timeoutMs),
        });
      };

      // 网络抖动（fetch failed / ECONNRESET）很常见，重试 3 次、间隔递增
      let response = null;
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          response = await sendRequest();
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
      if (!response) {
        throw Object.assign(new Error(`模型服务连接失败：${lastError?.message ?? '未知错误'}`), { code: 'MODEL_NETWORK_ERROR' });
      }

      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error('API Key 无效或没有权限（检查 OPENAI_API_KEY）'), { code: 'MODEL_UNAUTHORIZED' });
      }
      if (response.status === 404) {
        throw Object.assign(new Error(`接口不存在（检查 OPENAI_BASE_URL 是否要带 /v1，以及模型名 ${config.solver.model}）`), { code: 'MODEL_ENDPOINT_NOT_FOUND' });
      }
      if (response.status === 429) throw Object.assign(new Error('模型请求受到频率限制'), { code: 'MODEL_RATE_LIMITED' });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        // 有的端点不认识 response_format，去掉再试一次
        if (strictJSON && /response_format|json_object|unsupported|invalid.*parameter/i.test(detail)) {
          return this.solve(task, false);
        }
        // 网关超时也走非严格重试：实测带 response_format 的长请求会被中转站打成 504，去掉就正常
        if (strictJSON && response.status >= 500) {
          return this.solve(task, false);
        }
        // 网关 5xx（中转站常见 504）与 response_format 无关，也要重试一次，否则一遇到超时就整关失败
        if (response.status >= 500 && !this.__retried) {
          this.__retried = true;
          await new Promise(resolve => setTimeout(resolve, 2000));
          try {
            return await this.solve(task, strictJSON);
          } finally {
            this.__retried = false;
          }
        }
        throw Object.assign(new Error(`模型服务调用失败：HTTP ${response.status} ${detail.slice(0, 200)}`), { code: 'MODEL_ERROR' });
      }
      const payload = await response.json();
      const choice = payload?.choices?.[0];
      if (choice?.finish_reason === 'length') {
        throw Object.assign(new Error('模型返回内容被截断'), { code: 'MODEL_OUTPUT_TRUNCATED' });
      }
      return firstJSON(choice?.message?.content);
    },
  };
}
