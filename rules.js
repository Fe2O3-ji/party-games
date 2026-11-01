'use strict';

/**
 * 描述判定规则
 * - 禁止带词:描述里不能出现完整的目标词(忽略空格、标点、大小写)
 * - 限制卡:每条规则都有可执行的 check
 */

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function charCount(text) {
  return Array.from(normalize(text)).length;
}

function stripQuote(text) {
  return String(text || '').trim().replace(/^[「“"']\s*/, '');
}

const COLORS = [
  '红', '橙', '黄', '绿', '青', '蓝', '紫', '黑', '白', '灰', '粉',
  '棕', '褐', '金', '银', '彩', '米色', '咖啡色',
];

const ANIMALS = [
  '猫', '狗', '鸟', '鱼', '鸡', '鸭', '鹅', '猪', '牛', '羊', '马', '驴',
  '骡', '猴', '兔', '鼠', '虎', '狮', '象', '熊', '狼', '狐', '鹿', '蛇',
  '龟', '蛙', '蚁', '蜂', '蝶', '蛾', '虫', '龙', '凤', '鹰', '燕', '鸽',
  '鸦', '雀', '企鹅', '熊猫', '袋鼠', '海豚', '鲸', '鲨', '蜘蛛', '螃蟹',
  '虾', '蜗牛', '蝌蚪',
];

const NUMBER_RE = /[0-9０-９一二三四五六七八九十百千万两零壹贰叁肆伍陆柒捌玖拾]/;

const RESTRICTIONS = [
  {
    id: 'short5',
    text: '只能用 5 个字描述',
    check: (t) => charCount(t) <= 5,
  },
  {
    id: 'simile',
    text: '必须用比喻,句子里要有「像……一样」',
    check: (t) => t.includes('像') && t.includes('一样'),
  },
  {
    id: 'is',
    text: '描述里必须包含「是」字',
    check: (t) => t.includes('是'),
  },
  {
    id: 'question',
    text: '用一句问句来描述',
    check: (t) => /[?？]\s*$/.test(String(t).trim()),
  },
  {
    id: 'color',
    text: '描述里必须出现一种颜色',
    check: (t) => COLORS.some((c) => t.includes(c)),
  },
  {
    id: 'animal',
    text: '描述里必须提到一种动物',
    check: (t) => ANIMALS.some((a) => t.includes(a)),
  },
  {
    id: 'notstart',
    text: '用否定句开头:「它不是……」',
    check: (t) => stripQuote(t).startsWith('它不是'),
  },
  {
    id: 'number',
    text: '描述里必须包含一个数字',
    check: (t) => NUMBER_RE.test(t),
  },
  {
    id: 'mom',
    text: '描述必须以「我妈说」开头',
    check: (t) => stripQuote(t).startsWith('我妈说'),
  },
  {
    id: 'node',
    text: '描述里不能出现「的」字',
    check: (t) => !t.includes('的'),
  },
];

function findRestriction(id) {
  return RESTRICTIONS.find((r) => r.id === id) || null;
}

function restrictionText(id) {
  const rule = findRestriction(id);
  return rule ? rule.text : null;
}

// 描述是否包含完整的目标词(忽略空格、标点、大小写)
function containsTarget(description, target) {
  const d = normalize(description);
  const t = normalize(target);
  if (!d || !t) return false;
  return d.includes(t);
}

function checkRule(rule, text) {
  return !!rule && rule.check(String(text || ''));
}

module.exports = {
  RESTRICTIONS,
  findRestriction,
  restrictionText,
  containsTarget,
  checkRule,
  normalize,
  charCount,
};
