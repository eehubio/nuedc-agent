/** 编译任务输入护栏（API 提交与 runner 双端校验，防路径逃逸/巨型文件/文件轰炸）。
 *  返回 null = 合法；返回字符串 = 拒绝原因。 */
export const BUILD_LIMITS = {
  MAX_FILES: 40,
  MAX_FILE_BYTES: 200 * 1024,      // 单文件 200KB
  MAX_TOTAL_BYTES: 1024 * 1024,    // 工程总量 1MB
  PATH_PATTERN: /^[A-Za-z0-9_\-][A-Za-z0-9_\-./]{0,120}$/,  // 相对路径白名单
  EXT_PATTERN: /\.(c|h|cpp|hpp|s|ld|txt|mk)$/i,
};

export function validateBuildFiles(files: { path: string; content: string }[]): string | null {
  if (!Array.isArray(files) || !files.length) return "文件列表为空";
  if (files.length > BUILD_LIMITS.MAX_FILES) return `文件数超限（${files.length} > ${BUILD_LIMITS.MAX_FILES}）`;
  let total = 0;
  for (const f of files) {
    if (typeof f.path !== "string" || typeof f.content !== "string") return "文件项必须是 {path, content}";
    if (!BUILD_LIMITS.PATH_PATTERN.test(f.path) || f.path.includes("..") || f.path.startsWith("/")) {
      return `非法路径：${f.path}`;
    }
    if (!BUILD_LIMITS.EXT_PATTERN.test(f.path)) return `不允许的文件类型：${f.path}`;
    const bytes = Buffer.byteLength(f.content, "utf8");
    if (bytes > BUILD_LIMITS.MAX_FILE_BYTES) return `文件过大：${f.path}（${bytes}B > ${BUILD_LIMITS.MAX_FILE_BYTES}B）`;
    total += bytes;
  }
  if (total > BUILD_LIMITS.MAX_TOTAL_BYTES) return `工程总量超限（${total}B > ${BUILD_LIMITS.MAX_TOTAL_BYTES}B）`;
  return null;
}
