import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

export function treeGolden(TreeSelector: any) {
 const timestamp = "2026-01-02T03:04:05.000Z";
 const tool = { entry: { id: "tool", parentId: "answer", type: "message", timestamp, message: { role: "toolResult", toolName: "bash", toolCallId: "call", content: [{ type: "text", text: "done" }], isError: false } }, children: [] };
 const answer = { entry: { id: "answer", parentId: "user", type: "message", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Alpha answer 中文" }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "echo a\n\tb" } }], stopReason: "toolUse" } }, children: [tool] };
 const second = { entry: { id: "other", parentId: "user", type: "message", timestamp, message: { role: "user", content: [{ type: "text", text: "Beta branch" }] } }, label: "branch label", children: [] };
 const tree = [{ entry: { id: "user", parentId: null, type: "message", timestamp, message: { role: "user", content: "Alpha root" } }, children: [answer, second] }, { entry: { id: "custom", parentId: null, type: "custom_message", timestamp, customType: "note", content: [{ type: "text", text: "custom\ncontent" }], display: true }, children: [] }];
 const values = [];
 for (const filter of ["default", "no-tools", "user-only", "labeled-only", "all"]) {
  const component = new TreeSelector(tree, "tool", 24, () => {}, () => {}, undefined, "answer", filter);
  const list = component.getTreeList();
  const hash = createHash("sha256");
  for (const query of ["", "alpha", "alpha answer", "missing", "  ", "beta", ""]) {
   list.searchQuery = query; list.applyFilter();
   for (const width of [8, 40, 100]) hash.update(JSON.stringify(component.render(width).map(stripVTControlCharacters)));
   hash.update(JSON.stringify(list.filteredNodes.map((n: any) => [n.node.entry.id, n.indent, n.isLast, n.gutters])));
  }
  values.push({ filter, hash: hash.digest("hex") });
 }
 return values;
}
