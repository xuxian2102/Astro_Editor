/** 大小写不敏感子串匹配，排除已选中的；query 为空时返回全部未选中候选 */
export function filterSuggestions(
  pool: string[],
  alreadySelected: string[],
  query: string,
): string[] {
  const selected = new Set(alreadySelected);
  const needle = query.trim().toLowerCase();
  return pool.filter((tag) => {
    if (selected.has(tag)) return false;
    return needle === "" || tag.toLowerCase().includes(needle);
  });
}
