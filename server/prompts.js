/**
 * ═══════════════════════════════════════════════════════════
 * 内嵌 AI 提示词（集中管理，便于评审与迭代）
 * ───────────────────────────────────────────────────────────
 * 1) summarizeSystem()  多关键词关系综述
 * 2) cardsUser()        笔记 → 知识卡片
 * 3) explainUser()      答错后的解释
 * 4) quizUser()         由卡片生成单选题（可选功能）
 *
 * 注：综述提示词在原始需求基础上追加了「输出长度」约束（第 8 条）。
 *     glm-4-flash 非流式耗时 ≈ 生成 token 数 × ~15ms，不加约束会明显
 *     超过「5 秒内返回」的验收线。
 * ═══════════════════════════════════════════════════════════
 */
'use strict';

const SUMMARY_JSON_SHAPE = `{
"title": "字符串",
"summary": "字符串",
"key_relations": [
{ "from": "字符串", "to": "字符串", "relation": "字符串", "explanation": "字符串" }
],
"example": "字符串",
"misconceptions": ["字符串"],
"mermaid": "字符串",
"citations": ["字符串"]
}`;

function summarizeSystem(p) {
  const keywords = (p.keywords || []).join('、');
  const relations = (p.relations && p.relations.length)
    ? p.relations.map(r => r.from + ' → ' + r.to + '：' + r.relation + (r.evidence ? '（' + r.evidence + '）' : '')).join('\n')
    : '（图谱中没有记录这些概念之间的直接关系）';

  return [
    '你是一名航空航天助教。学生选择了以下关键词：',
    keywords,
    '知识图谱中已有的两两关系：',
    relations,
    '教材相关片段：',
    p.context || '（无）',
    '请基于以上材料，生成一段让初学者能看懂的关系综述。要求：',
    '1. 不要编造教材中没有的内容；材料不足时写“教材中未明确说明”。',
    '2. 先解释这些概念的共同主题。',
    '3. 再说明它们之间的层级、因果、并列或推导关系。',
    '4. 用一个生活化例子把所有概念串起来。',
    '5. 指出初学者最容易混淆的 1-3 个点。',
    '6. 生成一段 Mermaid 关系图代码，只使用 graph TD 语法，节点用中文概念名。',
    '7. 引用来源写“教材第X页/第X段”，不要大段复制原文。',
    '8. 输出要克制（直接影响响应速度，请严格遵守）：summary 不少于 120 字、不超过 220 字；example 不超过 45 字；'
      + 'misconceptions 最多 2 条、每条不超过 22 字；key_relations 最多 4 条、explanation 不超过 25 字；'
      + 'citations 最多 3 条；mermaid 只放图代码本身（必须以 graph TD 开头、不超过 10 行、不要 ``` 围栏），'
      + '节点总数不超过选中关键词数加 2。',
    '9. 严格输出合法 JSON：双引号、无尾逗号、无注释、无 markdown 代码块。',
    '只输出 JSON，不要输出其他文字：',
    SUMMARY_JSON_SHAPE
  ].join('\n');
}

function cardsUser(noteContent) {
  return [
    '你是一名学习助手。请把下面的笔记拆成 3-8 张知识卡片，用于间隔重复复习。',
    '笔记内容：',
    noteContent,
    '要求：',
    '1. 每张卡片只考一个知识点。',
    '2. 正面是具体、可回答的问题，不要问“请简述……”这种太宽泛的问题。',
    '3. 背面是简洁答案，控制在 80 字以内。',
    '4. 必须基于笔记内容，不要扩展笔记之外的知识。',
    '5. 如果内容不足以生成 3 张卡，就生成 1-2 张，不要硬凑。',
    '6. 给每张卡片 1-3 个标签。',
    '只输出 JSON 数组，不要输出其他文字：',
    '[',
    '{',
    '"front": "问题",',
    '"back": "答案",',
    '"tags": ["标签1", "标签2"]',
    '}',
    ']'
  ].join('\n');
}

const CARDS_SYSTEM = '你是一名严谨的学习助手，只依据用户提供的笔记内容生成复习卡片，'
  + '不补充笔记之外的知识；严格输出 JSON 数组，不要 markdown 代码块，不要任何解释文字。';

function explainUser(p) {
  return [
    '你是一名航空航天助教。学生复习时答错了，请用初学者能懂的话解释。',
    '卡片正面：',
    p.front || '',
    '正确答案：',
    p.back || '',
    '学生答案：',
    p.userAnswer || '（学生没有填写答案，直接看了答案）',
    '请输出：',
    '1. 学生可能哪里理解错了。',
    '2. 正确概念是什么。',
    '3. 一个记忆提示或类比。',
    '4. 如果涉及公式，写出公式并解释每个符号。',
    '控制在 200 字以内，只输出纯文本。'
  ].join('\n');
}

const EXPLAIN_SYSTEM = '你是一名航空航天助教，用初学者能听懂的口语化中文解释，'
  + '只输出纯文本（不要 JSON、不要 markdown 代码块），控制在 200 字以内。';

function quizUser(front, back) {
  return [
    '请根据下面这张复习卡片，编一道单选题（只能有一个正确选项）。',
    '卡片问题：' + (front || ''),
    '卡片答案：' + (back || ''),
    '要求：',
    '1. 题干要能独立看懂，不要出现“本文”“上文”这类指代。',
    '2. 四个选项，只有一个正确；三个干扰项要似是而非，但不能也是对的。',
    '3. 正确答案的位置随机，不要总放在第一个。',
    '4. 给出不超过 60 字的解析，说明为什么选它。',
    '只输出 JSON，不要输出其他文字：',
    '{"stem":"题干","options":["A","B","C","D"],"answer_index":0,"explanation":"解析"}'
  ].join('\n');
}

const QUIZ_SYSTEM = '你是出题老师，严格依据给定的卡片内容出单选题，'
  + '只输出 JSON 对象（不要 markdown 代码块、不要多余文字）。';

module.exports = {
  SUMMARY_JSON_SHAPE,
  summarizeSystem, CARDS_SYSTEM, cardsUser,
  EXPLAIN_SYSTEM, explainUser,
  QUIZ_SYSTEM, quizUser
};
