export function syncMcpToolSurfaces(text: string, toolCount: string): string {
  const contexts = [
    /(<img\b[^>\n]*\bsrc="(?:\.\.\/)?assets\/tags\/stat-tools\.svg"[^>\n]*\balt=")\d+( MCP tools")/g,
    /(the default \(`AGENTMEMORY_TOOLS=all`\) exposes all )\d+(\.)/gi,
    /(<summary>Extended tools \()\d+( total, the default surface\)<\/summary>)/g,
    /(^# Show \d+ essential MCP tools instead of the default )\d+(\r?$)/gm,
  ];
  return contexts.reduce(
    (out, pattern) => out.replace(pattern, (_match, before: string, after = "") => `${before}${toolCount}${after}`),
    text,
  );
}
