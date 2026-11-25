// Markdown for issue text that holds upstream's words (versions, command
// and option names): in code, so Markdown, HTML and @mentions in them do
// nothing.

/** Text inside an inline code span: the fence is one backtick longer than
 * any run inside, and padded with spaces so a backtick at either end can't
 * join it. */
export const inline = (text: string) => {
  const fence = "`".repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence} ${text.replace(/[\r\n]+/g, " ")} ${fence}`;
};

/** Text in a code block. */
export const shown = (text: string) => {
  if (!text) return "";
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}\n${text}\n${fence}`;
};

/** A version as plain text when it can't hold Markdown, else in code. */
export const plain = (text: string) => (/^[A-Za-z0-9.+-]+$/.test(text) ? text : inline(text));

/** A name in code as GitHub shows it best: a plain `x` when no backtick or
 * space at its ends needs the padded form. */
export const code = (text: string) => (/^[^`\r\n]+$/.test(text) && !/^\s|\s$/.test(text) ? `\`${text}\`` : inline(text));
