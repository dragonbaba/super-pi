export type TimeoutWrapperResult =
  | { supported: true; commandIndex: number; seconds: number }
  | { supported: false; reason: string };

const INTEGER_SECONDS = /^[1-9][0-9]{0,8}$/u;
const MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;

/**
 * Recognize the small GNU timeout subset we can audit without executing or
 * probing the named program. The caller still inspects the returned command.
 */
export function parseTimeoutInvocation(
  tokens: readonly string[],
  start: number,
): TimeoutWrapperResult {
  if (start >= tokens.length || tokens[start]!.toLowerCase().endsWith("timeout.exe")) {
    return { supported: false, reason: "系统 timeout.exe 与 GNU timeout 语法不同" };
  }

  let index = start + 1;
  while (index < tokens.length && tokens[index]!.startsWith("-")) {
    const option = tokens[index]!;
    if (option === "--") {
      index++;
      break;
    }
    return { supported: false, reason: "timeout 选项暂未实现：" + option.slice(0, 48) };
  }

  const duration = tokens[index];
  if (!duration) return { supported: false, reason: "timeout 缺少时长操作数" };
  if (!INTEGER_SECONDS.test(duration)) return { supported: false, reason: "timeout 只接受正整数秒字面量" };
  const seconds = Number(duration);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_TIMEOUT_SECONDS) {
    return { supported: false, reason: "timeout 时长超出有界检查范围" };
  }

  const commandIndex = index + 1;
  const command = tokens[commandIndex];
  if (!command) return { supported: false, reason: "timeout 缺少内部可执行程序" };
  if (command.startsWith("-")) return { supported: false, reason: "timeout 内部程序不能从选项开始" };
  for (const character of command) {
    if ("$*?[]{}%".includes(character) || character.charCodeAt(0) === 96) {
      return { supported: false, reason: "timeout 内部程序名不能是动态表达式" };
    }
  }
  return { supported: true, commandIndex, seconds };
}
