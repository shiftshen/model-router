// Transport-only conversion: never rewrite the user's stored conversation.
export function portableHistory(payload) {
  const result = structuredClone(payload);
  delete result.previous_response_id;
  if (Array.isArray(result.input)) result.input = result.input.flatMap(item => {
    // Reasoning blobs and item references belong to the originating backend.
    if (item.type === "reasoning") return [];
    if (item.type === "item_reference" || item.type === "compaction") {
      const error = new Error("这段历史只有供应商内部引用，无法安全跨模型恢复。请在原模型完成压缩后，以明确的文字交接摘要新建会话。");
      error.status = 400;
      throw error;
    }
    const copy = { ...item };
    delete copy.id;
    delete copy.encrypted_content;
    return [copy]; // Keep call_id, tools, tool outputs, images, roles and text intact.
  });
  return result;
}
