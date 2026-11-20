// 自动完成 Jupyter 图文作业：逐个空 cell 让模型补全 → 写回 → 提交
import { openJupyter, startKernel, executeCode } from './client.mjs';
import { solveWithModel } from '../engine/solver/index.mjs';

const MARK = /^#\s*===\s*CELL\s+(\d+)\s*===\s*$/;

function cellText(cell) {
  return Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
}

function parseCellsText(text) {
  const result = new Map();
  const lines = String(text ?? '').split('\n');
  let current = null;
  let buffer = [];
  const flush = () => { if (current !== null) result.set(current, buffer.join('\n').replace(/\n+$/, '')); };
  for (const line of lines) {
    const matched = line.match(MARK);
    if (matched) { flush(); current = Number(matched[1]); buffer = []; continue; }
    if (current !== null) buffer.push(line);
  }
  flush();
  return result;
}

function needsWork(source) {
  const text = String(source ?? '').trim();
  if (text === '') return true;
  if (/^pass$/.test(text)) return true;
  if (/TODO|待补充|请在此|your code here/i.test(text)) return true;
  return false;
}

export async function solveJupyter({ session, gameUid, homeworkId, ctx, submit = true, maxCells = 3, run = false }) {
  const client = await openJupyter({ session, gameUid, homeworkId });
  ctx?.phase?.('loading');

  const items = await client.list();
  const notebookName = items.find(item => item.type === 'notebook' || item.name.endsWith('.ipynb'))?.path;
  if (!notebookName) throw Object.assign(new Error('容器里没有找到 .ipynb 文件'), { code: 'JUPYTER_NO_NOTEBOOK' });

  const notebook = await client.readNotebook(notebookName);
  const cells = notebook?.cells ?? [];
  if (!cells.length) throw Object.assign(new Error('notebook 是空的'), { code: 'JUPYTER_EMPTY' });

  const pending = cells
    .map((cell, index) => ({ cell, index }))
    .filter(item => item.cell.cell_type === 'code' && needsWork(cellText(item.cell)))
    .slice(0, maxCells);

  let filled = 0;
  for (const [order, item] of pending.entries()) {
    ctx?.phase?.('generating');
    // 只给这个 cell 前面最近的说明文字，避免 prompt 太大导致超时
    const before = cells
      .slice(Math.max(0, item.index - 3), item.index)
      .filter(cell => cell.cell_type === 'markdown')
      .map(cell => cellText(cell))
      .join('\n')
      .slice(-900);

    const task = {
      kind: 'code',
      subject: `Jupyter 实验：${notebookName.replace(/\.ipynb$/, '')}（第 ${item.index} 个代码单元格）`,
      description: [
        '这是一个 Jupyter Notebook 实验，需要补全下面这个代码单元格，让它能直接运行并产出实验结果。',
        before ? `该单元格前面的说明：\n${before}` : '',
        '要求：只输出代码本身；保留 `# === CELL 编号 ===` 标记行，代码写在标记下面。',
      ].filter(Boolean).join('\n\n'),
      files: [{ path: 'cell.py', content: `# === CELL ${item.index} ===\n${cellText(item.cell)}` }],
    };

    try {
      const solved = await solveWithModel(task);
      const parsed = parseCellsText(solved.answer?.files?.[0]?.content ?? '');
      const source = parsed.get(item.index);
      if (!source || !source.trim()) continue;
      if (source.trim() === cellText(item.cell).trim()) continue;
      cells[item.index].source = source.split('\n').map((line, i, arr) => (i === arr.length - 1 ? line : `${line}\n`));
      filled += 1;
    } catch (error) {
      ctx?.phase?.('repairing');
      if (order === pending.length - 1 && filled === 0) throw error;
    }
  }

  // 可选：把补过的 cell 真跑一遍，把输出写进 notebook（判分若看执行结果就有用）
  const executed = [];
  if (run) {
    ctx?.phase?.('evaluating');
    try {
      const kernel = await startKernel(client.target);
      const runTargets = pending.length ? pending : cells.map((cell, index) => ({ cell, index })).filter(item => item.cell.cell_type === 'code').slice(-1);
      for (const item of runTargets) {
        const source = Array.isArray(cells[item.index].source) ? cells[item.index].source.join('') : String(cells[item.index].source ?? '');
        if (!source.trim()) continue;
        const result = await executeCode(client.target, kernel.id, source, { timeoutMs: 180_000 });
        cells[item.index].outputs = [{
          output_type: 'stream',
          name: 'stdout',
          text: [result.output],
        }];
        cells[item.index].execution_count = 1;
        executed.push({ index: item.index, ok: result.ok, output: result.output.slice(0, 200) });
        if (!result.ok) ctx?.note?.(`cell ${item.index} 执行报错`);
      }
    } catch (error) {
      console.error('kernel 执行异常:', String(error.message).slice(0, 120));
    }
  }

  ctx?.phase?.('saving');
  await client.writeNotebook(notebookName, notebook);

  let submitResult = null;
  if (submit) {
    ctx?.phase?.('submitting');
    submitResult = await client.submit();
  }

  return { notebook: notebookName, cells: cells.length, pending: pending.length, filled, executed, submitted: Boolean(submitResult), submitResult };
}
