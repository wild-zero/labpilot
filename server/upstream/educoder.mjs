// 真实头歌（EduCoder）上游适配器。
//
// 平台接口契约来自对线上平台的实测整理（data.educoder.net/api）：
//   X-EDU-Type: pc
//   X-EDU-Timestamp: <epoch ms>
//   X-EDU-Signature: md5(base64(`method=<METHOD大写>&ak=<AK>&sk=<SK>&time=<ts>`))
//   Pc-Authorization: <_educoder_session cookie 值>
//   Cookie: autologin_trustie=<v>; _educoder_session=<v>
//
// AK / SK 是平台 web bundle 里的公开客户端常量（模块 527951，双 base64 编码），
// 已解码后内置在 config.educoder 中；平台换版本时用
//   node scripts/extract-aksk.mjs
// 重新提取。已实测：用这套常量打 /accounts/login.json 返回 status:-3（账号密码错），
// 说明签名被接受。
//
// 关键字段陷阱（已在实现里处理）：
//   1. challenge.task_pass 是题干，不是状态。
//   2. game.status === 2 才算完成；finished_challenge_count 会滞后。
//   3. entry_game_id 返回「上次访问」的关卡，必须先 prev_game 回卷。
//   4. next_game 在上一关通过前为 null，无法跳跃。
//   5. test_sets[].result 在评测进行中为 null。
//   6. 代码保存后要单独触发 game_build，一次 save 不等于一次评测。
import { createHash } from 'node:crypto';
import { config } from '../config.mjs';
import { errors } from '../http.mjs';

const md5hex = (buffer) => createHash('md5').update(buffer).digest('hex');

// 平台读文件回的是 base64（rep_content.content.content），写文件也吃 base64。
// 但个别题型会直接给明文，所以先探测再决定。
function decodeFileContent(value) {
  if (typeof value !== 'string' || !value) return { content: '', encoding: 'plain' };
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(value) && value.length % 4 === 0) {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    // 替换字符说明不是 base64，退回明文
    if (!decoded.includes('\uFFFD')) return { content: decoded, encoding: 'base64' };
  }
  return { content: value, encoding: 'plain' };
}

function encodeFileContent(content, encoding) {
  return encoding === 'base64' ? Buffer.from(String(content ?? ''), 'utf8').toString('base64') : String(content ?? '');
}

function signature(method, ts) {
  const { ak, sk } = config.educoder;
  // 线上实现：btoa(`method=${METHOD.toUpperCase()}&ak=..&sk=..&time=${ts}`) 再取 md5 十六进制
  const raw = `method=${String(method).toUpperCase()}&ak=${ak}&sk=${sk}&time=${ts}`;
  const encoded = Buffer.from(raw, 'utf8').toString('base64');
  return md5hex(encoded);
}

class RealEduClient {
  constructor() {
    this.base = config.educoder.base.replace(/\/$/, '');
    this.web = config.educoder.web.replace(/\/$/, '');
  }

  headers({ method, session, extra = {} }) {
    const ts = Date.now();
    const cookie = session?.cookie;
    const headers = {
      Accept: 'application/json',
      'X-EDU-Type': 'pc',
      'X-EDU-Timestamp': String(ts),
      'X-EDU-Signature': signature(method, ts),
      ...extra,
    };
    if (session?.cookie) headers['Pc-Authorization'] = cookie;
    if (session?.cookie) headers.Cookie = `autologin_trustie=${session.trustie ?? ''}; _educoder_session=${cookie}`;
    return headers;
  }

