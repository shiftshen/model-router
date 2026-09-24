// 上下文窗口不该是一个写死的数字。
// 这里做三件事：
//   1) 按模型名匹配一张真实窗口表；
//   2) 查不到时用 512K 兜底（旧版用的是 128K，把很多本来很宽的模型压窄了一半）；
//   3) 能被真实来源纠正——用户在界面上填的值优先，其次是从供应商报错里读到的真实上限。

// 查不到就用它。512K 是折中：比旧默认 128K 宽得多，又不会让 32K/128K 的模型误以为很宽敞。
export const defaultContextWindow = 512000;

// 旧版本对每个模型都写 128000。这个值既不是用户填的、也不一定对，
// 所以只要表里有更可靠的值，就把它当成占位符替换掉。
const legacyPlaceholderWindow = 128000;

// 越具体的写在前面，先命中先用。
// verified = 在本机官方会话记录里实测过（Codex 自己报的 model_context_window ÷ 0.95）。
// 其余是各家公开的窗口，本机没有逐条实测，只在新条目没填值时使用。
const knownWindows = [
  { match: /gpt-6-astra/i, window: 272000, verified: true },
  { match: /gpt-5\.6/i, window: 272000, verified: true },
  { match: /gpt-5\.5/i, window: 272000, verified: true },
  { match: /gpt-5\.4/i, window: 272000, verified: false },
  // 小米官方模型页和接入示例均写明 MiMo V2.6 的 1M 窗口（1048576）。
  { match: /mimo-v2\.6-(flash|pro|pro-ultraspeed)/i, window: 1048576, verified: false },
  // DeepSeek 自家的 V4 系列标称 1M；更早的 chat/reasoner 是 128K。
  { match: /deepseek-v4|deepseek-flash/i, window: 1000000, verified: false },
  { match: /deepseek-(chat|reasoner|coder|v3)/i, window: 131072, verified: false },
  { match: /qwen3|qwen2\.5|qwen-plus|qwen-max|qwen3\.8/i, window: 131072, verified: false },
  { match: /claude/i, window: 200000, verified: false },
  { match: /gemini/i, window: 1048576, verified: false },
  { match: /kimi|moonshot/i, window: 262144, verified: false },
  { match: /glm/i, window: 131072, verified: false },
  { match: /grok/i, window: 131072, verified: false },
  { match: /mistral|mixtral/i, window: 131072, verified: false },
  { match: /llama/i, window: 131072, verified: false },
  { match: /gpt-oss/i, window: 131072, verified: false },
  { match: /nemotron/i, window: 131072, verified: false },
];

export function knownContextWindow(model) {
  const name = String(model ?? "").trim();
  if (!name) return null;
  for (const entry of knownWindows) {
    if (entry.match.test(name)) return { window: entry.window, verified: entry.verified };
  }
  return null;
}

export function usableWindow(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 4096 && number <= 2000000 ? number : 0;
}

// 一个条目实际该用多大的窗口。
// 优先级：用户自己填的 > 表里实测过的 > 表里的公开值（仅当用户没填） > 512K 兜底。
// 只有「128K 那个旧占位符」会被表里的值顶掉——用户真的手填 128K 的条目保持原样，
// 因为 128K 对不少模型确实是对的。
export function resolveContextWindow(route) {
  const explicit = usableWindow(route?.contextWindow);
  const known = knownContextWindow(route?.model);
  if (explicit && route?.contextWindowAuto === false) return explicit;
  // 用户自己填的非占位值优先——128K 对不少模型确实是正确答案。
  if (explicit && explicit !== legacyPlaceholderWindow) return explicit;
  // 没有用户明确设置时，才使用本机实测值。
  if (known?.verified) return known.window;
  // 占位符或者根本没填：表里有据可查就用表，否则用兜底值。
  if (known?.window) return known.window;
  return explicit || defaultContextWindow;
}

// 供应商的报错里经常带着真实上限（"...maximum context length is 131072 tokens"）。
// 与其猜，不如把这个数字记下来给下一条请求用。
export function contextWindowFromMessage(text) {
  const message = String(text ?? "");
  const patterns = [
    /maximum context length is\s*([0-9][0-9,._]*)/i,
    /context length of\s*([0-9][0-9,._]*)/i,
    /max(?:imum)?[ _-]?(?:context|input)?[ _-]?tokens?[^0-9]{0,24}([0-9][0-9,._]*)/i,
    /context[ _-]?window[^0-9]{0,24}([0-9][0-9,._]*)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match) continue;
    const value = usableWindow(String(match[1]).replace(/[,._]/g, ""));
    if (value) return value;
  }
  return 0;
}