  async request(path, { method = 'GET', body, session, raw = false, headers = {} } = {}) {
    if (!config.educoder.ak || !config.educoder.sk) {
      throw errors.upstream('缺少 EDUCODER_AK / EDUCODER_SK，请先运行 scripts/extract-aksk.mjs。', 'UPSTREAM_NOT_CONFIGURED');
    }
    const url = `${this.base}${path}`;
    const init = {
      method,
      headers: this.headers({
        method,
        session,
        extra: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      }),
      signal: AbortSignal.timeout(config.educoder.timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let lastError = null;
    for (let attempt = 0; attempt <= config.educoder.maxRetries; attempt += 1) {
      try {
        const response = await fetch(url, init);
        if (response.status === 401) throw errors.upstreamAuth();
        if (response.status === 429) {
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          lastError = errors.upstream('头歌接口限流，请稍后重试。', 'RATE_LIMITED');
          continue;
        }
        if (!response.ok) {
          // 平台把业务错误也放在 body 里，404 往往是「文件/关卡不存在」，把原话带出来
          const detail = await response.text().catch(() => '');
          let message = `头歌接口返回 HTTP ${response.status}。`;
          try {
            const body = JSON.parse(detail);
            if (body?.message) message = `${message} ${body.message}`;
          } catch { /* 非 JSON 就用默认文案 */ }
          throw errors.upstream(`${message} [${method} ${path}]`, 'UPSTREAM_HTTP_ERROR');
        }
        if (raw) return response;
        const text = await response.text();
        let payload;
        try { payload = JSON.parse(text); } catch { throw errors.upstream('头歌返回了非 JSON 响应。'); }
        if (payload && typeof payload.status === 'number') {
          // 平台把业务错误也塞进 HTTP 200 的 body 里（-3 登录错、403 无权限…），必须当错误处理，
          // 否则会把 {"status":403,...} 当成正常数据，读出一堆空字段
          if (payload.status < 0 || payload.status >= 400) {
            const error = this.errorOf(payload.status, payload.message);
            error.message = `${error.message} [${method} ${path}]`;
            throw error;
          }
        }
        return payload?.data ?? payload;
      } catch (error) {
        if (error?.code === 'UPSTREAM_AUTH_EXPIRED' || error?.code === 'RATE_LIMITED') throw error;
        lastError = error;
        if (attempt === config.educoder.maxRetries) break;
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastError ?? errors.upstream();
  }

  errorOf(status, upstreamMessage) {
    switch (status) {
      case -102: return errors.upstream('头歌签名被拒绝（AK/SK 或时钟偏移）。', 'UPSTREAM_SIGNATURE_REJECTED');
      case -3: return errors.auth();
      case -4: return errors.upstream('头歌账号需要先绑定手机号或邮箱。', 'UPSTREAM_ACCOUNT_UNBOUND');
      // -2：上一次评测还在跑，平台拒绝重复提交。这不是失败，等结果就行
      case -2: return errors.upstream(upstreamMessage || '评测任务运行中，请勿重复提交。', 'UPSTREAM_EVAL_RUNNING');
      case 401: return errors.upstreamAuth(upstreamMessage || '头歌登录状态已失效，请重新登录。');
      case 403: return errors.upstream(`头歌拒绝访问：${upstreamMessage || '没有权限'}`, 'UPSTREAM_FORBIDDEN');
      case 404: return errors.upstream(`头歌返回不存在：${upstreamMessage || '资源已删除'}`, 'UPSTREAM_NOT_FOUND');
      default: return errors.upstream(`头歌接口返回错误码 ${status}${upstreamMessage ? '：' + upstreamMessage : ''}。`);
    }
  }
}

export function createEduCoderUpstream() {
  const client = new RealEduClient();

  // 会话可以是字符串（旧的单 cookie）或 { cookie, trustie, zzud, uid }
  const session = (value) => {
    if (!value) return { cookie: '', trustie: '', zzud: '', uid: '' };
    if (typeof value === 'string') return { cookie: value, trustie: '', zzud: '', uid: '' };
    return { cookie: value.cookie ?? '', trustie: value.trustie ?? '', zzud: value.zzud ?? '', uid: value.uid ?? '' };
  };

  // 平台用多条 Set-Cookie 下发会话；Node 20+ 有 getSetCookie，老实现要自己拆
  const readCookies = (response) => {
    const lines = response.headers.getSetCookie?.() ?? [];
    if (lines.length) return lines;
    const raw = response.headers.get('set-cookie');
    if (!raw) return [];
    // 粗拆：按 ", " 分段再过滤出含 "=" 的片段，够处理本平台的会话 cookie
    return raw.split(/,(?=\s*[A-Za-z0-9_\-]+=)/g);
  };

  return {
    name: 'educoder',

    async login(login, password) {
      // 登录请求例外：不需要会话，但要 Origin / Referer
      const ts = Date.now();
      const body = { login, password, autologin: true, tl: null, source: null };
      const response = await fetch(`${client.base}/accounts/login.json`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-EDU-Type': 'pc',
          'X-EDU-Timestamp': String(ts),
          'X-EDU-Signature': signature('POST', ts),
          'Pc-Authorization': 'null',
          Origin: client.web,
          Referer: `${client.web}/login`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.educoder.timeoutMs),
      }).catch(() => { throw errors.upstream('无法连接头歌接口。'); });

      if (response.status === 429) throw errors.rateLimited();
      const payload = await response.json().catch(() => ({}));
      if (typeof payload.status === 'number' && payload.status < 0) throw client.errorOf(payload.status);

      const jar = readCookies(response);
      const pick = (name) => {
        for (const line of jar) {
          const [pair] = line.split(';');
          const eq = pair.indexOf('=');
          if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
        }
        return '';
      };
      const cookie = pick('_educoder_session');
      if (!cookie) throw errors.auth('头歌未返回会话，账号或密码可能不正确。');

      const data = payload?.data ?? payload;
      const user = data?.user ?? data?.account ?? data ?? {};
      const zzud = String(
        data?.zzud ?? user.zzud ?? pick('zzud') ?? '',
      );
      return {
        cookie,
        trustie: pick('autologin_trustie'),
        zzud,
        uid: String(user.id ?? user.user_id ?? ''),
        user: {
          id: String(user.id ?? user.user_id ?? ''),
          name: String(user.name ?? user.login ?? user.username ?? login),
          avatarUrl: '',
        },
      };
    },

    async courses(cookie, _login) {
      const s = session(cookie);
      let zzud = s.zzud;
      if (!zzud) {
        // 平台会话里带 zzud 的兜底来源；失败不致命
        for (const path of ['/users/current_user.json', '/accounts/current_user.json', '/users/me.json']) {
          const me = await client.request(path, { session: s }).catch(() => null);
          if (!me) continue;
          zzud = String(me.zzud ?? me.user?.zzud ?? me.data?.zzud ?? '');
          if (zzud) break;
        }
      }
      const payload = await client.request(
        `/courses.json?page=1&limit=100&order=mine&search=&zzud=${encodeURIComponent(zzud ?? '')}`,
        { session: s },
      );
      const rows = Array.isArray(payload) ? payload : payload?.courses ?? payload?.items ?? [];
      return rows.map(item => ({
        identifier: String(item.identifier ?? item.course_identifier ?? item.id ?? ''),
        name: String(item.name ?? item.course_name ?? '未命名课堂'),
        homeworkCount: Number(item.tasks_count ?? item.homework_commons_count ?? item.homework_count ?? 0) || undefined,
        membersCount: Number(item.course_members_count ?? item.members_count ?? 0) || undefined,
        ended: Boolean(item.is_end ?? item.ended),
      })).filter(course => course.identifier);
    },

    async homeworks(cookie, login, courseIdentifier) {
      const s = session(cookie);
      // 两套路由：老课走 list.json（字段更全）；「课堂实验」类课程（例如分布式计算）
      // 只有 homework_commons.json?id=&type= 这条能用，且 type 取值因课而异（实测 type=1 才返回列表）
      const legacy = await client.request(
        `/courses/${encodeURIComponent(courseIdentifier)}/homework_commons/list.json?limit=200&zzud=`,
        { session: s },
      ).catch(() => null);
      let payload = legacy;
      let rows = payload?.homeworks ?? payload?.homework_commons ?? payload?.items ?? [];
      if (!rows.length) {
        for (const type of [1, 4, 0]) {
          const fallback = await client.request(
            `/courses/${encodeURIComponent(courseIdentifier)}/homework_commons.json?limit=200&status=0&id=${encodeURIComponent(courseIdentifier)}&type=${type}&order=0&zzud=`,
            { session: s },
          ).catch(() => null);
          const list = fallback?.homeworks ?? fallback?.homework_commons ?? fallback?.items ?? [];
          if (list.length) { payload = fallback; rows = list; break; }
        }
      }
      return rows.map((item) => {
        const challengeCount = Number(item.challenge_count ?? item.all_count ?? 0) || undefined;
        const finished = Number(item.finished_challenge_count ?? item.compelete_count ?? 0);
        const statuses = Array.isArray(item.status) ? item.status.map(String) : [String(item.status ?? '')].filter(Boolean);
        const expired = Number(item.time_status ?? 0) >= 5 || statuses.some(text => text.includes('已截止'));
        return {
          id: Number(item.homework_id ?? item.id ?? item.homework_common_id ?? 0),
          name: String(item.name ?? item.homework_name ?? '未命名任务'),
          shixunIdentifier: item.shixun_identifier ? String(item.shixun_identifier) : undefined,
          myshixunIdentifier: item.myshixun_identifier ? String(item.myshixun_identifier) : undefined,
          status: statuses.join('、'),
          challengeCount,
          finishedChallengeCount: finished || undefined,
          requiredChallengeCount: challengeCount,
          finishedRequiredChallengeCount: finished,
          requiredProgressKnown: challengeCount !== undefined,
          deadline: item.end_time ? String(item.end_time) : undefined,
          canEnter: item.is_enter_shixun === false ? false : true,
          expired,
          canSubmit: item.can_submit === undefined ? undefined : Boolean(item.can_submit),
          timeStatus: Number(item.time_status ?? 0) || undefined,
        };
      }).filter(homework => homework.id > 0);
    },

    async exercises(cookie, login, courseIdentifier) {
      const s = session(cookie);
      // 学生端的考试列表在 v2 路径下；返回 { status, total_count, exercises: [] }
      const payload = await client.request(
        `/v2/courses/${encodeURIComponent(courseIdentifier)}/exercises.json?limit=100&zzud=`,
        { session: s },
      ).catch(() => null);
      const rows = payload?.exercises ?? payload?.items ?? [];
      return rows.map(item => ({
        id: Number(item.exercise_id ?? item.id ?? 0),
        name: String(item.name ?? item.exercise_name ?? '未命名考试'),
        status: String(item.status ?? item.status_text ?? ''),
        submitted: Boolean(item.submitted ?? item.commit_status === 2),
        scoreKnown: Boolean(item.score_known ?? item.scoreKnown),
        score: item.score ?? undefined,
        maxScore: item.max_score ?? item.maxScore ?? undefined,
        totalQuestions: Number(item.total_questions ?? item.question_count ?? item.questions_count ?? 0) || undefined,
        deadline: item.end_time ? String(item.end_time) : undefined,
        available: item.available === undefined ? Number(item.time_status ?? 0) < 5 : item.available === true,
        actionRequired: item.action_required === undefined ? undefined : Boolean(item.action_required),
        reasonCode: item.reason_code ? String(item.reason_code) : (Number(item.time_status ?? 0) >= 5 ? 'deadline_passed' : undefined),
      })).filter(exercise => exercise.id > 0);
    },

    async enter(cookie, login, courseIdentifier, homeworkId) {
      const s = session(cookie);
      const homeworks = await this.homeworks(cookie, login, courseIdentifier);
      const homework = homeworks.find(item => item.id === Number(homeworkId));
      if (!homework?.shixunIdentifier) throw errors.invalid('该作业没有关联实训。');
      const payload = await client.request(
        `/shixuns/${encodeURIComponent(homework.shixunIdentifier)}/shixun_exec.json?homework_common_id=${homeworkId}&zzud=`,
        { session: s },
      );
      // 平台只给当前（上次访问的）关卡，没有「第 N 关」接口，只能 prev/next 走
      const gameIdentifier = String(payload.game_identifier ?? payload.entry_game_id ?? payload.game_id ?? '');
      return {
        courseIdentifier,
        kind: 'code',
        homeworkId: Number(homeworkId),
        gameCount: homework.challengeCount,
        gameIdentifier,
        challenge: { id: 0, subject: homework.name, position: undefined, path: undefined },
        game: { id: 0, status: 0 },
        myshixunIdentifier: homework.myshixunIdentifier,
        prevGame: null,
        nextGame: null,
        requiredStatus: homework.status,
      };
    },

    async task(cookie, _login, gameIdentifier, homeworkId) {
      const s = session(cookie);
      const query = homeworkId ? `?homework_common_id=${homeworkId}&zzud=` : '?zzud=';
      const payload = await client.request(`/tasks/${encodeURIComponent(gameIdentifier)}.json${query}`, { session: s });
      const challenge = payload.challenge ?? {};
      const game = payload.game ?? {};
      if (!challenge.id && !game.id) {
        throw errors.upstream(`关卡 ${gameIdentifier} 读取失败：返回里没有 challenge/game 字段`, 'UPSTREAM_TASK_EMPTY');
      }
      // challenge.path 可能是多个文件，用全角分号分隔
      const paths = String(challenge.path ?? '').split('；').filter(Boolean);
      const files = [];
      for (const path of paths) {
        const raw = await client.request(
          `/tasks/${encodeURIComponent(gameIdentifier)}/rep_content.json?path=${encodeURIComponent(path)}&homework_common_id=${homeworkId ?? ''}&exercise_id=&zzud=`,
          { session: s },
        ).catch(() => null);
        // 形状：{ content: { content: "<base64>", size }, language, file_type, filename }
        const encoded = raw?.content?.content ?? raw?.content ?? raw?.file_content ?? '';
        const { content, encoding } = decodeFileContent(encoded);
        files.push({ path, content, encoding, language: raw?.language ? String(raw.language) : undefined });
      }
      // 只有真的读到文件路径才算代码题；with_code_file 对客观题也会是 true，不能单看它
      const isCode = paths.length > 0;
      // 没有代码文件也没有选项 = 命令行操作题（在右侧终端里敲命令，平台检查终端状态），
      // 这类没法「提交文件」，必须人工做
      const options = Array.isArray(challenge.options) ? challenge.options : [];
      // 没有可写文件、也不像终端题：按客观题（选择题）处理，走 choose_build
      const kind = isCode ? 'code' : 'choice';
      return {
        challenge: {
          id: Number(challenge.id ?? game.challenge_id ?? 0),
          name: String(challenge.subject ?? ''),
          kind,
          subject: String(challenge.subject ?? ''),
          description: String(challenge.task_pass ?? challenge.description ?? ''),
          position: Number(challenge.homework_challenge_index ?? challenge.position ?? 0) || undefined,
          path: paths[0],
          score: challenge.score,
          secKey: challenge.sec_key ?? '',
          options: Array.isArray(challenge.options) ? challenge.options : undefined,
          withCodeFile: challenge.with_code_file === true,
          shixunEnvironmentId: Number(
            payload.code_editor?.shixun_environment_id
            ?? payload.shixun_environments?.[0]?.shixun_environment_id
            ?? 0,
          ) || undefined,
        },
        game: {
          id: Number(game.id ?? 0),
          identifier: String(game.identifier ?? gameIdentifier),
          status: Number(game.status ?? 0),
          final_score: game.final_score ?? null,
          accuracy: game.accuracy ?? null,
          evaluate_count: Number(game.evaluate_count ?? 0),
        },
        myshixun: {
          identifier: String(payload.myshixun?.identifier ?? ''),
          id: Number(payload.myshixun?.id ?? game.myshixun_id ?? 0) || undefined,
          commitId: payload.myshixun?.commit_id ?? null,
        },
        files,
        gameCount: Number(payload.game_count ?? 0) || undefined,
        nextGame: payload.next_game ? String(payload.next_game) : null,
        prevGame: payload.prev_game ? String(payload.prev_game) : null,
        // 客观题：payload.chooses 里是每道题的题干与选项
        questions: Array.isArray(payload.chooses) ? payload.chooses.map(item => ({
          position: Number(item.position ?? 0),
          subject: String(item.subject ?? ''),
          type: Number(item.question_type ?? 0),
          options: (item.challenge_question ?? []).map(option => ({
            key: String.fromCharCode(65 + Number(option.position ?? 0)),
            text: String(option.option_name ?? ''),
          })),
        })) : undefined,
        // 客观题：平台会记录用户上一次提交的选项（actual_output 就是当初选的那个字母）
        chooseTestCases: payload.choose_test_cases ?? undefined,
        testSets: Array.isArray(payload.test_sets) ? payload.test_sets : null,
        compileOutput: payload.last_compile_output ? String(payload.last_compile_output) : '',
      };
    },

    // 保存代码：URL 里的 id 是 myshixun 标识（不是 game），body 里 game_id 是游戏数字 id
    // 实测：读的时候平台回 base64，写的时候要吃明文，所以这里默认 plain
    async saveFile(cookie, _login, { myshixunIdentifier, myshixunId, gameId, path, content, encoding = 'plain', homeworkId, challengeId, userId, commitId }) {
      const s = session(cookie);
      const target = myshixunIdentifier || myshixunId;
      if (!target) throw errors.invalid('缺少 myshixun 标识，无法保存代码。');
      const payload = await client.request(`/myshixuns/${encodeURIComponent(target)}/update_file.json?zzud=`, {
        method: 'POST',
        session: s,
        body: {
          path,
          evaluate: 0,
          content: encodeFileContent(content, encoding),
          game_id: Number(gameId),
          tab_type: 1,
          homework_common_id: homeworkId ?? null,
          extras: {
            challenge_id: Number(challengeId ?? 0) || null,
            homework_common_id: homeworkId ?? null,
            currentUserId: userId ?? null,
            commitID: commitId ?? null,
            exercise_id: '', question_id: '', subject_id: '', competition_entry_id: '',
          },
        },
      });
      return { commitID: payload?.content?.commitID ?? payload?.commitID ?? null, payload };
    },

    // 触发评测：URL 用关卡标识（字符串），body 带环境 id 与 commit
    async build(cookie, _login, { gameUid, homeworkId, challengeId, shixunEnvironmentId, commitId, first = 0 }) {
      const s = session(cookie);
      let payload;
      try {
        payload = await client.request(`/tasks/${encodeURIComponent(gameUid)}/game_build.json?zzud=`, {
          method: 'POST',
          session: s,
          body: {
            sec_key: '',
            resubmit: '',
            first,
            content_modified: 0,
            shixun_environment_id: shixunEnvironmentId ?? null,
            tab_type: 1,
            extras: { challenge_id: Number(challengeId ?? 0) || null, homework_common_id: homeworkId ?? null, commitID: commitId ?? null },
          },
        });
      } catch (error) {
        // 平台说「评测任务运行中」——上一次还在跑，去轮询结果就好，不算失败
        if (error?.code === 'UPSTREAM_EVAL_RUNNING') {
          return { status: 'running', evaluate_count: null, alreadyRunning: true };
        }
        throw error;
      }
      return { status: payload?.status ?? 0, evaluate_count: payload?.evaluate_count ?? null };
    },

    async choose(cookie, _login, { gameUid, answer, challengeId, subjectId, homeworkId }) {
      const s = session(cookie);
      const payload = await client.request(`/tasks/${encodeURIComponent(gameUid)}/choose_build.json?zzud=`, {
        method: 'POST',
        session: s,
        body: {
          answer,
          challenge_id: Number(challengeId ?? 0) || null,
          subject_id: subjectId ?? null,
          question_id: null,
          competition_entry_id: null,
          smart_plan_page_item_bank_id: null,
          homework_common_id: String(homeworkId ?? ''),
        },
      });
      return { status: payload?.status ?? 0, standard_answer: payload?.standard_answer ?? null };
    },

    async verdict(cookie, _login, gameIdentifier, homeworkId) {
      const task = await this.task(cookie, null, gameIdentifier, homeworkId);
      const finished = task.game.status === 2;
      const testsResolved = Array.isArray(task.testSets) && task.testSets.every(item => item && item.result !== null);
      return {
        finished,
        running: !testsResolved && task.game.evaluate_count > 0,
        status: task.game.status,
        final_score: task.game.final_score,
        accuracy: task.game.accuracy,
        evaluate_count: task.game.evaluate_count,
        compile_output: task.compileOutput,
        testSets: task.testSets,
      };
    },

    async submitExercise(cookie, _login, { courseIdentifier, exerciseId }) {
      const s = session(cookie);
      const payload = await client.request(
        `/courses/${encodeURIComponent(courseIdentifier)}/exercises/${encodeURIComponent(exerciseId)}/submit.json?zzud=`,
        { method: 'POST', session: s, body: {} },
      );
      return { submitted: Boolean(payload?.submitted ?? true), totalQuestions: payload?.total_questions };
    },
  };
}
